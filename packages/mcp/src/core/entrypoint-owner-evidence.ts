import crypto from "node:crypto";
import {
    compareContractStrings,
    type SymbolRegistry,
} from "@satori-code/core";
import {
    prepareInspectableSource,
    type InspectableSourceFinalizationResult,
} from "./inspectable-source.js";

const PYPROJECT_FILE = "pyproject.toml";
const PYPROJECT_MAX_BYTES = 256 * 1024;
const PROJECT_SCRIPT_ENTRY_LIMIT = 64;
const SUPPORTED_PYTHON_SOURCE_ROOTS = ["", "src"] as const;
const PYTHON_MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PYTHON_SYMBOL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PROJECT_SCRIPTS_HEADER_PATTERN = /^\s*\[project\.scripts\]\s*(?:#.*)?$/;
const TOML_TABLE_HEADER_PATTERN = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
const PROJECT_SCRIPT_ASSIGNMENT_PATTERN =
    /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9._-]*))\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/;

export type EntrypointPublicationIdentity = Readonly<{
    publicationId: string;
    collectionName: string;
    policyHash: string;
    navigationPublicationId: string;
    symbolRegistryManifestHash: string;
}>;

export type EntrypointOwnerEvidence = Readonly<{
    command: string;
    declaration: Readonly<{
        relativePath: typeof PYPROJECT_FILE;
        startLine: number;
        endLine: number;
    }>;
    target: Readonly<{
        module: string;
        relativePath: string;
        symbol: string;
        symbolKey: string;
        symbolInstanceId: string;
    }>;
    sourceIdentity: string;
    publicationIdentity: string;
    resolutionConfidence: "exact";
    resolutionBasis: "pep621_project_script_supported_root_canonical_symbol";
}>;

export type EntrypointOwnerEvidenceResolution = Readonly<{
    status:
        | "resolved"
        | "manifest_absent"
        | "manifest_too_large"
        | "manifest_entry_limit_exceeded"
        | "unsupported_manifest"
        | "no_resolved_owners"
        | "publication_incompatible"
        | "unavailable";
    owners: readonly EntrypointOwnerEvidence[];
    declaredOwnerCount?: number;
    declaredOwnerCountLowerBound?: number;
    resolvedOwnerCount: number;
    resolutionComplete: boolean;
    manifestSourceIdentity?: string;
    publicationBinding: EntrypointPublicationIdentity;
    publicationIdentity: string;
}>;

export type PreparedEntrypointOwnerEvidence = Readonly<{
    resolution: EntrypointOwnerEvidenceResolution;
    finalize(input?: {
        validatePreparedAuthority?: () => Promise<void>;
    }): Promise<InspectableSourceFinalizationResult>;
    release(): Promise<void>;
}>;

type ParsedProjectScript = Readonly<{
    command: string;
    target: string;
    line: number;
}>;

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function publicationIdentity(input: EntrypointPublicationIdentity): string {
    return sha256(JSON.stringify([
        input.publicationId,
        input.collectionName,
        input.policyHash,
        input.navigationPublicationId,
        input.symbolRegistryManifestHash,
    ]));
}

function parseProjectScripts(
    source: string,
): ParsedProjectScript[] | "unsupported" | "entry_limit_exceeded" {
    const lines = source.split(/\r?\n/);
    let insideProjectScripts = false;
    let projectScriptsTableSeen = false;
    let entries: ParsedProjectScript[] = [];
    const commands = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        if (PROJECT_SCRIPTS_HEADER_PATTERN.test(line)) {
            if (projectScriptsTableSeen) return "unsupported";
            projectScriptsTableSeen = true;
            insideProjectScripts = true;
            continue;
        }
        if (insideProjectScripts && TOML_TABLE_HEADER_PATTERN.test(trimmed)) {
            break;
        }
        if (!insideProjectScripts || trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }

        const match = PROJECT_SCRIPT_ASSIGNMENT_PATTERN.exec(line);
        if (!match) {
            return "unsupported";
        }
        const command = match[1] ?? match[2] ?? match[3] ?? "";
        const target = match[4] ?? match[5] ?? "";
        if (command.length === 0 || target.length === 0) {
            continue;
        }
        if (commands.has(command)) return "unsupported";
        if (entries.length === PROJECT_SCRIPT_ENTRY_LIMIT) {
            return "entry_limit_exceeded";
        }
        commands.add(command);
        entries = [...entries, { command, target, line: index + 1 }];
    }

    return entries;
}

function parsePythonTarget(target: string): { module: string; symbol: string } | null {
    const match = /^([^:\s]+):([^\s\[]+)(?:\s*\[[^\]]+\])?$/.exec(target.trim());
    if (!match) return null;
    const module = match[1] ?? "";
    const symbol = match[2] ?? "";
    if (!PYTHON_MODULE_PATTERN.test(module) || !PYTHON_SYMBOL_PATTERN.test(symbol)) {
        return null;
    }
    return { module, symbol };
}

