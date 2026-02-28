import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpTool, ToolContext, formatZodError } from "./types.js";

const listCodebasesInputSchema = z.object({}).strict();
const comparePathAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type CompletionProofReason =
    | "missing_marker_doc"
    | "invalid_marker_kind"
    | "invalid_payload"
    | "path_mismatch"
    | "fingerprint_mismatch"
    | "probe_failed";
type CompletionProofOutcome = "valid" | "probe_failed" | "stale_local" | "fingerprint_mismatch";

function trimTrailingSeparators(inputPath: string): string {
    const normalized = path.normalize(inputPath);
    const parsedRoot = path.parse(normalized).root;
    if (normalized === parsedRoot) {
        return normalized;
    }
    return normalized.replace(/[\\/]+$/, "");
}

function canonicalizeCodebasePath(codebasePath: string): string {
    const resolved = path.resolve(codebasePath);
    try {
        const realPath = typeof fs.realpathSync.native === "function"
            ? fs.realpathSync.native(resolved)
            : fs.realpathSync(resolved);
        return trimTrailingSeparators(path.normalize(realPath));
    } catch {
        return trimTrailingSeparators(path.normalize(resolved));
    }
}

function markerMatchesRuntimeFingerprint(marker: any, ctx: ToolContext): boolean {
    const runtimeFingerprint = ctx.runtimeFingerprint;
    if (!runtimeFingerprint || typeof runtimeFingerprint !== "object") {
        return true;
    }
    const fingerprint = marker?.fingerprint;
    if (!fingerprint || typeof fingerprint !== "object") {
        return false;
    }
    return fingerprint.embeddingProvider === runtimeFingerprint.embeddingProvider
        && fingerprint.embeddingModel === runtimeFingerprint.embeddingModel
        && Number(fingerprint.embeddingDimension) === Number(runtimeFingerprint.embeddingDimension)
        && fingerprint.vectorStoreProvider === runtimeFingerprint.vectorStoreProvider
        && fingerprint.schemaVersion === runtimeFingerprint.schemaVersion;
}

function validateMarkerShape(expectedCodebasePath: string, marker: any): { ok: true } | { ok: false; reason: CompletionProofReason } {
    if (!marker || typeof marker !== "object") {
        return { ok: false, reason: "invalid_payload" };
    }

    if (marker.kind !== "satori_index_completion_v1") {
        return { ok: false, reason: "invalid_marker_kind" };
    }

    if (typeof marker.codebasePath !== "string" || marker.codebasePath.trim().length === 0) {
        return { ok: false, reason: "invalid_payload" };
    }

    if (!marker.fingerprint || typeof marker.fingerprint !== "object") {
        return { ok: false, reason: "invalid_payload" };
    }

    if (!Number.isFinite(Number(marker.indexedFiles)) || !Number.isFinite(Number(marker.totalChunks))) {
        return { ok: false, reason: "invalid_payload" };
    }

    if (typeof marker.completedAt !== "string" || Number.isNaN(Date.parse(marker.completedAt))) {
        return { ok: false, reason: "invalid_payload" };
    }

    const expectedCanonical = canonicalizeCodebasePath(expectedCodebasePath);
    const markerCanonical = canonicalizeCodebasePath(marker.codebasePath);
    if (expectedCanonical !== markerCanonical) {
        return { ok: false, reason: "path_mismatch" };
    }

    return { ok: true };
}

async function validateCompletionProof(codebasePath: string, ctx: ToolContext): Promise<{ outcome: CompletionProofOutcome; reason?: CompletionProofReason }> {
    const getMarker = (ctx.context as any)?.getIndexCompletionMarker;
    if (typeof getMarker !== "function") {
        return { outcome: "probe_failed", reason: "probe_failed" };
    }

    let marker: any;
    try {
        marker = await getMarker(codebasePath);
    } catch {
        return { outcome: "probe_failed", reason: "probe_failed" };
    }

    if (!marker) {
        return { outcome: "stale_local", reason: "missing_marker_doc" };
    }

    const markerShape = validateMarkerShape(codebasePath, marker);
    if (!markerShape.ok) {
        return { outcome: "stale_local", reason: markerShape.reason };
    }

    if (!markerMatchesRuntimeFingerprint(marker, ctx)) {
        return { outcome: "fingerprint_mismatch", reason: "fingerprint_mismatch" };
    }

    return { outcome: "valid" };
}

