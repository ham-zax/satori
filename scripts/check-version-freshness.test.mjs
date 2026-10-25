import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkSharedContractOwnership,
  checkVersionFreshness,
  findSharedContractOwnershipViolations,
  findStalePackageVersionReferences,
  parsePackageVersions
} from './check-version-freshness.mjs';

test('findStalePackageVersionReferences ignores tests and flags stale docs/config references', () => {
  const files = new Map([
    ['README.md', 'Use @satori-code/mcp@4.6.0 here'],
    ['packages/mcp/src/config.ts', 'npx -y @satori-code/mcp@4.8.0'],
    ['packages/mcp/src/cli/index.test.ts', 'fixture @satori-code/mcp@4.4.1'],
  ]);

  const findings = findStalePackageVersionReferences(files, {
    '@satori-code/mcp': '4.8.0',
  });

  assert.deepEqual(findings, [{
    filePath: 'README.md',
    packageName: '@satori-code/mcp',
    foundVersion: '4.6.0',
    expectedVersion: '4.8.0',
  }]);
});

test('parsePackageVersions returns publishable package versions', () => {
  const versions = parsePackageVersions(new Map([
    ['packages/core/package.json', JSON.stringify({ name: '@satori-code/core', version: '1.5.0' })],
    ['packages/mcp/package.json', JSON.stringify({ name: '@satori-code/mcp', version: '4.8.0' })],
    ['package.json', JSON.stringify({ name: 'satori', version: '0.4.0', private: true })],
  ]));

  assert.deepEqual(versions, {
    '@satori-code/core': '1.5.0',
    '@satori-code/mcp': '4.8.0',
  });
});

test('checkVersionFreshness scans generated package version references', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-version-freshness-'));
  try {
    for (const dir of [
      'packages/core',
      'packages/mcp/src',
      'packages/cli',
    ]) {
      fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(cwd, 'packages/core/package.json'), JSON.stringify({ name: '@satori-code/core', version: '1.5.0' }));
    fs.writeFileSync(path.join(cwd, 'packages/mcp/package.json'), JSON.stringify({ name: '@satori-code/mcp', version: '4.8.0' }));
    fs.writeFileSync(path.join(cwd, 'packages/cli/package.json'), JSON.stringify({ name: '@satori-code/cli', version: '0.2.0' }));
    fs.writeFileSync(path.join(cwd, 'README.md'), '');
    fs.writeFileSync(path.join(cwd, 'packages/mcp/README.md'), '');
    fs.writeFileSync(path.join(cwd, 'packages/cli/README.md'), '');
    fs.writeFileSync(path.join(cwd, 'packages/mcp/src/config.ts'), '');
    fs.writeFileSync(path.join(cwd, 'server.json'), '@satori-code/mcp@4.7.0');
    assert.deepEqual(checkVersionFreshness({ cwd }), [
      {
        filePath: 'server.json',
        packageName: '@satori-code/mcp',
        foundVersion: '4.7.0',
        expectedVersion: '4.8.0',
      },
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

const CANONICAL_RUNTIME_CONTRACT = [
  "export const EMBEDDING_PROJECTION_VERSION = 'embedding_projection_v3' as const;",
  "export const LEXICAL_PROJECTION_VERSION = 'lexical_projection_v2' as const;",
  "export const POTION_MODEL_ID = 'minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b';",
  'export const POTION_DIMENSION = 256;',
].join('\n');

function writeSharedContractLayout(cwd, overrides = {}) {
  const files = {
    'packages/core/src/runtime-contract.ts': CANONICAL_RUNTIME_CONTRACT,
    'packages/core/src/core/search-projections.ts': [
      "import { EMBEDDING_PROJECTION_VERSION, LEXICAL_PROJECTION_VERSION } from '../runtime-contract';",
      'export { EMBEDDING_PROJECTION_VERSION, LEXICAL_PROJECTION_VERSION };',
    ].join('\n'),
    'packages/core/src/embedding/potion-embedding.ts': [
      "import { POTION_DIMENSION, POTION_MODEL_ID } from '../runtime-contract';",
      'export { POTION_DIMENSION, POTION_MODEL_ID };',
    ].join('\n'),
    'packages/cli/src/local-runtime-contract.ts': [
      'export {',
      '    EMBEDDING_PROJECTION_VERSION,',
      '    LEXICAL_PROJECTION_VERSION,',
      '    POTION_DIMENSION,',
      '    POTION_MODEL_ID,',
      '} from "./runtime-identities.cjs";',
    ].join('\n'),
    ...overrides,
  };
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(cwd, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
}

test('checkSharedContractOwnership accepts the real canonical repository layout', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  assert.deepEqual(checkSharedContractOwnership({ cwd: repositoryRoot }), []);
});

test('checkSharedContractOwnership accepts a canonical layout without duplicate declarations', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-shared-contract-'));
  try {
    writeSharedContractLayout(cwd);
    assert.deepEqual(checkSharedContractOwnership({ cwd }), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkSharedContractOwnership rejects duplicate authoritative declarations in former owners', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-shared-contract-'));
  try {
    writeSharedContractLayout(cwd, {
      'packages/core/src/core/search-projections.ts': "export const LEXICAL_PROJECTION_VERSION = 'lexical_projection_v2' as const;",
      'packages/core/src/embedding/potion-embedding.ts': "export const POTION_MODEL_ID = 'minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b';",
      'packages/cli/src/local-runtime-contract.ts': 'export const POTION_DIMENSION = 256;',
    });

    assert.deepEqual(checkSharedContractOwnership({ cwd }), [
      { filePath: 'packages/core/src/core/search-projections.ts', name: 'LEXICAL_PROJECTION_VERSION' },
      { filePath: 'packages/core/src/embedding/potion-embedding.ts', name: 'POTION_MODEL_ID' },
      { filePath: 'packages/cli/src/local-runtime-contract.ts', name: 'POTION_DIMENSION' },
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkSharedContractOwnership allows unrelated version declarations', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-shared-contract-'));
  try {
    writeSharedContractLayout(cwd, {
      'packages/core/src/embedding/potion-embedding.ts': [
        "import { POTION_DIMENSION, POTION_MODEL_ID } from '../runtime-contract';",
        "export const POTION_SEMANTIC_VERSION = 'potion_semantics_v1';",
        'export const EMBEDDING_NORMALIZATION_POLICY_VERSION = 1;',
      ].join('\n'),
    });
    assert.deepEqual(checkSharedContractOwnership({ cwd }), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkSharedContractOwnership fails clearly when an expected source file is missing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-shared-contract-'));
  try {
    writeSharedContractLayout(cwd);
    fs.rmSync(path.join(cwd, 'packages/core/src/core/search-projections.ts'));
    assert.throws(
      () => checkSharedContractOwnership({ cwd }),
      /Missing expected source file for shared runtime contract ownership check: packages\/core\/src\/core\/search-projections\.ts/,
    );
    assert.throws(
      () => findSharedContractOwnershipViolations(new Map()),
      /Missing expected source file for shared runtime contract ownership check/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