function resolveSupportedPythonModulePath(
    module: string,
    registry: SymbolRegistry,
): string | undefined {
    const modulePath = module.replace(/\./g, "/");
    const availablePythonFiles = new Set(
        registry.manifest.files
            .filter((file) => file.language === "python")
            .map((file) => file.path),
    );
    const candidates = SUPPORTED_PYTHON_SOURCE_ROOTS.flatMap((sourceRoot) => {
        const rootedModulePath = sourceRoot.length > 0
            ? `${sourceRoot}/${modulePath}`
            : modulePath;
        return [
            `${rootedModulePath}.py`,
            `${rootedModulePath}/__init__.py`,
        ];
    }).filter((candidate) => availablePythonFiles.has(candidate));
    return candidates.length === 1 ? candidates[0] : undefined;
}

export async function prepareEntrypointOwnerEvidence(input: {
    codebaseRoot: string;
    publication: EntrypointPublicationIdentity;
    registry: SymbolRegistry;
}): Promise<PreparedEntrypointOwnerEvidence | EntrypointOwnerEvidenceResolution> {
    const boundPublicationIdentity = publicationIdentity(input.publication);
    const publicationBinding = { ...input.publication };
    const prepared = await prepareInspectableSource({
        codebaseRoot: input.codebaseRoot,
        relativeFile: PYPROJECT_FILE,
        maxInspectableBytes: PYPROJECT_MAX_BYTES,
    });
    if (prepared.status !== "available") {
        return {
            status: prepared.reason === "source_exceeds_inspection_limit"
                ? "manifest_too_large"
                : "unavailable",
            owners: [],
            resolvedOwnerCount: 0,
            resolutionComplete: false,
            publicationBinding,
            publicationIdentity: boundPublicationIdentity,
        };
    }
    const manifestSourceIdentity = prepared.evidence.observedHash;
    const entries = parseProjectScripts(prepared.evidence.source);
    if (entries === "unsupported") {
        return {
            resolution: {
                status: "unsupported_manifest",
                owners: [],
                resolvedOwnerCount: 0,
                resolutionComplete: false,
                manifestSourceIdentity,
                publicationBinding,
                publicationIdentity: boundPublicationIdentity,
            },
            finalize: (finalizeInput) => prepared.finalizer.finalize(finalizeInput),
            release: () => prepared.finalizer.release(),
        };
    }
    if (entries === "entry_limit_exceeded") {
        return {
            resolution: {
                status: "manifest_entry_limit_exceeded",
                owners: [],
                declaredOwnerCountLowerBound: PROJECT_SCRIPT_ENTRY_LIMIT + 1,
                resolvedOwnerCount: 0,
                resolutionComplete: false,
                manifestSourceIdentity,
                publicationBinding,
                publicationIdentity: boundPublicationIdentity,
            },
            finalize: (finalizeInput) => prepared.finalizer.finalize(finalizeInput),
            release: () => prepared.finalizer.release(),
        };
    }

    const ownerCandidates = entries.map((entry) => {
        const parsedTarget = parsePythonTarget(entry.target);
        if (!parsedTarget) return null;
        const relativePath = resolveSupportedPythonModulePath(
            parsedTarget.module,
            input.registry,
        );
        if (!relativePath) return null;
        const matchingSymbols = (input.registry.symbolsByFile.get(relativePath) ?? [])
            .filter((symbol) => (
                symbol.language === "python"
                && symbol.qualifiedName === parsedTarget.symbol
            ));
        if (matchingSymbols.length !== 1) return null;
        const symbol = matchingSymbols[0];
        if (!symbol) return null;
        return {
            command: entry.command,
            declaration: {
                relativePath: PYPROJECT_FILE,
                startLine: entry.line,
                endLine: entry.line,
            },
            target: {
                module: parsedTarget.module,
                relativePath,
                symbol: parsedTarget.symbol,
                symbolKey: symbol.symbolKey,
                symbolInstanceId: symbol.symbolInstanceId,
            },
            sourceIdentity: manifestSourceIdentity,
            publicationIdentity: boundPublicationIdentity,
            resolutionConfidence: "exact",
            resolutionBasis: "pep621_project_script_supported_root_canonical_symbol",
        } satisfies EntrypointOwnerEvidence;
    });
    const owners = ownerCandidates
        .filter((owner): owner is EntrypointOwnerEvidence => owner !== null)
        .sort((left, right) => compareContractStrings(left.command, right.command));

    return {
        resolution: {
            status: owners.length > 0 ? "resolved" : "no_resolved_owners",
            owners,
            declaredOwnerCount: entries.length,
            resolvedOwnerCount: owners.length,
            resolutionComplete: owners.length === entries.length,
            manifestSourceIdentity,
            publicationBinding,
            publicationIdentity: boundPublicationIdentity,
        },
        finalize: (finalizeInput) => prepared.finalizer.finalize(finalizeInput),
        release: () => prepared.finalizer.release(),
    };
}
