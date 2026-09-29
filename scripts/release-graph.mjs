import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

export const RELEASE_PACKAGES = Object.freeze({
  core: Object.freeze({
    key: 'core',
    name: '@satori-code/core',
    directory: 'packages/core',
    dependencies: Object.freeze([]),
  }),
  mcp: Object.freeze({
    key: 'mcp',
    name: '@satori-code/mcp',
    directory: 'packages/mcp',
    dependencies: Object.freeze(['core']),
  }),
  cli: Object.freeze({
    key: 'cli',
    name: '@satori-code/cli',
    directory: 'packages/cli',
    dependencies: Object.freeze(['core', 'mcp']),
  }),
});

export const RELEASE_ORDER = Object.freeze(['core', 'mcp', 'cli']);

const STABLE_VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

export function parseStableVersion(value, label = 'version') {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string; received ${typeof value}`);
  }
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `${label} must be an exact major.minor.patch version; received ${JSON.stringify(value)}`
    );
  }
  const components = [match[1], match[2], match[3]].map(Number);
  for (const [name, component] of [['major', components[0]], ['minor', components[1]], ['patch', components[2]]]) {
    if (!Number.isSafeInteger(component)) {
      throw new Error(`${label} ${name} component is not a safe integer; expected major.minor.patch components: ${value}`);
    }
  }
  return Object.freeze({
    major: components[0],
    minor: components[1],
    patch: components[2],
  });
}

export function formatStableVersion(parts) {
  if (!parts || !Number.isSafeInteger(parts.major) || !Number.isSafeInteger(parts.minor) || !Number.isSafeInteger(parts.patch)) {
    throw new Error(`Cannot format invalid version parts: ${JSON.stringify(parts)}`);
  }
  if (parts.major < 0 || parts.minor < 0 || parts.patch < 0) {
    throw new Error(`Cannot format negative version parts: ${JSON.stringify(parts)}`);
  }
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

const BUMP_KINDS = Object.freeze(['major', 'minor', 'patch']);

export function incrementStableVersion(version, bump) {
  if (!BUMP_KINDS.includes(bump)) {
    throw new Error(`Unknown bump kind ${JSON.stringify(bump)}; expected one of major, minor, patch`);
  }
  const parts = parseStableVersion(version);
  const next = { major: parts.major, minor: parts.minor, patch: parts.patch };
  if (bump === 'patch') {
    next.patch += 1;
  } else if (bump === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  }
  return formatStableVersion(next);
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left, 'left version');
  const rightParts = parseStableVersion(right, 'right version');
  for (const key of ['major', 'minor', 'patch']) {
    if (leftParts[key] !== rightParts[key]) {
      return leftParts[key] < rightParts[key] ? -1 : 1;
    }
  }
  return 0;
}

export function affectedReleasePackages(changedPackageKey) {
  if (!Object.prototype.hasOwnProperty.call(RELEASE_PACKAGES, changedPackageKey)) {
    throw new Error(`Unknown release package key: ${JSON.stringify(changedPackageKey)}`);
  }
  const affected = new Set([changedPackageKey]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const key of RELEASE_ORDER) {
      if (affected.has(key)) {
        continue;
      }
      if (RELEASE_PACKAGES[key].dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(key);
        grew = true;
      }
    }
  }
  return Object.freeze(RELEASE_ORDER.filter((key) => affected.has(key)));
}

function readJsonFile(filePath, description) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${description} at ${filePath}: ${error.message}`);
  }
  return parsed;
}

