import { z } from "zod";
import {
    computeSymbolQualitySummaryFromSidecarRead,
    formatSymbolQualityMarker,
    readSymbolRegistrySidecar,
    type PublicationRef,
} from "@satori-code/core";
import { McpTool, ToolContext, formatZodError } from "./types.js";
import { classifyVectorBackendError, isMissingProviderConfigIssue } from "./setup-errors.js";
import { getPublicationProofReader, validateCompletionProof } from "../core/completion-proof.js";
import { formatRuntimeOwnersStatusLine } from "../core/runtime-owner.js";

const listCodebasesInputSchema = z.object({}).strict();
const comparePathAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const listCodebasesTool: McpTool = {
    name: "list_codebases",
    description: () => "List known Satori codebases and their Publication/index readiness. Use this when the target root or readiness is unknown; use manage_index status for detailed capabilities or diagnostics.",
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

        const trackedByPath = new Map<string, {
            path: string;
            info: Record<string, unknown> & { status: "indexed" | "indexing" };
        }>();
        for (const ref of ctx.context.listCurrentPublications()) {
            const publication = ref.publication;
            trackedByPath.set(publication.canonicalRoot, {
                path: publication.canonicalRoot,
                info: {
                    status: "indexed",
                    lastUpdated: publication.createdAt,
                    indexStatus: publication.status === "complete" ? "completed" : "limit_reached",
                    indexedFiles: publication.vector.indexedFiles,
                    totalChunks: publication.vector.totalChunks,
                },
            });
        }
        for (const activity of ctx.mutationRuntime.listActiveMutations()) {
            if (activity.action !== "create" && activity.action !== "reindex") continue;
            const operation = ctx.mutationRuntime.getOperation(activity.canonicalRoot);
            trackedByPath.set(activity.canonicalRoot, {
                path: activity.canonicalRoot,
                info: {
                    status: "indexing",
                    lastUpdated: operation?.updatedAt ?? activity.acceptedAt,
                    ...(operation?.progress !== undefined
                        ? { indexingPercentage: operation.progress }
                        : {}),
                },
            });
        }
        const all = Array.from(trackedByPath.values()).filter((entry) => {
            // Session workspace gate: only roots authorized for this session are visible.
            // Missing/unbound policy fails closed to an empty listing.
            if (!ctx.workspacePolicy) return false;
            try {
                ctx.workspacePolicy.authorizeRoot(entry.path);
                return true;
            } catch {
                return false;
            }
        });

        if (all.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: [
                        "No codebases are currently tracked.",
                        "",
                        "Use manage_index with action='create' to index one.",
                    ].join("\n")
                }]
            };
        }

        const lines: string[] = [];
        lines.push('## Codebases');
        lines.push('');

        let proofContext = ctx;
        let providerIncomplete: { missingEnv: string[] } | null = null;
        if (ctx.providerRuntime) {
            try {
                const providerContext = await ctx.providerRuntime.requireToolContext("vector_only");
                if (isMissingProviderConfigIssue(providerContext)) {
                    // Provider gaps beat readiness narratives that require provider-backed validation.
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
            .filter((e) => e.info.status === "indexed");
        const ready: Array<{
            path: string;
            probeFailed?: boolean;
            navigationStatus?: "valid" | "not_bound" | "missing" | "incompatible" | "corrupt";
            publication?: PublicationRef;
        }> = [];
        const requiresReindex: Array<{ path: string; reason: string }> = [];
        const failed: Array<{ path: string; reason: string }> = [];

        if (providerIncomplete) {
            // Align with manage_index status (missing_provider_config): provider gaps
            // beat readiness narratives that require provider-backed validation.
            const missing = providerIncomplete.missingEnv.length > 0
                ? providerIncomplete.missingEnv.join(",")
                : "unknown";
            const reason = `provider_incomplete:${missing}`;
            for (const entry of readyCandidates) {
                failed.push({ path: entry.path, reason });
            }
        } else {
            const completionProofChecks = await Promise.all(readyCandidates.map(async (entry) => ({
                entry,
                proof: await validateCompletionProof({
                    codebasePath: entry.path,
                    getCurrentPublication: getPublicationProofReader(proofContext.context)
                })
            })));

            for (const { entry, proof } of completionProofChecks) {
                if (proof.outcome === "valid") {
                    ready.push({
                        path: entry.path,
                        ...(proof.navigationStatus ? { navigationStatus: proof.navigationStatus } : {}),
                        ...(proof.publication ? { publication: proof.publication } : {}),
                    });
                    continue;
                }
                if (proof.outcome === "probe_failed") {
                    // Probe failure is non-authoritative: keep local ready status stable.
                    ready.push({ path: entry.path, probeFailed: true });
                    continue;
                }
                const staleReason = proof.reason || "missing_publication";
                requiresReindex.push({ path: entry.path, reason: staleReason });
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
            // F9: compact observed quality marker per ready root from the
            // Publication-local JSON registry used by manage_index summary.
            const qualityByPath = new Map<string, string>();
            await Promise.all(byStatus.indexed.map(async (item) => {
                if (item.navigationStatus !== 'valid' || !item.publication) {
                    qualityByPath.set(item.path, 'symbolQuality=unknown');
                    return;
                }
                const lease = proofContext.context.acquireCurrentPublicationRead(item.path);
                if (!lease || lease.id !== item.publication.id) {
                    lease?.release();
                    qualityByPath.set(item.path, 'symbolQuality=unknown');
                    return;
                }
                try {
                    const navigation = proofContext.context.getPublicationNavigationAddress(lease);
                    if (!navigation) {
                        qualityByPath.set(item.path, 'symbolQuality=unknown');
                        return;
                    }
                    const registryRead = await readSymbolRegistrySidecar({
                        normalizedRootPath: item.path,
                        publicationId: navigation.publicationId,
                        navigationRoot: navigation.navigationRoot,
                    });
                    const summary = computeSymbolQualitySummaryFromSidecarRead(registryRead);
                    qualityByPath.set(item.path, formatSymbolQualityMarker(summary));
                } finally {
                    lease.release();
                }
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
                const progress = typeof item.info.indexingPercentage === "number"
                    ? `${item.info.indexingPercentage.toFixed(1)}%`
                    : "progress unavailable in this process";
                lines.push(`- \`${item.path}\` (${progress})`);
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
