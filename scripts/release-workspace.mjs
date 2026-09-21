import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { RELEASE_PACKAGES } from './release-graph.mjs';

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${error.message}`);
  }
}

function dependencyPath(packageRoot, dependencyName) {
  return path.join(packageRoot, 'node_modules', ...dependencyName.split('/'));
}

export function assertReleaseWorkspaceLinks(cwd = process.cwd()) {
  const packages = Object.values(RELEASE_PACKAGES).map((meta) => {
    const root = path.join(cwd, meta.directory);
    return {
      meta,
      root,
      manifest: readJson(path.join(root, 'package.json'), `${meta.name} manifest`),
    };
  });
  const packageByName = new Map(packages.map((entry) => [entry.meta.name, entry]));
  const checkedEdges = [];

  const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const source of packages) {
    const seenDependencies = new Set();
    for (const section of dependencySections) {
      for (const [dependencyName, specifier] of Object.entries(source.manifest[section] ?? {})) {
        if (typeof specifier !== 'string' || !specifier.startsWith('workspace:')) continue;
        const target = packageByName.get(dependencyName);
        if (!target || seenDependencies.has(dependencyName)) continue;
        seenDependencies.add(dependencyName);

        const expectedRoot = fs.realpathSync(target.root);
        const linkedPath = dependencyPath(source.root, dependencyName);
        let actualRoot;
        try {
          actualRoot = fs.realpathSync(linkedPath);
        } catch {
          throw new Error(
            `Release workspace dependency ${source.meta.name} -> ${dependencyName} is not linked. `
            + 'Run "pnpm install --frozen-lockfile --ignore-scripts" from the repository root before packing.',
          );
        }

        const linkedManifest = readJson(
          path.join(actualRoot, 'package.json'),
          `linked ${dependencyName} manifest`,
        );
        if (actualRoot !== expectedRoot || linkedManifest.version !== target.manifest.version) {
          throw new Error(
            `Release workspace dependency ${source.meta.name} -> ${dependencyName} is stale: `
            + `expected ${expectedRoot}@${target.manifest.version}, `
            + `resolved ${actualRoot}@${JSON.stringify(linkedManifest.version)}. `
            + 'Run "pnpm install --frozen-lockfile --ignore-scripts" from the repository root before packing.',
          );
        }

        checkedEdges.push(Object.freeze({
          from: source.meta.name,
          to: dependencyName,
          version: target.manifest.version,
        }));
      }
    }
  }

  return Object.freeze({ checkedEdges: Object.freeze(checkedEdges) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = assertReleaseWorkspaceLinks(path.resolve(process.cwd()));
    console.log(
      `[release:workspace] Verified ${result.checkedEdges.length} internal workspace dependency link(s).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
