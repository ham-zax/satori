import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Context } = require('../../packages/core/dist/context.js');
const {
  FileSynchronizer,
  RemoteCollectionDeletePendingError,
  deleteCollectionWithVerification
} = require('../../packages/core/dist/index.js');

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

  filterDocuments(documents, filterExpr) {
    let filtered = documents;
    if ((filterExpr || '').includes('fileExtension != ".satori_meta"')) {
      filtered = filtered.filter((doc) => doc.fileExtension !== '.satori_meta');
    }
    const idMatch = /^id == \"(.+)\"$/.exec(filterExpr || '');
    if (idMatch) {
      filtered = filtered.filter((doc) => doc.id === idMatch[1]);
    }
    const relativePathMatch = /^relativePath == \"(.+)\"$/.exec(filterExpr || '');
    if (relativePathMatch) {
      filtered = filtered.filter((doc) => doc.relativePath === relativePathMatch[1]);
    }
    return filtered;
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

    const ranked = this.filterDocuments(Array.from(collection.docs.values()), options.filterExpr)
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
    const docs = this.filterDocuments(Array.from(collection.docs.values()), filter);

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
  const options = arguments[0] || {};
  process.env.HYBRID_MODE = options.hybridMode ? 'true' : 'false';
  const vectorDatabase = options.vectorDatabase || new InMemoryVectorDatabase();
  const context = new Context({
    embedding: new DeterministicEmbedding(),
    vectorDatabase,
  });
  return { context, vectorDatabase };
}

class FailingInsertVectorDatabase extends InMemoryVectorDatabase {
  async insert() {
    throw new Error('Synthetic insert failure');
  }

  async insertHybrid() {
    throw new Error('Synthetic insert failure');
  }
}

class DeadlineAfterDeleteVectorDatabase extends InMemoryVectorDatabase {
  async dropCollection(collectionName) {
    this.collections.delete(collectionName);
    throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
  }
}

class PersistentDeadlineVectorDatabase extends InMemoryVectorDatabase {
  async dropCollection() {
    throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
  }
}

class IndeterminateDeadlineVectorDatabase extends InMemoryVectorDatabase {
  constructor() {
    super();
    this.failNextCollectionProbe = false;
  }

  async dropCollection() {
    this.failNextCollectionProbe = true;
    throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
  }

  async hasCollection(collectionName) {
    if (this.failNextCollectionProbe) {
      this.failNextCollectionProbe = false;
      throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
    }
    return super.hasCollection(collectionName);
  }
}

class RetryThenDeleteVectorDatabase extends InMemoryVectorDatabase {
  constructor() {
    super();
    this.dropAttempts = 0;
  }

  async dropCollection(collectionName) {
    this.dropAttempts += 1;
    if (this.dropAttempts < 3) {
      throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
    }
    this.collections.delete(collectionName);
  }
}

class SuccessfulNoopDropVectorDatabase extends InMemoryVectorDatabase {
  async dropCollection() {
    // Simulates an acknowledged drop RPC that did not remove the remote collection.
  }
}

