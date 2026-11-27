import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CapabilityResolver } from '../core/capabilities.js';
import { createSessionWorkspacePolicy } from '../core/session-workspace-policy.js';
import { ContextMcpConfig } from '../config.js';
import { buildMcpToolList, getMcpToolList, toolRegistry } from './registry.js';
import { ToolContext } from './types.js';

type SchemaProperty = Record<string, unknown> & {
    default?: unknown;
};

function buildConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
        stateRoot: path.join(os.tmpdir(), 'satori-test-state-root'),
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
        vectorStoreProvider: 'Milvus',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        encoderOutputDimension: 1024,
        voyageKey: 'voyage-key',
        milvusEndpoint: 'https://example.zilliz.com',
        milvusApiToken: 'token',
        rankerModel: 'rerank-2.5',
        ...overrides,
    };
}

function buildContext(overrides: Partial<ContextMcpConfig> = {}): ToolContext {
    const capabilities = new CapabilityResolver(buildConfig(overrides));
    return {
        capabilities,
        workspacePolicy: createSessionWorkspacePolicy({
            roots: [path.join(os.tmpdir(), 'satori-registry-test')],
            homeDirectory: os.homedir(),
            stateRoot: path.join(os.homedir(), '.satori'),
        }),
    } as ToolContext;
}

test('tool registry exposes the twelve public tools', () => {
    const names = Object.keys(toolRegistry);
    assert.deepEqual(names, ['manage_index', 'search_codebase', 'architecture_overview', 'continue_search', 'call_graph', 'trace_path', 'find_references', 'detect_changes', 'file_outline', 'read_file', 'list_codebases', 'run_script']);
});

test('generated ListTools payload returns the twelve tools', () => {
    const list = getMcpToolList(buildContext());
    const names = list.map((tool) => tool.name);

    assert.deepEqual(names, ['manage_index', 'search_codebase', 'architecture_overview', 'continue_search', 'call_graph', 'trace_path', 'find_references', 'detect_changes', 'file_outline', 'read_file', 'list_codebases', 'run_script']);
});

test('find_references description exposes observational and completeness semantics', () => {
    const tools = getMcpToolList(buildContext());
    const references = tools.find((tool) => tool.name === 'find_references');

    assert.ok(references);
    assert.match(references!.description, /ranking-independent/i);
    assert.match(references!.description, /observational/i);
    assert.match(references!.description, /coverage=complete/i);
    assert.match(references!.description, /coverage=partial/i);
});

