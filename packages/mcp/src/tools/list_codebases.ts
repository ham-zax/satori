import { z } from "zod";
import { McpTool, ToolContext, formatZodError } from "./types.js";

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

        const byStatus = {
            indexed: all
                .filter((e) => e.info.status === 'indexed' || e.info.status === 'sync_completed')
                .sort((a, b) => comparePathAsc(a.path, b.path)),
            indexing: all
                .filter((e) => e.info.status === 'indexing')
                .sort((a, b) => comparePathAsc(a.path, b.path)),
            requiresReindex: all
                .filter((e) => e.info.status === 'requires_reindex')
                .sort((a, b) => comparePathAsc(a.path, b.path)),
            failed: all
                .filter((e) => e.info.status === 'indexfailed')
                .sort((a, b) => comparePathAsc(a.path, b.path)),
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
                const reason = 'reindexReason' in item.info && item.info.reindexReason ? item.info.reindexReason : 'unknown';
                lines.push(`- \`${item.path}\` (${reason})`);
            }
            lines.push('');
        }

        if (byStatus.failed.length > 0) {
            lines.push('### Failed');
            for (const item of byStatus.failed) {
                const reason = 'errorMessage' in item.info ? item.info.errorMessage : 'unknown';
                lines.push(`- \`${item.path}\` (${reason})`);
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
