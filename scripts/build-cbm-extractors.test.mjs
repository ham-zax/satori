import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    const requiredNames = new Set(['findKnownFailure', 'isMemoryFailureReason']);
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
    return vm.runInNewContext(`(() => { ${declarations}\nreturn { findKnownFailure, isMemoryFailureReason }; })()`);
  } finally { api.close(); }
}

const { findKnownFailure, isMemoryFailureReason } = loadProductionPredicates();

test('check mode accepts source-matched memory failures across budgets', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const recordedSixGigFailures = manifest.failures.filter(
    (entry) => entry.reason === 'exceeded the 6G build memory budget',
  );
  assert.ok(recordedSixGigFailures.length > 0, 'manifest must retain the recorded 6G memory failures');

  const threeGigFailure = 'exceeded the 3G build memory budget';
  for (const failure of recordedSixGigFailures) {
    const row = { cbmLanguage: failure.cbmLanguage };
    assert.equal(
      findKnownFailure(recordedSixGigFailures, row, failure.sourceSha256, threeGigFailure, true),
      failure,
    );
  }

  const failure = recordedSixGigFailures[0];
  const staleSourceSha256 = `${failure.sourceSha256.slice(0, -1)}${failure.sourceSha256.endsWith('0') ? '1' : '0'}`;
  const row = { cbmLanguage: failure.cbmLanguage };
  assert.equal(findKnownFailure(recordedSixGigFailures, row, staleSourceSha256, threeGigFailure, true), undefined);
  assert.equal(findKnownFailure(recordedSixGigFailures, row, failure.sourceSha256, threeGigFailure, false), undefined);
  assert.equal(isMemoryFailureReason(failure.reason), true);
  assert.equal(isMemoryFailureReason('emcc failed: compiler error'), false);
});
