import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Context } = require('../../packages/core/dist/context.js');

class DeterministicEmbedding {
  async detectDimension() {
    return 4;
  }

  async embed(text) {
    const lower = (text || '').toLowerCase();
    const vector = [
      /auth|token|login|session|credential|password|user/.test(lower) ? 1 : 0,
      /math|sum|add|subtract|multiply|number|calculate/.test(lower) ? 1 : 0,
      /file|path|index|search|sync|chunk/.test(lower) ? 1 : 0,
      Math.min(1, lower.length / 200),
    ];
    return { vector, dimension: 4 };
  }

  async embedBatch(texts) {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimension() {
    return 4;
  }

  getProvider() {
    return 'DeterministicTestEmbedding';
  }
}

class InMemoryVectorDatabase {
  constructor() {
    this.collections = new Map();
  }

  async createCollection(collectionName, dimension) {
    this.collections.set(collectionName, { dimension, docs: new Map() });
  }

  async createHybridCollection(collectionName, dimension) {
    return this.createCollection(collectionName, dimension);
  }

  async dropCollection(collectionName) {
    this.collections.delete(collectionName);
  }

  async hasCollection(collectionName) {
    return this.collections.has(collectionName);
  }

  async listCollections() {
    return Array.from(this.collections.keys());
  }

  async insert(collectionName, documents) {
    const collection = this.collections.get(collectionName);
    if (!collection) throw new Error(`Collection not found: ${collectionName}`);
    for (const doc of documents) {
      collection.docs.set(doc.id, doc);
    }
  }

  async insertHybrid(collectionName, documents) {
    return this.insert(collectionName, documents);
  }

  async search(collectionName, queryVector, options = {}) {
    const collection = this.collections.get(collectionName);
    if (!collection) return [];
    const threshold = options.threshold ?? 0;
    const topK = options.topK ?? 5;

    const ranked = Array.from(collection.docs.values())
      .map((document) => ({ document, score: cosineSimilarity(queryVector, document.vector) }))
      .filter((item) => item.score >= threshold)
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, topK);
  }

  async hybridSearch(collectionName, searchRequests, options = {}) {
    const dense = searchRequests.find((r) => Array.isArray(r.data));
    const queryVector = dense ? dense.data : [0, 0, 0, 0];
    return this.search(collectionName, queryVector, options);
  }

  async delete(collectionName, ids) {
    const collection = this.collections.get(collectionName);
    if (!collection) return;
    for (const id of ids) {
      collection.docs.delete(id);
    }
  }

  async query(collectionName, filter, outputFields, limit = 1000) {
    const collection = this.collections.get(collectionName);
    if (!collection) return [];
    let docs = Array.from(collection.docs.values());

    const match = /^relativePath == \"(.+)\"$/.exec(filter || '');
    if (match) {
      docs = docs.filter((doc) => doc.relativePath === match[1]);
    }

    const rows = docs.slice(0, limit).map((doc) => {
      const row = {};
      for (const field of outputFields) {
        row[field] = doc[field];
      }
      return row;
    });

    return rows;
  }

  async checkCollectionLimit() {
    return true;
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function createTestSplitter() {
  return {
    async split(code, language, filePath) {
      return [{
        content: code,
        metadata: {
          startLine: 1,
          endLine: code.split('\n').length,
          language,
          filePath,
        },
      }];
    },
    setChunkSize() {},
    setChunkOverlap() {},
  };
}

function createTempCodebase(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-integration-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }
  return root;
}

function createContext() {
  process.env.HYBRID_MODE = 'false';
  const vectorDatabase = new InMemoryVectorDatabase();
  const context = new Context({
    embedding: new DeterministicEmbedding(),
    vectorDatabase,
    codeSplitter: createTestSplitter(),
  });
  return { context };
}

test('integration: index_codebase persists searchable chunks', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    'src/index.ts': 'export const ping = () => "pong";',
  });

  try {
    const stats = await context.indexCodebase(codebasePath);
    assert.equal(stats.indexedFiles, 1);
    assert.equal(stats.totalChunks, 1);
    assert.equal(await context.hasIndexedCollection(codebasePath), true);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: semantic_search returns domain-relevant files', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    'src/auth.ts': 'export function issueToken(user: string) { return `token-${user}`; }',
    'src/math.ts': 'export const add = (a: number, b: number) => a + b;',
  });

  try {
    await context.indexCodebase(codebasePath);
    const results = await context.semanticSearch(codebasePath, 'login token authentication', 5, 0);
    assert.ok(results.length > 0);
    assert.equal(results[0].relativePath, 'src/auth.ts');
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: reindex_by_change tracks add/modify/remove deltas', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const version = 1;',
    'src/obsolete.ts': 'export const obsolete = true;',
  });

  try {
    await context.indexCodebase(codebasePath);

    const baseline = await context.reindexByChange(codebasePath);
    assert.deepEqual(baseline, { added: 0, removed: 0, modified: 0, changedFiles: [] });

    fs.writeFileSync(path.join(codebasePath, 'src/service.ts'), 'export const version = 2;', 'utf8');
    fs.rmSync(path.join(codebasePath, 'src/obsolete.ts'));
    fs.writeFileSync(path.join(codebasePath, 'src/new.ts'), 'export const featureFlag = true;', 'utf8');

    const delta = await context.reindexByChange(codebasePath);
    assert.deepEqual(delta, {
      added: 1,
      removed: 1,
      modified: 1,
      changedFiles: ['src/new.ts', 'src/obsolete.ts', 'src/service.ts'],
    });

    const results = await context.semanticSearch(codebasePath, 'feature flag', 5, 0);
    assert.ok(results.some((result) => result.relativePath === 'src/new.ts'));
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: ignore negation patterns keep explicitly unignored files indexable', async () => {
  const { context } = createContext();
  context.addCustomIgnorePatterns(['generated/**', '!generated/keep.ts']);

  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const main = true;',
    'generated/drop.ts': 'export const dropped = true;',
    'generated/keep.ts': 'export const kept = true;',
  });

  try {
    const stats = await context.indexCodebase(codebasePath);
    assert.equal(stats.indexedFiles, 2);

    const keptResults = await context.semanticSearch(codebasePath, 'kept', 10, 0);
    assert.ok(keptResults.some((r) => r.relativePath === 'generated/keep.ts'));
    assert.ok(!keptResults.some((r) => r.relativePath === 'generated/drop.ts'));
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: reindex_by_change ignores excluded files but tracks unignored negation files', async () => {
  const { context } = createContext();
  context.addCustomIgnorePatterns(['generated/**', '!generated/keep.ts']);

  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const main = true;',
    'generated/drop.ts': 'export const dropped = true;',
    'generated/keep.ts': 'export const kept = 1;',
  });

  try {
    await context.indexCodebase(codebasePath);

    fs.writeFileSync(path.join(codebasePath, 'generated/drop.ts'), 'export const dropped = false;', 'utf8');
    const ignoredOnlyDelta = await context.reindexByChange(codebasePath);
    assert.deepEqual(ignoredOnlyDelta, { added: 0, removed: 0, modified: 0, changedFiles: [] });

    fs.writeFileSync(path.join(codebasePath, 'generated/keep.ts'), 'export const kept = 2;', 'utf8');
    const negatedDelta = await context.reindexByChange(codebasePath);
    assert.deepEqual(negatedDelta, { added: 0, removed: 0, modified: 1, changedFiles: ['generated/keep.ts'] });
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});
