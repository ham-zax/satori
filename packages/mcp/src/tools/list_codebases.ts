import { z } from "zod";
import { McpTool, ToolContext, formatZodError } from "./types.js";
import { validateCompletionProof } from "../core/completion-proof.js";

const listCodebasesInputSchema = z.object({}).strict();
const comparePathAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
            proof: await validateCompletionProof({
                codebasePath: entry.path,
                runtimeFingerprint: ctx.runtimeFingerprint,
                getIndexCompletionMarker: typeof (ctx.context as any)?.getIndexCompletionMarker === "function"
                    ? (markerPath) => (ctx.context as any).getIndexCompletionMarker(markerPath)
                    : undefined
            })
        })));

        const ready: Array<{ path: string; probeFailed?: boolean }> = [];
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
                const suffix = item.probeFailed
                    ? " (completion proof probe failed; verify with manage_index action='status')"
                    : "";
                lines.push(`- \`${item.path}\`${suffix}`);
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
