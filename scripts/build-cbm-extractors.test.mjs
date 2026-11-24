import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as ts from 'typescript/ast';
import { API } from 'typescript/sync';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts/build-cbm-extractors.mjs');
const manifestPath = path.join(repoRoot, 'packages/core/assets/cbm-extractor/manifest.json');

function loadProductionPredicates() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const api = new API({ runExternalCode: false });
  try {
    const retained = api.createSourceFile(scriptPath, source, { scriptKind: ts.ScriptKind.JS });
    const sourceFile = retained.sourceFile;
    const requiredNames = new Set([
      'fail',
      'sha256',
      'findKnownFailure',
      'isMemoryFailureReason',
      'resolveInitialGlue',
      'writeFileAtomic',
    ]);
    const functions = new Map();
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && requiredNames.has(node.name.text)) {
        functions.set(node.name.text, source.slice(node.getStart(sourceFile), node.end));
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);

    assert.deepEqual([...functions.keys()].sort(), [...requiredNames].sort(), 'production predicates must remain available');
    const declarations = [...functions.values()].join('\n');
    return vm.runInNewContext(
      `(() => { ${declarations}\nreturn { fail, sha256, findKnownFailure, isMemoryFailureReason, resolveInitialGlue, writeFileAtomic }; })()`,
      {
        createHash,
        writeFileSync: fs.writeFileSync,
        renameSync: fs.renameSync,
        rmSync: fs.rmSync,
        process,
      },
    );
  } finally { api.close(); }
}

const { sha256, findKnownFailure, isMemoryFailureReason, resolveInitialGlue, writeFileAtomic } = loadProductionPredicates();

test('check mode accepts source-matched memory failures across budgets', () => {
  const recordedSixGigFailures = [
    { cbmLanguage: 'COBOL', satoriLanguageId: 'cobol', sourceSha256: 'a'.repeat(64), reason: 'exceeded the 6G build memory budget' },
    { cbmLanguage: 'ZSH', satoriLanguageId: 'zsh', sourceSha256: 'b'.repeat(64), reason: 'exceeded the 6G build memory budget' },
  ];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const failuresToCheck = manifest.failures.filter((entry) => entry.reason === 'exceeded the 6G build memory budget');
  const activeFailures = failuresToCheck.length > 0 ? failuresToCheck : recordedSixGigFailures;

  const threeGigFailure = 'exceeded the 3G build memory budget';
  for (const failure of activeFailures) {
    const row = { cbmLanguage: failure.cbmLanguage };
    assert.equal(
      findKnownFailure(activeFailures, row, failure.sourceSha256, threeGigFailure, true),
      failure,
    );
  }

  const failure = activeFailures[0];
  const staleSourceSha256 = `${failure.sourceSha256.slice(0, -1)}${failure.sourceSha256.endsWith('0') ? '1' : '0'}`;
  const row = { cbmLanguage: failure.cbmLanguage };
  assert.equal(findKnownFailure(activeFailures, row, staleSourceSha256, threeGigFailure, true), undefined);
  assert.equal(findKnownFailure(activeFailures, row, failure.sourceSha256, threeGigFailure, false), undefined);
  assert.equal(isMemoryFailureReason(failure.reason), true);
  assert.equal(isMemoryFailureReason('emcc failed: compiler error'), false);
});

test('resolveInitialGlue enforces strict --check while recovering from interrupted builds and uncached rebuilds', () => {
  const oldGlue = Buffer.from('old-glue');
  const staleGlue = Buffer.from('interrupted-glue');
  const oldManifest = {
    cbmCommit: '1111d9a9e1380a0429ef2250f63223706af6289a',
    glue: { file: 'cbm-extractor.js', sha256: sha256(oldGlue) },
  };

  // --check stays strict when disk glue differs from manifest
  assert.throws(
    () => resolveInitialGlue({
      checkOnly: true,
      oldManifest,
      diskGlue: staleGlue,
      commit: oldManifest.cbmCommit,
      hasReusableModule: true,
    }),
    /shipped glue differs from manifest/,
  );

  // Build mode recovers from interrupted build (glue != manifest) by resetting glue and disabling cache reuse
  const interrupted = resolveInitialGlue({
    checkOnly: false,
    oldManifest,
    diskGlue: staleGlue,
    commit: oldManifest.cbmCommit,
    hasReusableModule: true,
  });
  assert.equal(interrupted.glue, null);
  assert.equal(interrupted.canReuseCache, false);

  // Build mode resets glue when same commit has no reusable modules (e.g. sharedHash/compiler flags changed)
  const uncached = resolveInitialGlue({
    checkOnly: false,
    oldManifest,
    diskGlue: oldGlue,
    commit: oldManifest.cbmCommit,
    hasReusableModule: false,
  });
  assert.equal(uncached.glue, null);
  assert.equal(uncached.canReuseCache, false);

  // Build mode resets glue when pinned commit changed
  const repinned = resolveInitialGlue({
    checkOnly: false,
    oldManifest,
    diskGlue: oldGlue,
    commit: '2222d9a9e1380a0429ef2250f63223706af6289a',
    hasReusableModule: true,
  });
  assert.equal(repinned.glue, null);
  assert.equal(repinned.canReuseCache, false);

  // Build mode preserves glue and cache reuse when glue matches manifest and cached modules are reusable
  const reusable = resolveInitialGlue({
    checkOnly: false,
    oldManifest,
    diskGlue: oldGlue,
    commit: oldManifest.cbmCommit,
    hasReusableModule: true,
  });
  assert.equal(reusable.glue, oldGlue);
  assert.equal(reusable.canReuseCache, true);
});

test('writeFileAtomic replaces target cleanly without leaving temporary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-cbm-atomic-'));
  try {
    const target = path.join(dir, 'manifest.json');
    fs.writeFileSync(target, '{"old":true}\n');
    writeFileAtomic(target, '{"new":true}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"new":true}\n');
    assert.deepEqual(fs.readdirSync(dir), ['manifest.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
