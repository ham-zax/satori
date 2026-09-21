import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  RELEASE_ORDER,
  RELEASE_PACKAGES,
  readLocalReleaseGraph,
  validatePackedDependencyGraph,
  buildReleaseGraphReport,
} from './release-graph.mjs';
import { packLocalPackage, fetchPublishedPackage } from './release-package-snapshots.mjs';
import { assertReleaseWorkspaceLinks } from './release-workspace.mjs';
import {
  createReleaseRegistryClient,
  registryMaxStableVersion,
} from './release-registry.mjs';

const CHANGED_ENTRY_LIMIT = 20;

function localVersionsFromGraph(graph) {
  return Object.freeze(
    Object.fromEntries(RELEASE_ORDER.map((key) => [key, graph.packages[key].versionString]))
  );
}

function statusAction(status) {
  if (status === 'unpublished') {
    return 'publish';
  }
  if (status === 'published-identical') {
    return 'skip';
  }
  return 'block';
}

export function printReleaseGraphReport(report, output) {
  output('Satori release graph');
  output('');
  const nameWidth = Math.max(...RELEASE_ORDER.map((key) => RELEASE_PACKAGES[key].name.length));
  const localWidth = Math.max(...RELEASE_ORDER.map((key) => report.packages[key].localVersion.length));
  output(
    `${'Package'.padEnd(nameWidth)}  ${'Local'.padEnd(localWidth)}  Registry state     Action`
  );
  for (const key of RELEASE_ORDER) {
    const pkg = report.packages[key];
    output(
      `${pkg.name.padEnd(nameWidth)}  ${pkg.localVersion.padEnd(localWidth)}  ${pkg.status.padEnd(18)}  ${statusAction(pkg.status)}`
    );
  }
  output('');
  output('Packed release graph');
  for (const edge of report.graphEdges) {
    const relation = edge.kind === 'managed-runtime' ? 'managed runtime' : 'dependency';
    output(`${RELEASE_PACKAGES[edge.from].name} ${relation} -> ${RELEASE_PACKAGES[edge.to].name}@${edge.version}`);
  }
  output('');

  for (const key of report.invalidPackages) {
    const pkg = report.packages[key];
    if (pkg.status === 'non-monotonic-version') {
      output(
        `${pkg.name} ${pkg.localVersion} is unpublished but is not newer than registry maximum ${pkg.registryMaxStable}. Bump from the registry maximum before publishing.`,
      );
      output('');
      continue;
    }
    if (pkg.status === 'superseded-version') {
      output(
        `${pkg.name} ${pkg.localVersion} is published-identical but older than registry maximum ${pkg.registryMaxStable}. Release from the current package version.`,
      );
      output('');
      continue;
    }
    output(
      `${pkg.name} ${pkg.localVersion} is already published, but its locally packed artifact differs. Bump ${RELEASE_PACKAGES[key].name} before publishing this graph.`
    );
    output('');
    output('Changed packed entries:');
    for (const entry of pkg.changedEntries.slice(0, CHANGED_ENTRY_LIMIT)) {
      output(`- ${entry.path} (${entry.change})`);
    }
    const remaining = pkg.changedEntries.length - CHANGED_ENTRY_LIMIT;
    if (remaining > 0) {
      output(`(and ${remaining} more)`);
    }
    output('');
  }

  if (report.valid) {
    output('Release graph valid.');
  } else {
    output('Release graph invalid.');
  }
}

export async function checkReleaseGraph(options = {}) {
  const cwd = options.cwd || process.cwd();
  const output = options.output || ((line) => console.log(line));
  const tempRoot = options.tempRoot || os.tmpdir();
  const packLocalImpl = options.packLocalImpl
    || ((input) => packLocalPackage({ ...input, execFileSyncImpl: options.execFileSyncImpl || execFileSync }));
  const fetchPublishedImpl = options.fetchPublishedImpl
    || ((input) => fetchPublishedPackage({ ...input, execFileSyncImpl: options.execFileSyncImpl || execFileSync }));
  const registryClient = options.registryClient || createReleaseRegistryClient({
    cwd,
    execFileSyncImpl: options.execFileSyncImpl || execFileSync,
  });
  const listPublishedStableVersionsImpl = options.listPublishedStableVersionsImpl
    || ((packageName) => registryClient.listStableVersions(packageName));

  const graph = readLocalReleaseGraph(cwd);
  if (!options.packLocalImpl) {
    assertReleaseWorkspaceLinks(cwd);
  }
  const localVersions = localVersionsFromGraph(graph);

  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'satori-release-check-'));
  let kept = false;
  try {
    const packed = {};
    for (const key of RELEASE_ORDER) {
      const workDirectory = path.join(tempDirectory, key);
      packed[key] = packLocalImpl({
        packageName: RELEASE_PACKAGES[key].name,
        cwd,
        workDirectory,
      });
    }
    const packedManifests = Object.freeze({
      core: packed.core.manifest,
      mcp: packed.mcp.manifest,
      cli: packed.cli.manifest,
    });
    const graphValidation = validatePackedDependencyGraph({ localVersions, packedManifests });

    const packages = {};
    for (const key of RELEASE_ORDER) {
      const acquired = fetchPublishedImpl({
        packageName: RELEASE_PACKAGES[key].name,
        version: localVersions[key],
        workDirectory: path.join(tempDirectory, `${key}-published`),
      });
      const published = acquired && acquired.status === 'published'
        ? { version: acquired.version, packedSnapshot: acquired.snapshot, packedManifest: acquired.manifest }
        : null;
      const publishedStableVersions = listPublishedStableVersionsImpl(RELEASE_PACKAGES[key].name);
      packages[key] = {
        key,
        name: RELEASE_PACKAGES[key].name,
        localVersion: localVersions[key],
        localPackedSnapshot: packed[key].snapshot,
        published,
        registryMaxStable: registryMaxStableVersion(publishedStableVersions),
      };
    }

    const report = buildReleaseGraphReport({ packages });
    const fullReport = Object.freeze({
      ...report,
      graphEdges: graphValidation.edges,
      ...(options.keepTempDirectory === true
        ? {
            tarballs: Object.freeze({
              core: packed.core.tarballPath,
              mcp: packed.mcp.tarballPath,
              cli: packed.cli.tarballPath,
            }),
            tempDirectory,
          }
        : {}),
    });
    printReleaseGraphReport(fullReport, output);
    if (!fullReport.valid) {
      throw new Error('Release graph invalid.');
    }
    kept = options.keepTempDirectory === true;
    return fullReport;
  } finally {
    if (!kept || !options.keepTempDirectory) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/check-release-graph.mjs');
    process.exit(2);
  }
  try {
    await checkReleaseGraph();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
