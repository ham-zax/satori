import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRegistry } from '../symbols/registry';
import { mergeTypeScriptShardEvidence } from './typescript-resolution-shards';
import { TypeScriptSemanticProjectAnalyzer } from './typescript-semantic-analyzer';

const COMPILER_OPTIONS = { module: 'commonjs', target: 'ES2022', strict: true, types: [] };

function registryFor(root: string, files: readonly string[]) {
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root,
            rootFingerprint: 'root-fingerprint',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router-v1',
            extractorVersion: 'extractor-v1',
            relationshipVersion: 'relationships-v1',
            builtAt: '2026-09-28T00:00:00.000Z',
            files: files.map((file) => ({
                path: file,
                hash: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
                language: 'typescript',
                symbolCount: 0,
                definitionStatus: 'definitions_present' as const,
            })),
        },
        symbols: [],
    });
}

// A sync runs in a new process, so its analyzer starts empty; only the state
// persisted by the previous analysis can keep the delta small.
test('a fresh analyzer resumes a delta from persisted state, sharded or not', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-state-')));
    const files = ['one/src/a.ts', 'one/src/b.ts', 'two/src/c.ts', 'two/src/d.ts'];
    const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    try {
        for (const project of ['one', 'two']) {
            write(`${project}/tsconfig.json`, JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src'] }));
        }
        write('one/src/a.ts', 'export function a(): number {\n    return 1;\n}\n');
        write('one/src/b.ts', 'import { a } from "./a";\nexport const b = a();\n');
        write('two/src/c.ts', 'export function c(): number {\n    return 3;\n}\n');
        write('two/src/d.ts', 'export const d = 4;\n');
        const before = registryFor(root, files);

        for (const shardCount of [1, 2]) {
            const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
            const analyzers = () => Array.from({ length: shardCount }, (_, index) => (
                new TypeScriptSemanticProjectAnalyzer(4, undefined, 0, {
                    stateDirectory,
                    ...(shardCount > 1 ? { shard: { index, count: shardCount } } : {}),
                })
            ));
            const analyze = async (input: Parameters<TypeScriptSemanticProjectAnalyzer['analyze']>[0]) => {
                const shards = analyzers();
                try {
                    return mergeTypeScriptShardEvidence(await Promise.all(shards.map((shard) => shard.analyzeShard(input))));
                } finally {
                    await Promise.all(shards.map((shard) => shard.dispose()));
                }
            };

            await analyze({ rootPath: root, language: 'typescript', registry: before });
            write('two/src/c.ts', 'export function c(): number {\n    return 30;\n}\n');
            const after = registryFor(root, files);
            const delta = await analyze({
                rootPath: root,
                language: 'typescript',
                registry: after,
                previousRegistry: before,
                changedFiles: new Set(['two/src/c.ts']),
            });
            assert.deepEqual([...delta.affectedSourceFiles ?? []].sort(), ['two/src/c.ts'], `${shardCount} shard(s)`);
            write('two/src/c.ts', 'export function c(): number {\n    return 3;\n}\n');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
