import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Owns loading of the per-language CBM definition extractor modules built by
// scripts/build-cbm-extractors.mjs. One Emscripten instance per language is
// created lazily and reused; calls are synchronous inside the instance, so a
// single JS thread never interleaves two extractions on one module.

export interface CbmExtractorManifestModule {
    readonly cbmLanguage: string;
    readonly satoriLanguageId: string;
    readonly file: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly pack: 'core' | 'extended';
}

interface CbmExtractorManifest {
    readonly schemaVersion: number;
    readonly glue: { readonly file: string };
    readonly modules: readonly CbmExtractorManifestModule[];
}

interface ExtractorInstance {
    readonly HEAPU8: Uint8Array;
    _malloc(length: number): number;
    _free(pointer: number): void;
    _satori_extract(source: number, length: number, relativePath: number): number;
    _satori_result_ptr(): number;
    _satori_result_len(): number;
}

type CreateExtractor = (settings: { locateFile: (name: string) => string }) => Promise<ExtractorInstance>;

/** One CBM definition record (see third_party/cbm-extractor/satori_extractor.c). */
export interface CbmDefinitionRecord {
    readonly label: string;
    readonly name: string;
    readonly qualifiedName: string;
    readonly parentClass: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly startByte: number;
    readonly endByte: number;
}

export class CbmExtractorUnavailableError extends Error {}

const localRequire = createRequire(__filename);
const DEFAULT_ASSET_ROOT = path.resolve(__dirname, '../../assets/cbm-extractor');

class CbmExtractorHost {
    private manifest: CbmExtractorManifest | null | undefined;
    private readonly moduleByLanguage = new Map<string, CbmExtractorManifestModule>();
    private readonly instances = new Map<string, Promise<ExtractorInstance>>();

    // Core modules ship beside the manifest; the extended pack is downloaded by
    // `satori install` and handed to the runtime as SATORI_CBM_EXTENDED_DIR
    // (source checkouts keep it under <assetRoot>/extended).
    private readonly extendedRoot: string;

    constructor(private readonly assetRoot: string) {
        this.extendedRoot = process.env.SATORI_CBM_EXTENDED_DIR?.trim() || path.join(assetRoot, 'extended');
    }

    private loadManifest(): CbmExtractorManifest | null {
        if (this.manifest !== undefined) return this.manifest;
        const manifestPath = path.join(this.assetRoot, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            this.manifest = null;
            return null;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CbmExtractorManifest;
        if (manifest.schemaVersion !== 1) {
            throw new Error(`Unsupported CBM extractor manifest schema ${manifest.schemaVersion}`);
        }
        for (const entry of manifest.modules) {
            if (this.moduleByLanguage.has(entry.satoriLanguageId)) {
                throw new Error(`CBM extractor manifest maps ${entry.satoriLanguageId} to more than one module`);
            }
            this.moduleByLanguage.set(entry.satoriLanguageId, entry);
        }
        this.manifest = manifest;
        return manifest;
    }

    private modulePath(entry: CbmExtractorManifestModule): string {
        return path.join(entry.pack === 'core' ? this.assetRoot : this.extendedRoot, entry.file);
    }

    /** True when the manifest lists a module; a missing file surfaces at load as CbmExtractorUnavailableError. */
    supports(language: string): boolean {
        if (!this.loadManifest()) return false;
        return this.moduleByLanguage.has(language);
    }

    private instance(language: string): Promise<ExtractorInstance> {
        const cached = this.instances.get(language);
        if (cached) return cached;
        const manifest = this.loadManifest();
        const entry = this.moduleByLanguage.get(language);
        if (!manifest || !entry) {
            return Promise.reject(new CbmExtractorUnavailableError(`No CBM extractor module for ${language}`));
        }
        const wasmPath = this.modulePath(entry);
        if (!fs.existsSync(wasmPath)) {
            return Promise.reject(new CbmExtractorUnavailableError(`CBM extractor module missing: ${wasmPath}`));
        }
        const create = localRequire(path.join(this.assetRoot, manifest.glue.file)) as CreateExtractor;
        const loading = create({ locateFile: () => wasmPath });
        this.instances.set(language, loading);
        loading.catch(() => this.instances.delete(language));
        return loading;
    }

    async extract(language: string, relativePath: string, source: string): Promise<CbmDefinitionRecord[]> {
        const module = await this.instance(language);
        const sourceBytes = Buffer.from(source, 'utf8');
        const pathBytes = Buffer.from(`${relativePath}\0`, 'utf8');
        const sourcePointer = module._malloc(sourceBytes.length + 1);
        const pathPointer = module._malloc(pathBytes.length);
        try {
            module.HEAPU8.set(sourceBytes, sourcePointer);
            module.HEAPU8[sourcePointer + sourceBytes.length] = 0;
            module.HEAPU8.set(pathBytes, pathPointer);
            const count = module._satori_extract(sourcePointer, sourceBytes.length, pathPointer);
            if (count < 0) throw new Error(`CBM extractor failed for ${relativePath}`);
            const output = Buffer.from(module.HEAPU8.subarray(
                module._satori_result_ptr(),
                module._satori_result_ptr() + module._satori_result_len(),
            )).toString('utf8');
            const records = parseRecords(output);
            if (records.length !== count) {
                throw new Error(`CBM extractor returned ${records.length} records for ${count} definitions`);
            }
            return records;
        } finally {
            module._free(pathPointer);
            module._free(sourcePointer);
        }
    }
}

function parseRecords(output: string): CbmDefinitionRecord[] {
    const records: CbmDefinitionRecord[] = [];
    for (const line of output.split('\n')) {
        if (!line) continue;
        const fields = line.split('\t');
        if (fields.length !== 8) throw new Error(`Malformed CBM extractor record: ${JSON.stringify(line)}`);
        const [label, name, qualifiedName, parentClass, ...numbers] = fields;
        const [startLine, endLine, startByte, endByte] = numbers.map((value) => {
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed) || parsed < 0) {
                throw new Error(`Malformed CBM extractor number: ${JSON.stringify(line)}`);
            }
            return parsed;
        });
        records.push({ label, name, qualifiedName, parentClass, startLine, endLine, startByte, endByte });
    }
    return records;
}

const hosts = new Map<string, CbmExtractorHost>();

export function cbmExtractorHost(assetRoot: string = DEFAULT_ASSET_ROOT): CbmExtractorHost {
    let host = hosts.get(assetRoot);
    if (!host) {
        host = new CbmExtractorHost(assetRoot);
        hosts.set(assetRoot, host);
    }
    return host;
}
