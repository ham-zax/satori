import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentDocs = new Set([
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'docs/PRODUCT_GUIDE.md', 'docs/RELEASING.md',
  'docs/architecture/LANGUAGE_INTELLIGENCE.md',
  'third_party/cbm-semantic/UPDATING.md',
]);
const oldScope = '@' + 'zokizuan';
const oldTarballPrefix = 'zokizuan' + '-satori-';
const trackedFiles = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const activeFiles = trackedFiles.filter((file) => (
  currentDocs.has(file)
  || ['package.json', 'pnpm-lock.yaml', 'server.json'].includes(file)
  || file.startsWith('.github/')
  || file.startsWith('packages/')
  || (file.startsWith('scripts/') && !file.startsWith('scripts/archive/'))
  || file.startsWith('evals/')
  || file.startsWith('satori-landing/')
));

const stale = [];
for (const file of activeFiles) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  if (content.includes(oldScope) || content.includes(oldTarballPrefix)) {
    stale.push(file);
  }
}

if (stale.length > 0) {
  console.error(`Old npm package scope remains in active files:\n${stale.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Active package references use the current npm scope.');
}