test('integration: index_codebase persists searchable chunks', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    'src/index.ts': 'export const ping = () => "pong";',
  });

  try {
    const stats = await context.indexCodebase(codebasePath);
    assert.equal(stats.indexedFiles, 1);
    assert.ok(stats.totalChunks > 0);
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
    const results = await context.semanticSearch({
      codebasePath,
      query: 'login token authentication',
      topK: 5,
      scorePolicy: { kind: 'topk_only' },
    });
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
    assert.equal(baseline.added, 0);
    assert.equal(baseline.removed, 0);
    assert.equal(baseline.modified, 0);
    assert.deepEqual(baseline.changedFiles, []);

    fs.writeFileSync(path.join(codebasePath, 'src/service.ts'), 'export const version = 2;', 'utf8');
    fs.rmSync(path.join(codebasePath, 'src/obsolete.ts'));
    fs.writeFileSync(path.join(codebasePath, 'src/new.ts'), 'export const featureFlag = true;', 'utf8');

    const delta = await context.reindexByChange(codebasePath);
    assert.equal(delta.added, 1);
    assert.equal(delta.removed, 1);
    assert.equal(delta.modified, 1);
    assert.deepEqual(delta.changedFiles, ['src/new.ts', 'src/obsolete.ts', 'src/service.ts']);

    const results = await context.semanticSearch({
      codebasePath,
      query: 'feature flag',
      topK: 5,
      scorePolicy: { kind: 'topk_only' },
    });
    assert.ok(results.some((result) => result.relativePath === 'src/new.ts'));
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex resets sync state so reindex_by_change rebuilds a missing collection', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    await context.clearIndex(codebasePath);
    assert.equal(await context.hasIndexedCollection(codebasePath), false);

    const delta = await context.reindexByChange(codebasePath);
    assert.equal(delta.added, 1);
    assert.equal(delta.removed, 0);
    assert.equal(delta.modified, 0);
    assert.deepEqual(delta.changedFiles, ['src/service.ts']);

    assert.equal(await context.hasIndexedCollection(codebasePath), true);
    const results = await context.semanticSearch({
      codebasePath,
      query: 'service ready',
      topK: 5,
      scorePolicy: { kind: 'topk_only' },
    });
    assert.ok(results.some((result) => result.relativePath === 'src/service.ts'));
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex treats drop timeout as success only when collection is absent after verification', async () => {
  const { context } = createContext({
    vectorDatabase: new DeadlineAfterDeleteVectorDatabase(),
  });
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    await context.clearIndex(codebasePath);
    assert.equal(await context.hasIndexedCollection(codebasePath), false);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex retries timed-out remote drops until verified absent', async () => {
  const vectorDatabase = new RetryThenDeleteVectorDatabase();
  const { context } = createContext({
    vectorDatabase,
  });
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    await context.clearIndex(codebasePath);
    assert.equal(vectorDatabase.dropAttempts, 3);
    assert.equal(await context.hasIndexedCollection(codebasePath), false);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex rejects successful drop calls that leave collection present', async () => {
  const { context } = createContext({
    vectorDatabase: new SuccessfulNoopDropVectorDatabase(),
  });
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    await assert.rejects(
      () => context.clearIndex(codebasePath),
      /Remote collection deletion did not complete/
    );
    assert.equal(await context.hasIndexedCollection(codebasePath), true);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex preserves local state when drop timeout leaves collection present', async () => {
  const { context } = createContext({
    vectorDatabase: new PersistentDeadlineVectorDatabase(),
  });
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    await assert.rejects(
      () => context.clearIndex(codebasePath),
      /DEADLINE_EXCEEDED/
    );
    assert.equal(await context.hasIndexedCollection(codebasePath), true);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex preserves local state when drop timeout leaves remote state indeterminate', async () => {
  const { context } = createContext({
    vectorDatabase: new IndeterminateDeadlineVectorDatabase(),
  });
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    await assert.rejects(
      () => context.clearIndex(codebasePath),
      /DEADLINE_EXCEEDED/
    );
    assert.equal(await context.hasIndexedCollection(codebasePath), true);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: clearIndex removes local sync state when remote collection is already absent', async () => {
  const { context, vectorDatabase } = createContext();
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
  });

  try {
    await context.indexCodebase(codebasePath);
    const baseline = await context.reindexByChange(codebasePath);
    assert.equal(baseline.added, 0);
    assert.equal(baseline.removed, 0);
    assert.equal(baseline.modified, 0);
    assert.deepEqual(baseline.changedFiles, []);

    const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(codebasePath);
    assert.equal(fs.existsSync(snapshotPath), true);

    await vectorDatabase.dropCollection(context.resolveCollectionName(codebasePath));
    await context.clearIndex(codebasePath);

    assert.equal(await context.hasIndexedCollection(codebasePath), false);
    assert.equal(fs.existsSync(snapshotPath), false);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: verified collection deletion reports latest successful-drop pending state', async () => {
  let dropAttempts = 0;
  const vectorDatabase = {
    async hasCollection() {
      return true;
    },
    async dropCollection() {
      dropAttempts += 1;
      if (dropAttempts === 1) {
        throw new Error('first timeout');
      }
    }
  };

  await assert.rejects(
    () => deleteCollectionWithVerification(vectorDatabase, 'hybrid_code_chunks_pending', {
      maxAttempts: 2,
      initialBackoffMs: 0,
      sleep: async () => undefined
    }),
    (error) => {
      assert.ok(error instanceof RemoteCollectionDeletePendingError);
      assert.match(error.message, /dropCollection returned successfully but 'hybrid_code_chunks_pending' still exists/);
      assert.doesNotMatch(error.message, /first timeout/);
      return true;
    }
  );
});

