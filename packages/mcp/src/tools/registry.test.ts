import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CapabilityResolver } from '../core/capabilities.js';
import { createSessionWorkspacePolicy } from '../core/session-workspace-policy.js';
import { ContextMcpConfig } from '../config.js';
import { getMcpToolList, toolRegistry } from './registry.js';
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

test('tool registry exposes the eight public tools', () => {
    const names = Object.keys(toolRegistry);
    assert.deepEqual(names, ['manage_index', 'search_codebase', 'continue_search', 'call_graph', 'detect_changes', 'file_outline', 'read_file', 'list_codebases']);
});

test('generated ListTools payload returns the eight tools', () => {
    const list = getMcpToolList(buildContext());
    const names = list.map((tool) => tool.name);

    assert.deepEqual(names, ['manage_index', 'search_codebase', 'continue_search', 'call_graph', 'detect_changes', 'file_outline', 'read_file', 'list_codebases']);
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
    assert.match(callGraphTool!.description, /Go, Java, C#, C\+\+, and Rust.*qualified direct-call/i);
    assert.match(callGraphTool!.description, /exclude receiver\/type-aware dispatch/i);
    assert.match(callGraphTool!.description, /Java and C#.*same detected build root/i);
    assert.match(callGraphTool!.description, /Maven\/Gradle.*\.csproj/i);
    assert.match(callGraphTool!.description, /C\+\+.*cross-translation-unit/i);
    assert.match(callGraphTool!.description, /Rust.*Cargo ownership/i);
    assert.match(callGraphTool!.description, /Python and Go.*testReferences/i);
    assert.match(callGraphTool!.description, /bounded/i);
    assert.match(callGraphTool!.description, /advisory/i);
    assert.match(callGraphTool!.description, /not authoritative blast-radius/i);
    assert.match(callGraphTool!.description, /not a compiler-grade call graph/i);
    assert.doesNotMatch(callGraphTool!.description, /TS\/JS\/Python/i);
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
    assert.equal(properties.limit.default, 20);
    assert.equal(properties.limit.maximum, Number.MAX_SAFE_INTEGER);
    assert.match(String(properties.limit.description), /grouped mode: total frozen result-set bound across continuation pages/i);
    assert.equal(properties.disclosureLimit.maximum, 200);
    assert.match(String(properties.disclosureLimit.description), /at most 10 results initially/i);
    assert.match(String(properties.limit.description), /raw mode: maximum returned chunk count/i);
    assert.match(String(properties.disclosureLimit.description), /limit=20 and disclosureLimit=6 returns up to 6 initially and freezes up to 20 total/i);
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
