import fs from "node:fs";
import path from "node:path";
import { ContextMcpConfig } from "../src/config.js";
import { CapabilityResolver } from "../src/core/capabilities.js";
import { getMcpToolList } from "../src/tools/registry.js";
import { ToolContext } from "../src/tools/types.js";

const START_MARKER = '<!-- TOOLS_START -->';
const END_MARKER = '<!-- TOOLS_END -->';

const TOOL_SUMMARIES: Readonly<Record<string, string>> = {
    architecture_overview: 'Summarize bounded Publication architecture evidence as existing logical areas plus factual package architecture from the same persisted ownership snapshot: scoped package identities/counts, cross-package CALLS/IMPORTS boundaries, package fan-in/fan-out, and owned-package cycles. Optional subtree/exclusions and runtime/all scope filter evidence before both projections.',
    detect_changes: 'Map a Git diff to current indexed symbol seeds and bounded inbound CALLS. Graph-derived callers are labeled direct/transitive with causal paths, explicit proof-backed vs heuristic evidence class, and area aggregation; uncertain semantic references stay separate, and completeness reasons disclose traversal and evidence limits.',
    manage_index: 'Manage the repository-intelligence Publication: create the first index, synchronize source changes, inspect readiness, cancel a live supervised sync, recover with reindex, or clear index state. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance; explicit reindex remains the operator recovery override.',
    search_codebase: 'Search the repository-intelligence Publication with semantic, lexical, and exact evidence and return owner-oriented results. `limit` bounds the frozen result set across all pages; `disclosureLimit` controls only the initial grouped page.',
    continue_search: 'Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. A grouped envelope without continuation reports pagination.continuation="complete" for the caller-bounded frozen set only; omittedBeyondLimitGroupCount reports groups excluded by the caller limit.',
    call_graph: 'Inspect admitted CALLS plus persisted semantic reference evidence. The default evidenceSummary separates returned CALLS/inbound caller owners from resolved exact target references, reference-only owners, ownerless exact references, ambiguous/unresolved target evidence, and observational sourceReferences; detailed evidence remains pageable.',
    trace_path: 'Find one shortest directed path between exact published symbol IDs over selected persisted CALLS, IMPORTS, EXPORTS, or TESTS edges. The requested path confines nodes and evidence; depth, node, and edge budgets report truncation.',
    find_references: 'Find ranking-independent exact textual occurrences of one canonical symbol across validated published source, with exact spans, owning symbols when available, deterministic path scope, and Publication-hash-bound complete/partial coverage. Textual matches are observational only.',
    file_outline: 'List indexed symbols and spans in one file. Exact Python functions and methods can request on-demand structural analysis; relationship_coverage exposes per-file observed ResolutionClaim construct calibration.',
    read_file: 'Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods.',
    list_codebases: 'List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one.',
};

function buildToolDocsSection(): string {
    const config: ContextMcpConfig = {
        name: 'Satori MCP Server',
        version: '1.0.0',
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
        vectorStoreProvider: 'Milvus',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        encoderOutputDimension: 1024,
        voyageKey: 'docs-example-key',
        milvusEndpoint: 'https://example.zilliz.com',
        milvusApiToken: 'docs-token',
        rankerModel: 'rerank-2.5',
    };
    const capabilities = new CapabilityResolver(config);

    const minimalContext = {
        capabilities,
    } as ToolContext;

    const tools = getMcpToolList(minimalContext);

    const lines: string[] = [];
    lines.push('## Tools');
    lines.push('');

    const undocumentedTools = tools.filter((tool) => !TOOL_SUMMARIES[tool.name]);
    const removedTools = Object.keys(TOOL_SUMMARIES).filter(
        (toolName) => !tools.some((tool) => tool.name === toolName),
    );
    if (undocumentedTools.length > 0 || removedTools.length > 0) {
        throw new Error(
            `Tool summary mismatch. Missing: ${undocumentedTools.map((tool) => tool.name).join(', ') || 'none'}; `
            + `removed: ${removedTools.join(', ') || 'none'}.`,
        );
    }

    lines.push('| Tool | Purpose |');
    lines.push('|---|---|');
    for (const tool of tools) {
        lines.push(`| \`${tool.name}\` | ${TOOL_SUMMARIES[tool.name]} |`);
    }

    return lines.join('\n');
}

function injectSection(content: string, generatedSection: string): string {
    const start = content.indexOf(START_MARKER);
    const end = content.indexOf(END_MARKER);

    if (start === -1 || end === -1 || end < start) {
        throw new Error(`README markers are missing or invalid. Expected '${START_MARKER}' and '${END_MARKER}'.`);
    }

    const before = content.slice(0, start + START_MARKER.length);
    const after = content.slice(end);

    return `${before}\n\n${generatedSection}\n\n${after}`;
}

function main(): void {
    const checkMode = process.argv.includes('--check');
    const readmePath = path.resolve(process.cwd(), 'README.md');

    const current = fs.readFileSync(readmePath, 'utf8');
    const generatedSection = buildToolDocsSection();
    const next = injectSection(current, generatedSection);

    if (checkMode) {
        if (next !== current) {
            console.error('[docs:check] README tool reference is out of date. Run: pnpm docs:generate');
            process.exit(1);
        }
        console.log('[docs:check] README tool reference is up to date.');
        return;
    }

    fs.writeFileSync(readmePath, next);
    console.log('[docs:generate] README tool reference updated.');
}

main();
