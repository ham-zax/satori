import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_PACKAGE_JSON_PATHS = [
  'packages/core/package.json',
  'packages/mcp/package.json',
  'packages/cli/package.json',
];

const DEFAULT_SCAN_PATHS = [
  'README.md',
  'packages/mcp/README.md',
  'packages/cli/README.md',
  'packages/mcp/src/config.ts',
];

const PUBLISHABLE_PACKAGE_NAMES = new Set([
  '@zokizuan/satori-core',
  '@zokizuan/satori-mcp',
  '@zokizuan/satori-cli',
]);

function readFiles(filePaths, cwd = process.cwd()) {
  const files = new Map();
  for (const filePath of filePaths) {
    files.set(filePath, fs.readFileSync(path.join(cwd, filePath), 'utf8'));
  }
  return files;
}

export function parsePackageVersions(packageFiles) {
  const versions = {};
  for (const content of packageFiles.values()) {
    const parsed = JSON.parse(content);
    if (
      parsed
      && PUBLISHABLE_PACKAGE_NAMES.has(parsed.name)
      && typeof parsed.version === 'string'
    ) {
      versions[parsed.name] = parsed.version;
    }
  }
  return versions;
}

function isIgnoredReferencePath(filePath) {
  return /(^|\/)(test|tests|__fixtures__)(\/|$)/.test(filePath)
    || /\.test\.[cm]?[jt]s$/.test(filePath)
    || filePath.includes('pnpm-lock.yaml')
    || filePath.includes('CHANGELOG.md');
}

export function findStalePackageVersionReferences(files, packageVersions) {
  const findings = [];
  for (const [filePath, content] of files.entries()) {
    if (isIgnoredReferencePath(filePath)) {
      continue;
    }
    for (const [packageName, expectedVersion] of Object.entries(packageVersions)) {
      const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`${escapedName}@([0-9]+\\.[0-9]+\\.[0-9]+)`, 'g');
      for (const match of content.matchAll(regex)) {
        const foundVersion = match[1];
        if (foundVersion !== expectedVersion) {
          findings.push({
            filePath,
            packageName,
            foundVersion,
            expectedVersion,
          });
        }
      }
    }
  }
  return findings;
}

export function checkVersionFreshness(options = {}) {
  const cwd = options.cwd || process.cwd();
  const packageFiles = readFiles(options.packageJsonPaths || DEFAULT_PACKAGE_JSON_PATHS, cwd);
  const scanFiles = readFiles(options.scanPaths || DEFAULT_SCAN_PATHS, cwd);
  const packageVersions = parsePackageVersions(packageFiles);
  return findStalePackageVersionReferences(scanFiles, packageVersions);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = checkVersionFreshness();
  if (findings.length > 0) {
    console.error('Stale package version references found:');
    for (const finding of findings) {
      console.error(
        `- ${finding.filePath}: ${finding.packageName}@${finding.foundVersion} should be ${finding.packageName}@${finding.expectedVersion}`
      );
    }
    process.exit(1);
  }
  console.log('Package version references are fresh.');
}
