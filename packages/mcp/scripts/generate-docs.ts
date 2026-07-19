import fs from "node:fs";
import path from "node:path";
import { ContextMcpConfig } from "../src/config.js";
import { CapabilityResolver } from "../src/core/capabilities.js";
import { getMcpToolList } from "../src/tools/registry.js";
import { ToolContext } from "../src/tools/types.js";

const START_MARKER = '<!-- TOOLS_START -->';
const END_MARKER = '<!-- TOOLS_END -->';

const TOOL_SUMMARIES: Readonly<Record<string, string>> = {
    manage_index: 'Create, synchronize, inspect, repair, reindex, or clear a repository index. Use status and repair guidance instead of guessing whether an index is ready.',
    search_codebase: 'Run freshness-aware hybrid search and return symbol-owned evidence. Start here for behavior, ownership, configuration, or path discovery.',
    continue_search: 'Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete.',
    file_outline: 'List the indexed symbols and spans in one file. Use it to choose an exact owner before reading implementation.',
    call_graph: 'Inspect advisory callers, callees, imports, and exports when supported. Verify inbound leads before blast-radius changes.',
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