export const listCodebasesTool: McpTool = {
    name: "list_codebases",
    description: () => "List tracked codebases and their indexing state.",
    inputSchemaZod: () => listCodebasesInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const normalizedArgs = (args ?? {}) as Record<string, unknown>;
        const parsed = listCodebasesInputSchema.safeParse(normalizedArgs);
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("list_codebases", parsed.error)
                }],
                isError: true
            };
        }

        const all = ctx.snapshotManager.getAllCodebases();

        if (all.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently tracked.\n\nUse manage_index with action='create' to index one."
                }]
            };
        }

        const lines: string[] = [];
        lines.push('## Codebases');
        lines.push('');

        const readyCandidates = all
            .filter((e) => e.info.status === "indexed" || e.info.status === "sync_completed");
        const completionProofChecks = await Promise.all(readyCandidates.map(async (entry) => ({
            entry,
            proof: await validateCompletionProof(entry.path, ctx)
        })));

        const ready: Array<{ path: string }> = [];
        const requiresReindex = all
            .filter((e) => e.info.status === "requires_reindex")
            .map((entry) => ({
                path: entry.path,
                reason: "reindexReason" in entry.info && entry.info.reindexReason
                    ? String(entry.info.reindexReason)
                    : "unknown"
            }));
        const failed = all
            .filter((e) => e.info.status === "indexfailed")
            .map((entry) => ({
                path: entry.path,
                reason: "errorMessage" in entry.info
                    ? String(entry.info.errorMessage)
                    : "unknown"
            }));

        for (const { entry, proof } of completionProofChecks) {
            if (proof.outcome === "valid") {
                ready.push({ path: entry.path });
                continue;
            }
            if (proof.outcome === "probe_failed") {
                // Probe failure is non-authoritative: keep local ready status stable.
                ready.push({ path: entry.path });
                continue;
            }
            if (proof.outcome === "fingerprint_mismatch") {
                requiresReindex.push({ path: entry.path, reason: "completion_proof_fingerprint_mismatch" });
                continue;
            }
            const staleReason = proof.reason || "missing_marker_doc";
            failed.push({ path: entry.path, reason: `stale_local:${staleReason}` });
        }

        const byStatus = {
            indexed: ready.sort((a, b) => comparePathAsc(a.path, b.path)),
            indexing: all
                .filter((e) => e.info.status === 'indexing')
                .sort((a, b) => comparePathAsc(a.path, b.path)),
            requiresReindex: requiresReindex.sort((a, b) => comparePathAsc(a.path, b.path)),
            failed: failed.sort((a, b) => comparePathAsc(a.path, b.path)),
        };

        if (byStatus.indexed.length > 0) {
            lines.push('### Ready');
            for (const item of byStatus.indexed) {
                lines.push(`- \`${item.path}\``);
            }
            lines.push('');
        }

        if (byStatus.indexing.length > 0) {
            lines.push('### Indexing');
            for (const item of byStatus.indexing) {
                const progress = 'indexingPercentage' in item.info ? item.info.indexingPercentage.toFixed(1) : '0.0';
                lines.push(`- \`${item.path}\` (${progress}%)`);
            }
            lines.push('');
        }

        if (byStatus.requiresReindex.length > 0) {
            lines.push('### Requires Reindex');
            for (const item of byStatus.requiresReindex) {
                lines.push(`- \`${item.path}\` (${item.reason})`);
            }
            lines.push('');
        }

        if (byStatus.failed.length > 0) {
            lines.push('### Failed');
            for (const item of byStatus.failed) {
                lines.push(`- \`${item.path}\` (${item.reason})`);
            }
            lines.push('');
        }

        lines.push(`Total tracked: ${all.length}`);

        return {
            content: [{
                type: "text",
                text: lines.join('\n')
            }]
        };
    }
};