test('integration: index_codebase rejects when chunk persistence fails', async () => {
  const { context } = createContext({
    vectorDatabase: new FailingInsertVectorDatabase(),
  });
  const codebasePath = createTempCodebase({
    'src/index.ts': 'export const ping = () => "pong";',
  });

  try {
    await assert.rejects(
      () => context.indexCodebase(codebasePath),
      /Synthetic insert failure/,
    );
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: semantic_search applies threshold in hybrid mode', async () => {
  const { context } = createContext({ hybridMode: true });
  const codebasePath = createTempCodebase({
    'src/auth.ts': 'export function issueToken(user) { return `token-${user}`; }',
    'src/math.ts': 'export const add = (a, b) => a + b;',
  });

  try {
    await context.indexCodebase(codebasePath);
    const results = await context.semanticSearch({
      codebasePath,
      query: 'login token auth',
      topK: 5,
      retrievalMode: 'dense',
      scorePolicy: { kind: 'dense_similarity_min', min: 0.5 },
    });
    assert.deepEqual(results.map((result) => result.relativePath), ['src/auth.ts']);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: ignore negation patterns keep explicitly unignored files indexable', async () => {
  const { context } = createContext();

  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const main = true;',
    'generated/drop.ts': 'export const dropped = true;',
    'generated/keep.ts': 'export const kept = true;',
  });

  try {
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
      customIgnorePatterns: ['generated/**', '!generated/keep.ts'],
    });
    const stats = await context.indexCodebase(codebasePath, undefined, false, { indexPolicy: policy });
    context.publishResolvedIndexPolicy(policy, {
      collectionName: context.resolveCollectionName(codebasePath),
      navigationGenerationId: stats.navigationCandidate?.generationId,
    });
    assert.equal(stats.indexedFiles, 2);

    const keptResults = await context.semanticSearch({
      codebasePath,
      query: 'kept',
      topK: 10,
      scorePolicy: { kind: 'topk_only' },
    });
    assert.ok(
      keptResults.some((r) => r.relativePath === 'generated/keep.ts'),
      `expected generated/keep.ts in ${JSON.stringify(keptResults.map((result) => result.relativePath))}`,
    );
    assert.ok(!keptResults.some((r) => r.relativePath === 'generated/drop.ts'));
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: reindex_by_change ignores excluded files but tracks unignored negation files', async () => {
  const { context } = createContext();

  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const main = true;',
    'generated/drop.ts': 'export const dropped = true;',
    'generated/keep.ts': 'export const kept = 1;',
  });

  try {
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
      customIgnorePatterns: ['generated/**', '!generated/keep.ts'],
    });
    const stats = await context.indexCodebase(codebasePath, undefined, false, { indexPolicy: policy });
    context.publishResolvedIndexPolicy(policy, {
      collectionName: context.resolveCollectionName(codebasePath),
      navigationGenerationId: stats.navigationCandidate?.generationId,
    });

    fs.writeFileSync(path.join(codebasePath, 'generated/drop.ts'), 'export const dropped = false;', 'utf8');
    const ignoredOnlyDelta = await context.reindexByChange(codebasePath);
    assert.equal(ignoredOnlyDelta.added, 0);
    assert.equal(ignoredOnlyDelta.removed, 0);
    assert.equal(ignoredOnlyDelta.modified, 0);
    assert.deepEqual(ignoredOnlyDelta.changedFiles, []);

    fs.writeFileSync(path.join(codebasePath, 'generated/keep.ts'), 'export const kept = 2;', 'utf8');
    const negatedDelta = await context.reindexByChange(codebasePath);
    assert.equal(negatedDelta.added, 0);
    assert.equal(negatedDelta.removed, 0);
    assert.equal(negatedDelta.modified, 1);
    assert.deepEqual(negatedDelta.changedFiles, ['generated/keep.ts']);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: reindex_by_change tracks safe-broad text and config file changes', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const service = "ready";',
    'notes.txt': 'initial note',
  });

  try {
    await context.indexCodebase(codebasePath);

    const baseline = await context.reindexByChange(codebasePath);
    assert.equal(baseline.added, 0);
    assert.equal(baseline.removed, 0);
    assert.equal(baseline.modified, 0);
    assert.deepEqual(baseline.changedFiles, []);

    fs.writeFileSync(path.join(codebasePath, 'notes.txt'), 'updated note', 'utf8');
    fs.writeFileSync(path.join(codebasePath, 'data.json'), '{"ok":true}', 'utf8');

    const delta = await context.reindexByChange(codebasePath);
    assert.equal(delta.added, 1);
    assert.equal(delta.removed, 0);
    assert.equal(delta.modified, 1);
    assert.deepEqual(delta.changedFiles, ['data.json', 'notes.txt']);

    const results = await context.semanticSearch({
      codebasePath,
      query: 'updated note ok',
      topK: 10,
      scorePolicy: { kind: 'topk_only' },
    });
    assert.ok(results.some((r) => r.relativePath === 'notes.txt'));
    assert.ok(results.some((r) => r.relativePath === 'data.json'));
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});

test('integration: hidden supported files stay synchronized when not ignored', async () => {
  const { context } = createContext();
  const codebasePath = createTempCodebase({
    '.hidden/runtime.ts': 'export const hiddenRuntime = "first";',
  });

  try {
    const stats = await context.indexCodebase(codebasePath);
    assert.equal(stats.indexedFiles, 1);

    const firstResults = await context.semanticSearch({
      codebasePath,
      query: 'hiddenRuntime first',
      topK: 10,
      scorePolicy: { kind: 'topk_only' },
    });
    assert.ok(firstResults.some((r) => r.relativePath === '.hidden/runtime.ts'));

    const baseline = await context.reindexByChange(codebasePath);
    assert.equal(baseline.added, 0);
    assert.equal(baseline.removed, 0);
    assert.equal(baseline.modified, 0);
    assert.deepEqual(baseline.changedFiles, []);

    fs.writeFileSync(
      path.join(codebasePath, '.hidden/runtime.ts'),
      'export const hiddenRuntime = "second";',
      'utf8',
    );

    const delta = await context.reindexByChange(codebasePath);
    assert.equal(delta.added, 0);
    assert.equal(delta.removed, 0);
    assert.equal(delta.modified, 1);
    assert.deepEqual(delta.changedFiles, ['.hidden/runtime.ts']);
  } finally {
    fs.rmSync(codebasePath, { recursive: true, force: true });
  }
});
