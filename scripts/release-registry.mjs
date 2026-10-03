import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  RELEASE_ORDER,
  RELEASE_PACKAGES,
  compareStableVersions,
  parseStableVersion,
  readLocalReleaseGraph,
} from './release-graph.mjs';
import { createNpmChildEnvironment, REGISTRY_PROBE_STDIO } from './npm-child-process.mjs';

export const PRODUCTION_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PRODUCTION_NPM_TAG = 'latest';
const REGISTRY_STATE_NOT_READY_CODE = 'SATORI_REGISTRY_STATE_NOT_READY';

function parseJsonOutput(output, description) {
  try {
    return JSON.parse(String(output).trim());
  } catch {
    throw new Error(`Malformed ${description}: ${JSON.stringify(String(output).trim())}`);
  }
}

export function normalizeSingleNpmViewValue(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function parseNpmViewVersionOutput(output, description) {
  const value = normalizeSingleNpmViewValue(parseJsonOutput(output, description));
  if (typeof value !== 'string') {
    throw new Error(`Malformed ${description}: expected one version string`);
  }
  return value;
}

export function parseNpmViewDependenciesOutput(output, description) {
  const value = normalizeSingleNpmViewValue(parseJsonOutput(output, description));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed ${description}: expected one dependencies object`);
  }
  return value;
}

export function parseNpmViewVersionsOutput(output, description) {
  const value = normalizeSingleNpmViewValue(parseJsonOutput(output, description));
  const versions = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(versions) || versions.some((version) => typeof version !== 'string')) {
    throw new Error(`Malformed ${description}: expected a version string or array of version strings`);
  }
  return versions;
}

export function classifyRegistryError(error) {
  if (error?.code === REGISTRY_STATE_NOT_READY_CODE) {
    return 'state-not-ready';
  }
  const text = `${error instanceof Error ? error.message : String(error)}\n${String(error?.stderr || '')}\n${String(error?.stdout || '')}`;
  if (/E401|E403|authentication|authorization|login required|permission denied/i.test(text)) {
    return 'auth';
  }
  if (/E404|404\s+Not\s+Found|version\s+not\s+found/i.test(text)) {
    return 'not-found';
  }
  if (/ETIMEDOUT|ECONNRESET|EAI_AGAIN|EAI_NODATA|EAI_NONAME|socket hang up|ECONNREFUSED|HTTP\s+5\d\d|status\s*[:=]\s*5\d\d/i.test(text)) {
    return 'transient';
  }
  return 'permanent';
}

function registryStateNotReady(message) {
  return Object.assign(new Error(message), { code: REGISTRY_STATE_NOT_READY_CODE });
}

function isRegistryNotFoundError(error) {
  return (
    error
    && typeof error === 'object'
    && error.status === 1
    && /E404|404\s+Not\s+Found|version\s+not\s+found/i.test(String(error.stderr || ''))
  );
}

export function createReleaseRegistryClient(options = {}) {
  const cwd = options.cwd || process.cwd();
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const runNpmView = (args) => execFileSyncImpl(
    'npm',
    [...args, '--registry', PRODUCTION_NPM_REGISTRY],
    {
      cwd,
      env: createNpmChildEnvironment(process.env),
      stdio: REGISTRY_PROBE_STDIO,
      encoding: 'utf8',
    },
  );

  return Object.freeze({
    listStableVersions(packageName) {
      let value;
      try {
        value = parseNpmViewVersionsOutput(
          runNpmView(['view', packageName, 'versions', '--json']),
          `npm view versions output for ${packageName}`,
        );
      } catch (error) {
        if (isRegistryNotFoundError(error)) {
          return Object.freeze([]);
        }
        throw error;
      }
      const stable = value.filter((candidate) => {
        try {
          parseStableVersion(candidate, `${packageName} registry version`);
          return true;
        } catch {
          return false;
        }
      });
      stable.sort(compareStableVersions);
      return Object.freeze(stable);
    },

    viewVersion(packageName, selector) {
      return parseNpmViewVersionOutput(
        runNpmView(['view', `${packageName}@${selector}`, 'version', '--json']),
        `npm view output for ${packageName}@${selector}`,
      );
    },

    viewDependencies(packageName, version) {
      return parseNpmViewDependenciesOutput(
        runNpmView(['view', `${packageName}@${version}`, 'dependencies', '--json']),
        `npm view dependencies for ${packageName}@${version}`,
      );
    },

    viewManagedRuntime(packageName, version) {
      return parseNpmViewDependenciesOutput(
        runNpmView(['view', `${packageName}@${version}`, 'satoriManagedRuntime', '--json']),
        `npm view satoriManagedRuntime for ${packageName}@${version}`,
      );
    },
  });
}

export function registryMaxStableVersion(versions) {
  return versions.length === 0
    ? null
    : versions.reduce((maximum, version) => (
        compareStableVersions(version, maximum) > 0 ? version : maximum
      ));
}

export function verifyPublishedIdenticalLatest(options) {
  const { packageKeys, localVersions, registryClient } = options;
  for (const key of packageKeys) {
    const packageName = RELEASE_PACKAGES[key].name;
    const expectedVersion = localVersions[key];
    const latestVersion = registryClient.viewVersion(packageName, PRODUCTION_NPM_TAG);
    if (latestVersion !== expectedVersion) {
      throw new Error(
        `Cannot publish because ${packageName}@${PRODUCTION_NPM_TAG} is ${JSON.stringify(latestVersion)}; expected skipped version ${expectedVersion}`,
      );
    }
  }
}

export async function verifyReleaseRegistry(options = {}) {
  const localGraph = options.localGraph || readLocalReleaseGraph(options.cwd || process.cwd());
  const localVersions = options.localVersions || Object.freeze(
    Object.fromEntries(RELEASE_ORDER.map((key) => [key, localGraph.packages[key].versionString])),
  );
  const registry = options.registryClient || createReleaseRegistryClient(options);
  const attempts = options.attempts ?? 1;
  const sleepImpl = options.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const retryDelayMs = options.retryDelayMs ?? 5000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      for (const key of options.packageKeys ?? RELEASE_ORDER) {
        const packageName = RELEASE_PACKAGES[key].name;
        const version = localVersions[key];
        const exactVersion = registry.viewVersion(packageName, version);
        if (exactVersion !== version) {
          throw registryStateNotReady(`${packageName}@${version} is not the exact published version; received ${JSON.stringify(exactVersion)}`);
        }
        const latestVersion = registry.viewVersion(packageName, PRODUCTION_NPM_TAG);
        if (latestVersion !== version) {
          throw registryStateNotReady(`${packageName}@${PRODUCTION_NPM_TAG} is ${JSON.stringify(latestVersion)}; expected ${version}`);
        }
        if (key === 'mcp') {
          const dependencies = registry.viewDependencies(packageName, version);
          if (dependencies?.[RELEASE_PACKAGES.core.name] !== localVersions.core) {
            throw registryStateNotReady(`Published MCP must pin ${RELEASE_PACKAGES.core.name}@${localVersions.core}`);
          }
        } else if (key === 'cli') {
          const runtime = registry.viewManagedRuntime(packageName, version);
          if (runtime?.core !== localVersions.core || runtime?.mcp !== localVersions.mcp) {
            throw registryStateNotReady(
              `Published CLI satoriManagedRuntime must target Core ${localVersions.core} and MCP ${localVersions.mcp}`,
            );
          }
        }
      }
      return Object.freeze({ verified: true, localVersions });
    } catch (error) {
      lastError = error;
      const classification = classifyRegistryError(error);
      const retryable = ['not-found', 'transient', 'state-not-ready'].includes(classification);
      if (attempt < attempts && retryable) {
        await sleepImpl(retryDelayMs);
      } else {
        break;
      }
    }
  }
  throw new Error(`Release registry verification failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await verifyReleaseRegistry();
    console.log(`Release registry closure verified on ${PRODUCTION_NPM_REGISTRY}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
