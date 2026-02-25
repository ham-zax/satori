import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityResolver } from '../core/capabilities.js';
import { ContextMcpConfig } from '../config.js';
import { getMcpToolList, toolRegistry } from './registry.js';
import { ToolContext } from './types.js';

function buildConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
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
    } as ToolContext;
}

test('tool registry exposes exactly five public tools', () => {
    const names = Object.keys(toolRegistry);
    assert.deepEqual(names, ['manage_index', 'search_codebase', 'call_graph', 'read_file', 'list_codebases']);
});

test('generated ListTools payload returns exactly five tools', () => {
    const list = getMcpToolList(buildContext());
    const names = list.map((tool) => tool.name);

    assert.deepEqual(names, ['manage_index', 'search_codebase', 'call_graph', 'read_file', 'list_codebases']);
});

test('search_codebase schema exposes scoped grouped/raw controls', () => {
    const tools = getMcpToolList(buildContext());
    const searchTool = tools.find((tool) => tool.name === 'search_codebase');
    assert.ok(searchTool);

    const properties = searchTool!.inputSchema.properties as Record<string, any>;
    assert.ok(properties.scope);
    assert.ok(properties.resultMode);
    assert.ok(properties.groupBy);
    assert.ok(properties.debug);
    assert.equal(properties.scope.default, 'runtime');
    assert.equal(properties.resultMode.default, 'grouped');
    assert.equal(properties.groupBy.default, 'symbol');

    const required = searchTool!.inputSchema.required as string[];
    assert.ok(required.includes('path'));
    assert.ok(required.includes('query'));
});

test('read_file schema includes optional start_line and end_line parameters', () => {
    const tools = getMcpToolList(buildContext());
    const readFileTool = tools.find((tool) => tool.name === 'read_file');
    assert.ok(readFileTool);

    const properties = readFileTool!.inputSchema.properties as Record<string, any>;
    assert.ok(properties.path);
    assert.ok(properties.start_line);
    assert.ok(properties.end_line);

    const required = readFileTool!.inputSchema.required as string[];
    assert.deepEqual(required, ['path']);
    assert.equal(Object.prototype.hasOwnProperty.call(properties.start_line, 'default'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties.end_line, 'default'), false);
});

test('call_graph schema exposes symbolRef, direction, depth, and limit controls', () => {
    const tools = getMcpToolList(buildContext());
    const callGraphTool = tools.find((tool) => tool.name === 'call_graph');
    assert.ok(callGraphTool);

    const properties = callGraphTool!.inputSchema.properties as Record<string, any>;
    assert.ok(properties.path);
    assert.ok(properties.symbolRef);
    assert.ok(properties.direction);
    assert.ok(properties.depth);
    assert.ok(properties.limit);
    assert.equal(properties.direction.default, 'both');
    assert.equal(properties.depth.default, 1);
    assert.equal(properties.limit.default, 20);
});