test('search_codebase description exposes current retrieval and remediation guidance', () => {
    const tools = getMcpToolList(buildContext());
    const searchTool = tools.find((tool) => tool.name === 'search_codebase');

    assert.ok(searchTool);
    assert.match(searchTool!.description, /\.satoriignore/);
    assert.match(searchTool!.description, /scope=\"runtime\"/);
    assert.match(searchTool!.description, /runtime-first/i);
    assert.match(searchTool!.description, /must:/);
    assert.match(searchTool!.description, /debugMode=summary\|ranking\|freshness\|full/i);
    assert.match(searchTool!.description, /hints/i);
});

// F-AC-01: MCP tool description must calibrate CALLS as capability-gated, conservative, bounded, and advisory.
test('call_graph description is capability-based and calibrates conservative CALLS v0', () => {
    const tools = getMcpToolList(buildContext());
    const callGraphTool = tools.find((tool) => tool.name === 'call_graph');
    assert.ok(callGraphTool);

    assert.match(callGraphTool!.description, /canonical language capability/i);
    assert.match(callGraphTool!.description, /current Publication/i);
    assert.match(callGraphTool!.description, /heuristic/i);
    assert.match(callGraphTool!.description, /name-based/i);
    assert.match(callGraphTool!.description, /qualified direct-call/i);
    assert.match(callGraphTool!.description, /receiver\/type-aware dispatch/i);
    assert.match(callGraphTool!.description, /bounded/i);
    assert.match(callGraphTool!.description, /advisory/i);
    assert.match(callGraphTool!.description, /not.*authoritative blast-radius/i);
    assert.match(callGraphTool!.description, /not a compiler-grade call graph/i);
    assert.doesNotMatch(callGraphTool!.description, /TS\/JS\/Python/i);
    assert.ok(
        callGraphTool!.description.length <= 700,
        `call_graph description should stay concise for agent context budgets (got ${callGraphTool!.description.length} chars)`,
    );
});

test('all MCP tool descriptions stay concise to minimize per-turn context tax', () => {
    const tools = getMcpToolList(buildContext());
    const totalChars = tools.reduce((sum, tool) => sum + tool.description.length, 0);
    for (const tool of tools) {
        assert.ok(
            tool.description.length <= 800,
            `${tool.name} description exceeded 800 chars (${tool.description.length})`,
        );
    }
    assert.ok(
        totalChars <= 5000,
        `Total MCP tool descriptions exceeded 5000 chars (${totalChars})`,
    );
});

test('full serialized tools/list payload stays within per-tool and total byte budgets', () => {
    const tools = getMcpToolList(buildContext());
    const maxToolBytes = 6_000;
    const maxTotalPayloadBytes = 24_576;

    for (const tool of tools) {
        const entryBytes = Buffer.byteLength(JSON.stringify(tool), 'utf8');
        assert.ok(
            entryBytes <= maxToolBytes,
            `${tool.name} serialized tools/list entry exceeded ${maxToolBytes}B (${entryBytes}B)`,
        );
    }

    const totalPayloadBytes = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
    assert.ok(
        totalPayloadBytes <= maxTotalPayloadBytes,
        `Full serialized tools/list payload exceeded ${maxTotalPayloadBytes}B (${totalPayloadBytes}B)`,
    );
});

test('search_codebase schema exposes scoped grouped/raw controls', () => {
    const tools = getMcpToolList(buildContext());
    const searchTool = tools.find((tool) => tool.name === 'search_codebase');
    assert.ok(searchTool);

    const properties = searchTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.ok(properties.scope);
    assert.ok(properties.resultMode);
    assert.ok(properties.groupBy);
    assert.ok(properties.rankingMode);
    assert.equal(properties.debug, undefined);
    assert.ok(properties.debugMode);
    assert.ok(properties.debugCandidateLimit);
    assert.equal(properties.scope.default, 'runtime');
    assert.equal(properties.resultMode.default, 'grouped');
    assert.equal(properties.groupBy.default, 'symbol');
    assert.equal(properties.rankingMode.default, 'auto_changed_first');
    assert.equal(properties.limit.default, 200);
    assert.equal(properties.limit.maximum, Number.MAX_SAFE_INTEGER);
    assert.match(String(properties.limit.description), /grouped mode: total frozen result-set bound across continuation pages/i);
    assert.equal(properties.disclosureLimit.maximum, 200);
    assert.match(String(properties.disclosureLimit.description), /page size only, default 8/i);
    assert.match(String(properties.limit.description), /raw mode: maximum returned chunk count/i);
    assert.match(String(properties.disclosureLimit.description), /limit=100 and disclosureLimit=20 returns up to 20 initially and freezes up to 100 total/i);
    assert.deepEqual(properties.debugMode.enum, ['summary', 'ranking', 'freshness', 'full']);
    assert.equal(properties.debugCandidateLimit.maximum, 160);
    assert.equal(Object.prototype.hasOwnProperty.call(properties, 'useReranker'), false);

    const required = searchTool!.inputSchema.required as string[];
    assert.ok(required.includes('path'));
    assert.ok(required.includes('query'));
});

test('continue_search schema requires an idempotent cursor offset and bounds its optional page limit', () => {
    const tools = getMcpToolList(buildContext());
    const continueTool = tools.find((tool) => tool.name === 'continue_search');
    assert.ok(continueTool);

    const properties = continueTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.deepEqual(Object.keys(properties), ['handle', 'expectedOffset', 'limit']);
    assert.equal(properties.expectedOffset.minimum, 0);
    assert.equal(properties.expectedOffset.maximum, 200);
    assert.equal(properties.limit.maximum, 200);

    const required = continueTool!.inputSchema.required as string[];
    assert.deepEqual(required, ['handle', 'expectedOffset']);
});

test('read_file schema includes optional start_line and end_line parameters', () => {
    const tools = getMcpToolList(buildContext());
    const readFileTool = tools.find((tool) => tool.name === 'read_file');
    assert.ok(readFileTool);

    const properties = readFileTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.ok(properties.path);
    assert.ok(properties.start_line);
    assert.ok(properties.end_line);
    assert.ok(properties.mode);
    assert.ok(properties.presentation);
    assert.ok(properties.open_symbol);
    assert.equal(Object.prototype.hasOwnProperty.call(properties.mode, 'default'), false);
    assert.deepEqual(properties.presentation.enum, ['compact', 'full']);
    assert.equal(Object.prototype.hasOwnProperty.call(properties.presentation, 'default'), false);

    const required = readFileTool!.inputSchema.required as string[];
    assert.deepEqual(required, ['path']);
    assert.equal(Object.prototype.hasOwnProperty.call(properties.start_line, 'default'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties.end_line, 'default'), false);
});

test('read_file description documents bounded symbol reads and exact full-source reads', () => {
    const tools = getMcpToolList(buildContext());
    const readFileTool = tools.find((tool) => tool.name === 'read_file');
    assert.ok(readFileTool);

    assert.match(readFileTool!.description, /open_symbol \/ symbol_context/);
    assert.match(readFileTool!.description, /bounded symbol source/);
    assert.match(readFileTool!.description, /continuation-aware excerpts/);
    assert.match(readFileTool!.description, /exact requested source range/);
    assert.match(readFileTool!.description, /raw multiline source/);

    const properties = readFileTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.match(String(properties.open_symbol?.description ?? ''), /bounded symbol source/);
    assert.match(String(properties.open_symbol?.description ?? ''), /continuation-aware excerpts/);
});

test('manage_index schema does not expose deprecated splitter knob', () => {
    const tools = getMcpToolList(buildContext());
    const manageIndexTool = tools.find((tool) => tool.name === 'manage_index');
    assert.ok(manageIndexTool);

    const properties = manageIndexTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.equal(Object.prototype.hasOwnProperty.call(properties, 'splitter'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties, 'allowUnnecessaryReindex'), true);
    assert.deepEqual(properties.detail.enum, ['summary', 'capabilities', 'diagnostics', 'full']);
});

test('file_outline schema exposes path/file and line window controls', () => {
    const tools = getMcpToolList(buildContext());
    const fileOutlineTool = tools.find((tool) => tool.name === 'file_outline');
    assert.ok(fileOutlineTool);
    assert.match(fileOutlineTool!.description, /Python or Go structural metrics/i);

    const properties = fileOutlineTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.ok(properties.path);
    assert.ok(properties.file);
    assert.ok(properties.start_line);
    assert.ok(properties.end_line);
    assert.ok(properties.limitSymbols);
    assert.ok(properties.resolveMode);
    assert.ok(properties.symbolIdExact);
    assert.ok(properties.symbolLabelExact);
    assert.equal(properties.limitSymbols.default, 500);
    assert.equal(properties.resolveMode.default, 'outline');

    const required = fileOutlineTool!.inputSchema.required as string[];
    assert.deepEqual(required, ['path', 'file']);
});

test('call_graph schema exposes symbolRef, direction, depth, and limit controls', () => {
    const tools = getMcpToolList(buildContext());
    const callGraphTool = tools.find((tool) => tool.name === 'call_graph');
    assert.ok(callGraphTool);

    const properties = callGraphTool!.inputSchema.properties as Record<string, SchemaProperty>;
    assert.ok(properties.path);
    assert.ok(properties.symbolRef);
    assert.ok(properties.direction);
    assert.ok(properties.depth);
    assert.ok(properties.limit);
    assert.equal(properties.direction.default, 'both');
    assert.equal(properties.depth.default, 1);
    assert.equal(properties.limit.default, 20);
});

test('getMcpToolList matches uncached buildMcpToolList across profiles and reuses frozen witness entries', () => {
    const connected = buildContext();
    const offline = buildContext({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: path.join(os.tmpdir(), 'satori-registry-lance'),
        encoderProvider: 'Potion',
        encoderModel: 'potion',
        encoderOutputDimension: 256,
        rerankerProvider: 'lateon',
        lateOnModelPath: path.join(os.tmpdir(), 'satori-registry-lateon'),
    });

    const connectedFirst = getMcpToolList(connected);
    const connectedSecond = getMcpToolList(connected);
    const offlineFirst = getMcpToolList(offline);

    assert.deepEqual(connectedFirst, buildMcpToolList(connected));
    assert.deepEqual(offlineFirst, buildMcpToolList(offline));
    assert.notEqual(connectedFirst, connectedSecond, 'callers receive a fresh array wrapper');
    assert.equal(connectedFirst[0], connectedSecond[0], 'repeat calls for the same CapabilityResolver reuse cached tool entries');
    assert.equal(Object.isFrozen(connectedFirst[0]), true);
    assert.equal(Object.isFrozen(connectedFirst[0].inputSchema), true);
    assert.notEqual(connectedFirst[0], offlineFirst[0], 'distinct CapabilityResolver instances maintain separate cache entries');
});

test('getMcpToolList falls back to uncached build when capabilities witness is not a frozen CapabilityResolver', () => {
    const customCaps = {
        getMaxSearchResultTotal: () => 42,
        getDefaultSearchLimit: (mode: 'grouped' | 'raw' = 'grouped') => (mode === 'raw' ? 5 : 17),
        getMaxSearchPageSize: () => 19,
        getMaxFrozenSearchResults: () => 23,
    };
    const stubCtx = { capabilities: customCaps } as unknown as ToolContext;
    const first = getMcpToolList(stubCtx);
    const second = getMcpToolList(stubCtx);

    assert.deepEqual(first, buildMcpToolList(stubCtx));
    assert.notEqual(first[0], second[0]);
    const searchTool = first.find((tool) => tool.name === 'search_codebase')!;
    const searchProps = searchTool.inputSchema.properties as Record<string, SchemaProperty>;
    assert.equal(searchProps.limit.maximum, 42);
    assert.equal(searchProps.limit.default, 17);
    assert.equal(searchProps.disclosureLimit.maximum, 19);

    const continueTool = first.find((tool) => tool.name === 'continue_search')!;
    const continueProps = continueTool.inputSchema.properties as Record<string, SchemaProperty>;
    assert.equal(continueProps.expectedOffset.maximum, 23);
    assert.equal(continueProps.limit.maximum, 19);
});

test("CodeMode availability is applied after the capability advertisement cache", () => {
    const enabled = buildContext();
    const disabled = { ...enabled, codeMode: { enabled: false, configPath: undefined } };
    assert.equal(getMcpToolList(disabled).some((tool) => tool.name === "run_script"), false);
    assert.equal(getMcpToolList(enabled).some((tool) => tool.name === "run_script"), true);
    assert.equal(getMcpToolList(disabled).some((tool) => tool.name === "run_script"), false);
});
