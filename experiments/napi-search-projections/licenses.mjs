import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], { cwd, encoding: 'utf8' }));
const packages = metadata.packages.map(p => ({ name: p.name, version: p.version, license: p.license, source: p.source }));
for (const p of packages) {
    if (!p.license) throw new Error(`Missing license declaration: ${p.name}`);
}
packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const result = JSON.stringify({ note: 'Cargo.lock inventory, includes build and transitive crates. SPDX declarations come from cargo metadata. See LICENSE-NOTE.md.', packages }, null, 2) + '\n';
const destination = new URL('./crate-licenses.json', import.meta.url);
if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== result) throw new Error('Crate license inventory differs. Run pnpm licenses.');
} else writeFileSync(destination, result);