export function readLocalReleaseGraph(cwd = process.cwd()) {
  const packages = {};
  for (const key of RELEASE_ORDER) {
    const meta = RELEASE_PACKAGES[key];
    const manifestPath = path.join(cwd, meta.directory, 'package.json');
    const manifest = readJsonFile(manifestPath, `${meta.name} manifest`);
    if (manifest.name !== meta.name) {
      throw new Error(`${meta.directory}/package.json name must be ${meta.name}; received ${JSON.stringify(manifest.name)}`);
    }
    const versionString = parseStableVersion(manifest.version, `${meta.name} version`);
    packages[key] = Object.freeze({
      key,
      name: meta.name,
      directory: meta.directory,
      versionString: formatStableVersion(versionString),
      manifest: Object.freeze(manifest),
    });
  }

  const mcpDependencies = packages.mcp.manifest.dependencies || {};
  const cliDependencies = packages.cli.manifest.dependencies || {};
  const cliRuntime = packages.cli.manifest.satoriManagedRuntime || {};
  if (mcpDependencies['@satori-code/core'] !== 'workspace:*') {
    throw new Error(`MCP source dependency on @satori-code/core must remain workspace:*; received ${JSON.stringify(mcpDependencies['@satori-code/core'])}`);
  }
  for (const dependency of ['@satori-code/core', '@satori-code/mcp']) {
    if (Object.prototype.hasOwnProperty.call(cliDependencies, dependency)) {
      throw new Error(`CLI bootstrap must not install managed runtime dependency ${dependency}.`);
    }
  }
  if (cliRuntime.mcp !== packages.mcp.versionString || cliRuntime.core !== packages.core.versionString) {
    throw new Error(
      `CLI satoriManagedRuntime must target MCP ${packages.mcp.versionString} and Core ${packages.core.versionString}; `
      + `received MCP ${JSON.stringify(cliRuntime.mcp)} and Core ${JSON.stringify(cliRuntime.core)}`
    );
  }
  if (
    cliRuntime.lanceDb !== packages.core.manifest.dependencies?.['@lancedb/lancedb']
    || cliRuntime.oxcParser !== packages.core.manifest.dependencies?.['oxc-parser']
    || cliRuntime.lateOn?.transformers !== packages.mcp.manifest.dependencies?.['@huggingface/transformers']
    || cliRuntime.lateOn?.onnxruntimeNode !== packages.mcp.manifest.dependencies?.['onnxruntime-node']
  ) {
    throw new Error('CLI satoriManagedRuntime native/runtime versions are stale relative to Core/MCP manifests.');
  }

  const serverJson = readJsonFile(path.join(cwd, 'server.json'), 'server.json');
  if (serverJson.version !== packages.mcp.versionString) {
    throw new Error(
      `server.json version ${JSON.stringify(serverJson.version)} must equal local MCP version ${packages.mcp.versionString}`
    );
  }

  return Object.freeze({
    packages: Object.freeze(packages),
    serverJson: Object.freeze({
      path: 'server.json',
      version: serverJson.version,
    }),
  });
}

export function validatePackedDependencyGraph(input) {
  const localVersions = input.localVersions;
  const packedManifests = input.packedManifests;
  for (const key of RELEASE_ORDER) {
    const meta = RELEASE_PACKAGES[key];
    const manifest = packedManifests[key];
    if (!manifest || typeof manifest !== 'object') {
      throw new Error(`Missing packed manifest for ${meta.name}`);
    }
    if (manifest.name !== meta.name) {
      throw new Error(`Packed manifest name must be ${meta.name}; received ${JSON.stringify(manifest.name)}`);
    }
    const expectedVersion = localVersions[key];
    if (typeof expectedVersion !== 'string') {
      throw new Error(`Missing local version for ${meta.name}`);
    }
    parseStableVersion(manifest.version, `packed ${meta.name} version`);
    if (manifest.version !== expectedVersion) {
      throw new Error(`Packed ${meta.name} version ${manifest.version} does not match local version ${expectedVersion}`);
    }
  }

  const edges = [
    { from: 'mcp', to: 'core', kind: 'dependency', actual: packedManifests.mcp.dependencies?.['@satori-code/core'] },
    { from: 'cli', to: 'mcp', kind: 'managed-runtime', actual: packedManifests.cli.satoriManagedRuntime?.mcp },
    { from: 'cli', to: 'core', kind: 'managed-runtime', actual: packedManifests.cli.satoriManagedRuntime?.core },
  ];
  for (const edge of edges) {
    const fromMeta = RELEASE_PACKAGES[edge.from];
    const toMeta = RELEASE_PACKAGES[edge.to];
    const expected = localVersions[edge.to];
    if (edge.actual !== expected) {
      const contract = edge.from === 'cli' ? 'satoriManagedRuntime target' : 'dependency';
      throw new Error(
        `Packed ${fromMeta.name} ${contract} ${toMeta.name} must be exact version ${expected}; received ${JSON.stringify(edge.actual)}`
      );
    }
  }

  return Object.freeze({
    edges: Object.freeze(
      edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        version: localVersions[edge.to],
      }))
    ),
  });
}

