import fs from "node:fs";
import path from "node:path";
import { ContextMcpConfig } from "../src/config.js";
import { CapabilityResolver } from "../src/core/capabilities.js";
import { getMcpToolList } from "../src/tools/registry.js";
import { ToolContext } from "../src/tools/types.js";

const START_MARKER = '<!-- TOOLS_START -->';
const END_MARKER = '<!-- TOOLS_END -->';

function getTypeLabel(schema: any): string {
    if (!schema) return 'unknown';
    let alternatives: any[] | null = null;
    if (Array.isArray(schema.anyOf)) alternatives = schema.anyOf;
    else if (Array.isArray(schema.oneOf)) alternatives = schema.oneOf;
    if (alternatives) {
        return [...new Set(alternatives.map((alternative: any) => getTypeLabel(alternative)))]
            .join(' | ');
    }
    if (Array.isArray(schema.enum)) {
        return `enum(${schema.enum.map((v: any) => JSON.stringify(v)).join(', ')})`;
    }
    if (schema.type === 'array') {
        const itemType = getTypeLabel(schema.items);
        return `array<${itemType}>`;
    }
    if (Array.isArray(schema.type)) {
        return schema.type.join(' | ');
    }
    if (typeof schema.type === 'string') {
        return schema.type;
    }
    return 'unknown';
}

function esc(value: unknown): string {
    return String(value).replace(/\|/g, '\\|');
}

function buildToolDocsSection(): string {
    const config: ContextMcpConfig = {
        name: 'Satori MCP Server',
        version: '1.0.0',
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
    lines.push('## Tool Reference');
    lines.push('');

    for (const tool of tools) {
        lines.push(`### \`${tool.name}\``);
        lines.push('');
        lines.push(tool.description);
        lines.push('');

        const properties = tool.inputSchema?.properties || {};
        const required = new Set<string>(tool.inputSchema?.required || []);
        const entries = Object.entries(properties);

        if (entries.length === 0) {
            lines.push('No parameters.');
            lines.push('');
            continue;
        }

        lines.push('| Parameter | Type | Required | Default | Description |');
        lines.push('|---|---|---|---|---|');
        for (const [key, schema] of entries) {
            const propSchema = schema as any;
            const type = esc(getTypeLabel(propSchema));
            const isRequired = required.has(key) ? 'yes' : 'no';
            const defaultValue = propSchema.default === undefined ? '' : `\`${esc(JSON.stringify(propSchema.default))}\``;
            const description = esc(propSchema.description || '');
            lines.push(`| \`${esc(key)}\` | ${type} | ${isRequired} | ${defaultValue} | ${description} |`);
        }
        lines.push('');
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
