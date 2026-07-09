import { z } from "zod";
import { formatSymbolQualityMarker, resolveSymbolQualitySummary } from "@zokizuan/satori-core";
import { McpTool, ToolContext, formatZodError } from "./types.js";
import { classifyVectorBackendError, isMissingProviderConfigIssue } from "./setup-errors.js";
import { getCompletionMarkerReader, validateCompletionProof } from "../core/completion-proof.js";
import { formatRuntimeOwnersStatusLine } from "../core/runtime-owner.js";

const listCodebasesInputSchema = z.object({}).strict();
const comparePathAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function formatSnapshotCorruptionWarning(warning: ReturnType<ToolContext["snapshotManager"]["getSnapshotCorruptionWarning"]>): string[] {
    if (!warning) {
        return [];
    }
    const lines = [
        "WARNING: Snapshot state was recovered after a corrupt snapshot was quarantined. Tracked codebases may be incomplete.",
        `Snapshot path: ${warning.snapshotPath}`,
    ];
    if (warning.quarantinedPath) {
        lines.push(`Quarantined snapshot: ${warning.quarantinedPath}`);
    }
    lines.push(`Reason: ${warning.message}`);
    return lines;
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
        const rawSnapshotWarning = typeof ctx.snapshotManager.getSnapshotCorruptionWarning === "function"
            ? ctx.snapshotManager.getSnapshotCorruptionWarning()
            : undefined;
        const snapshotWarning = formatSnapshotCorruptionWarning(rawSnapshotWarning);

        if (all.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: [
                        ...snapshotWarning,
                        ...(snapshotWarning.length > 0 ? [""] : []),
                        "No codebases are currently tracked.",
                        "",
                        "Use manage_index with action='create' to index one.",
                    ].join("\n")
                }]
            };
        }

        const lines: string[] = [];
        if (snapshotWarning.length > 0) {
            lines.push(...snapshotWarning);
            lines.push('');
        }
        lines.push('## Codebases');
        lines.push('');

        let proofContext = ctx;
        let providerIncomplete: { missingEnv: string[] } | null = null;
        if (ctx.providerRuntime) {
            try {
                const providerContext = await ctx.providerRuntime.requireToolContext("vector_only");
                if (isMissingProviderConfigIssue(providerContext)) {
                    // Provider gaps beat fake missing-marker / fingerprint narratives from a weak local context.
                    providerIncomplete = { missingEnv: providerContext.missingEnv };
                } else {
                    proofContext = providerContext;
                }
            } catch (error) {
                if (classifyVectorBackendError(error)) {
                    proofContext = ctx;
                } else {
                    throw error;
                }
            }
        }

        const readyCandidates = all
            .filter((e) => e.info.status === "indexed" || e.info.status === "sync_completed");
        const ready: Array<{ path: string; probeFailed?: boolean }> = [];
        const requiresReindex: Array<{ path: string; reason: string }> = [];
        // Real index failures always keep their original message. manage_index status
        // reports these as status:"error" and preferProviderIncompleteForStatus preserves them.
        const failed: Array<{ path: string; reason: string }> = all
            .filter((e) => e.info.status === "indexfailed")
            .map((entry) => ({
                path: entry.path,
                reason: "errorMessage" in entry.info
                    ? String(entry.info.errorMessage)
                    : "unknown",
            }));

        if (providerIncomplete) {
            // Align with manage_index status (missing_provider_config):
            // provider gaps beat fake ready / requires_reindex narratives, but never mask
            // status:"error" / indexfailed root causes.
            const missing = providerIncomplete.missingEnv.length > 0
                ? providerIncomplete.missingEnv.join(",")
                : "unknown";
            const reason = `provider_incomplete:${missing}`;
            for (const entry of readyCandidates) {
                failed.push({ path: entry.path, reason });
            }
            for (const entry of all.filter((e) => e.info.status === "requires_reindex")) {
                failed.push({ path: entry.path, reason });
            }
        } else {
            for (const entry of all.filter((e) => e.info.status === "requires_reindex")) {
                requiresReindex.push({
                    path: entry.path,
                    reason: "reindexReason" in entry.info && entry.info.reindexReason
                        ? String(entry.info.reindexReason)
                        : "unknown",
                });
            }

            const completionProofChecks = await Promise.all(readyCandidates.map(async (entry) => ({
                entry,
                proof: await validateCompletionProof({
                    codebasePath: entry.path,
                    runtimeFingerprint: proofContext.runtimeFingerprint,
                    getIndexCompletionMarker: getCompletionMarkerReader(proofContext.context)
                })
            })));

            for (const { entry, proof } of completionProofChecks) {
                if (proof.outcome === "valid") {
                    ready.push({ path: entry.path });
                    continue;
                }
                if (proof.outcome === "probe_failed") {
                    // Probe failure is non-authoritative: keep local ready status stable.
                    ready.push({ path: entry.path, probeFailed: true });
                    continue;
                }
                if (proof.outcome === "fingerprint_mismatch") {
                    requiresReindex.push({ path: entry.path, reason: "completion_proof_fingerprint_mismatch" });
                    continue;
                }
                const staleReason = proof.reason || "missing_marker_doc";
                failed.push({ path: entry.path, reason: `stale_local:${staleReason}` });
            }
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
            // F9: compact observed quality marker per ready root (same summary as manage status).
            // Cost: reads symbol registry sidecars when present; missing registry → symbolQuality=unknown.
            const qualityByPath = new Map<string, string>();
            await Promise.all(byStatus.indexed.map(async (item) => {
                const summary = await resolveSymbolQualitySummary({
                    normalizedRootPath: item.path,
                });
                qualityByPath.set(item.path, formatSymbolQualityMarker(summary));
            }));
            for (const item of byStatus.indexed) {
                const quality = qualityByPath.get(item.path) || "symbolQuality=unknown";
                const probeSuffix = item.probeFailed
                    ? " (completion proof probe failed; verify with manage_index action='status')"
                    : "";
                lines.push(`- \`${item.path}\` ${quality}${probeSuffix}`);
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

        if (ctx.runtimeOwnerGate && typeof ctx.runtimeOwnerGate.getLiveOwnersSummary === "function") {
            try {
                const ownersSummary = await ctx.runtimeOwnerGate.getLiveOwnersSummary();
                if (ownersSummary) {
                    lines.push('');
                    lines.push(formatRuntimeOwnersStatusLine(ownersSummary));
                }
            } catch {
                // Diagnostic only.
            }
        }

        return {
            content: [{
                type: "text",
                text: lines.join('\n')
            }]
        };
    }
};