export function createFileTreeSnapshot(rootDirectory) {
  const entries = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop();
    const absolute = path.join(rootDirectory, relative);
    let dirents;
    try {
      dirents = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read extracted package directory ${absolute}: ${error.message}`);
    }
    for (const dirent of dirents) {
      const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
      const childAbsolute = path.join(absolute, dirent.name);
      if (dirent.isDirectory()) {
        pending.push(childRelative);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        throw new Error(`Symlink not allowed in extracted package: ${childRelative}`);
      }
      if (!dirent.isFile()) {
        throw new Error(`Special file not allowed in extracted package: ${childRelative}`);
      }
      const stat = fs.statSync(childAbsolute);
      const content = fs.readFileSync(childAbsolute);
      entries.push(
        Object.freeze({
          path: childRelative,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          executable: (stat.mode & 0o111) !== 0,
          sizeBytes: stat.size,
        })
      );
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(entries);
}

export function compareFileTreeSnapshots(left, right) {
  const changes = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftEntry = left[leftIndex];
    const rightEntry = right[rightIndex];
    if (leftEntry.path === rightEntry.path) {
      if (leftEntry.sha256 !== rightEntry.sha256) {
        changes.push({ path: leftEntry.path, change: 'content' });
      } else if (leftEntry.executable !== rightEntry.executable) {
        changes.push({ path: leftEntry.path, change: 'mode' });
      } else if (leftEntry.sizeBytes !== rightEntry.sizeBytes) {
        changes.push({ path: leftEntry.path, change: 'size' });
      }
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftEntry.path < rightEntry.path) {
      changes.push({ path: leftEntry.path, change: 'removed' });
      leftIndex += 1;
    } else {
      changes.push({ path: rightEntry.path, change: 'added' });
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    changes.push({ path: left[leftIndex].path, change: 'removed' });
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    changes.push({ path: right[rightIndex].path, change: 'added' });
    rightIndex += 1;
  }
  return Object.freeze({ identical: changes.length === 0, changes: Object.freeze(changes) });
}

export function buildReleaseGraphReport(input) {
  const packages = {};
  for (const key of RELEASE_ORDER) {
    const pkg = input.packages[key];
    if (!pkg) {
      throw new Error(`Missing release report input for package ${key}`);
    }
    let status;
    let publishedVersion = null;
    let changedEntries = [];
    if (pkg.published === null || pkg.published === undefined) {
      status = 'unpublished';
    } else if (pkg.published.version !== pkg.localVersion) {
      status = 'invalid-graph';
    } else {
      const comparison = compareFileTreeSnapshots(pkg.published.packedSnapshot, pkg.localPackedSnapshot);
      publishedVersion = pkg.published.version;
      if (comparison.identical) {
        status = 'published-identical';
      } else {
        status = 'stale-version';
        changedEntries = comparison.changes;
      }
    }
    const registryMaxStable = pkg.registryMaxStable ?? null;
    if (
      registryMaxStable !== null
      && status === 'unpublished'
      && compareStableVersions(pkg.localVersion, registryMaxStable) <= 0
    ) {
      status = 'non-monotonic-version';
    } else if (
      registryMaxStable !== null
      && status === 'published-identical'
      && compareStableVersions(pkg.localVersion, registryMaxStable) < 0
    ) {
      status = 'superseded-version';
    }
    packages[key] = Object.freeze({
      key,
      name: RELEASE_PACKAGES[key].name,
      localVersion: pkg.localVersion,
      status,
      publishedVersion,
      registryMaxStable,
      changedEntries: Object.freeze(changedEntries),
    });
  }
  const invalidPackages = Object.freeze(
    RELEASE_ORDER.filter(
      (key) => [
        'stale-version',
        'invalid-graph',
        'non-monotonic-version',
        'superseded-version',
      ].includes(packages[key].status)
    )
  );
  return Object.freeze({
    packages: Object.freeze(packages),
    valid: invalidPackages.length === 0,
    invalidPackages,
  });
}
