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
  'server.json',
  'packages/mcp/README.md',
  'packages/cli/README.md',
  'packages/mcp/src/config.ts',
];

const PUBLISHABLE_PACKAGE_NAMES = new Set([
  '@satori-code/core',
  '@satori-code/mcp',
  '@satori-code/cli',
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

const SHARED_RUNTIME_CONTRACT_NAMES = [
  'EMBEDDING_PROJECTION_VERSION',
  'LEXICAL_PROJECTION_VERSION',
  'POTION_MODEL_ID',
  'POTION_DIMENSION',
];

const SHARED_RUNTIME_CONTRACT_CANONICAL_PATH = 'packages/core/src/runtime-contract.ts';

const SHARED_RUNTIME_CONTRACT_FORMER_OWNER_PATHS = [
  'packages/core/src/core/search-projections.ts',
  'packages/core/src/embedding/potion-embedding.ts',
  'packages/cli/src/local-runtime-contract.ts',
];

export function findSharedContractOwnershipViolations(files) {
  const requiredPaths = [
    SHARED_RUNTIME_CONTRACT_CANONICAL_PATH,
    ...SHARED_RUNTIME_CONTRACT_FORMER_OWNER_PATHS,
  ];
  for (const filePath of requiredPaths) {
    if (!files.has(filePath)) {
      throw new Error(`Missing expected source file for shared runtime contract ownership check: ${filePath}`);
    }
  }

  const findings = [];
  for (const filePath of SHARED_RUNTIME_CONTRACT_FORMER_OWNER_PATHS) {
    const content = files.get(filePath);
    for (const name of SHARED_RUNTIME_CONTRACT_NAMES) {
      const declaration = new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`);
      if (declaration.test(content)) {
        findings.push({ filePath, name });
      }
    }
  }
  return findings;
}

export function checkSharedContractOwnership(options = {}) {
  const cwd = options.cwd || process.cwd();
  const filePaths = [
    SHARED_RUNTIME_CONTRACT_CANONICAL_PATH,
    ...SHARED_RUNTIME_CONTRACT_FORMER_OWNER_PATHS,
  ];
  const files = new Map();
  for (const filePath of filePaths) {
    const absolutePath = path.join(cwd, filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Missing expected source file for shared runtime contract ownership check: ${filePath}`);
    }
    files.set(filePath, fs.readFileSync(absolutePath, 'utf8'));
  }
  return findSharedContractOwnershipViolations(files);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = checkVersionFreshness();
  const ownershipViolations = checkSharedContractOwnership();
  let failed = false;
  if (findings.length > 0) {
    console.error('Stale package version references found:');
    for (const finding of findings) {
      console.error(
        `- ${finding.filePath}: ${finding.packageName}@${finding.foundVersion} should be ${finding.packageName}@${finding.expectedVersion}`
      );
    }
    failed = true;
  }
  if (ownershipViolations.length > 0) {
    console.error('Duplicate shared runtime contract declarations found:');
    for (const violation of ownershipViolations) {
      console.error(
        `- ${violation.filePath}: remove local ${violation.name}; import it from ${SHARED_RUNTIME_CONTRACT_CANONICAL_PATH}`
      );
    }
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('Package version references are fresh.');
  console.log('Shared runtime contract ownership is canonical.');
}
