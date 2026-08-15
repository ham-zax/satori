import path from 'node:path';
import { createRequire } from 'node:module';

const localRequire = createRequire(__filename);

export interface NativeSemanticEngine {
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
    HEAPF32: Float32Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _satori_semantic_abi_version(): number;
    _satori_semantic_engine_version(): number;
    _satori_semantic_global_last_error_message(): number;
    _satori_semantic_last_error_message(handle: number): number;
    _satori_semantic_last_error(handle: number): number;
    _satori_semantic_create(langPtr: number, langLen: number, outHandlePtr: number): number;
    _satori_semantic_add_source(handle: number, pathPtr: number, pathLen: number, srcPtr: number, srcLen: number): number;
    _satori_semantic_add_auxiliary(handle: number, rolePtr: number, roleLen: number, pathPtr: number, pathLen: number, srcPtr: number, srcLen: number): number;
    _satori_semantic_resolve(handle: number): Promise<number> | number;
    _satori_semantic_result_count(handle: number): number;
    _satori_semantic_results(handle: number): number;
    _satori_semantic_relationship_count(handle: number): number;
    _satori_semantic_relationships(handle: number): number;
    _satori_semantic_definition_count(handle: number): number;
    _satori_semantic_definitions(handle: number): number;
    _satori_semantic_diagnostic_count(handle: number): number;
    _satori_semantic_diagnostics(handle: number): number;
    _satori_semantic_string_table(handle: number, outLenPtr: number): number;
    _satori_semantic_destroy(handle: number): void;
    _satori_semantic_free(handle: number): void;
    _satori_semantic_go_smoke(): Promise<number> | number;
    UTF8ToString(ptr: number): string;
    getValue(ptr: number, type: string): number;
}

let enginePromise: Promise<NativeSemanticEngine> | undefined;

function resolveAssetPath(): string {
    const candidatePaths = [
        path.resolve(__dirname, '../../../assets/semantic-engine/satori-semantic-engine.js'),
        path.resolve(__dirname, '../../assets/semantic-engine/satori-semantic-engine.js'),
        path.resolve(__dirname, '../assets/semantic-engine/satori-semantic-engine.js'),
    ];
    for (const p of candidatePaths) {
        try {
            return localRequire.resolve(p);
        } catch {
            // try next
        }
    }
    return candidatePaths[0];
}

export async function loadSemanticEngine(): Promise<NativeSemanticEngine> {
    if (!enginePromise) {
        enginePromise = (async () => {
            const assetPath = resolveAssetPath();
            const createEngine = localRequire(assetPath);
            const engine = await createEngine();
            return engine as NativeSemanticEngine;
        })();
    }
    return enginePromise;
}
