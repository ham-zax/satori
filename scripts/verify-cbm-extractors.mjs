#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(repoRoot, 'packages/core/assets/cbm-extractor');
const manifest = JSON.parse(readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(manifest.cbmCommit) ||
    manifest.emscripten !== '3.1.64' || manifest.glue?.file !== 'cbm-extractor.js' ||
    !/^[0-9a-f]{64}$/.test(manifest.glue.sha256) || !Array.isArray(manifest.modules)) {
    throw new Error('Invalid CBM extractor manifest header');
}
const failures = [];
const glue = path.join(assetRoot, manifest.glue.file);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (!existsSync(glue) || digest(readFileSync(glue)) !== manifest.glue.sha256) failures.push('shared glue missing or sha256 mismatch');
const listed = new Set();
const languages = new Set();
let checked = 0;
let missingExtended = 0;
for (const entry of manifest.modules) {
    if (!/^[A-Z0-9_]+$/.test(entry.cbmLanguage) || !entry.satoriLanguageId ||
        !/^[a-z0-9_]+\.wasm$/.test(entry.file) || entry.file !== `${entry.cbmLanguage.toLowerCase()}.wasm` ||
        !['core', 'extended'].includes(entry.pack) || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(entry.sha256) || !/^[0-9a-f]{64}$/.test(entry.sourceSha256) ||
        languages.has(entry.cbmLanguage)) {
        failures.push(`invalid manifest module ${entry.cbmLanguage}`);
        continue;
    }
    languages.add(entry.cbmLanguage);
    const filename = path.join(assetRoot, entry.pack === 'core' ? '' : 'extended', entry.file);
    listed.add(filename);
    if (!existsSync(filename)) {
        if (entry.pack === 'core') failures.push(`missing core module ${entry.cbmLanguage}: ${entry.file}`);
        else missingExtended++;
        continue;
    }
    const bytes = readFileSync(filename);
    if (bytes.length !== entry.sizeBytes || digest(bytes) !== entry.sha256) failures.push(`size/sha256 mismatch ${entry.cbmLanguage}`);
    checked++;
}
for (const dir of [assetRoot, path.join(assetRoot, 'extended')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.wasm'))) {
        const filename = path.join(dir, name);
        if (!listed.has(filename)) failures.push(`unlisted module ${filename}`);
    }
}
if (failures.length) throw new Error(failures.join('\n'));
console.log(`Verified shared glue and ${checked} CBM extractor modules; ${missingExtended} extended modules absent`);
