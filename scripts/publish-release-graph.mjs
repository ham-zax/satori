import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELEASE_ORDER, RELEASE_PACKAGES } from './release-graph.mjs';
import { createNpmChildEnvironment, REGISTRY_PROBE_STDIO } from './npm-child-process.mjs';
import { qualifyReleaseCandidate } from './qualify-release-candidate.mjs';
import {
  PRODUCTION_NPM_REGISTRY,
  PRODUCTION_NPM_TAG,
  classifyRegistryError,
  createReleaseRegistryClient,
  verifyPublishedIdenticalLatest,
  verifyReleaseRegistry,
} from './release-registry.mjs';

const REGISTRY_POLL_INTERVAL_MS = 5000;
const REGISTRY_PROPAGATION_TIMEOUT_MS = 15 * 60 * 1000;
const REGISTRY_POLL_ATTEMPTS = Math.floor(REGISTRY_PROPAGATION_TIMEOUT_MS / REGISTRY_POLL_INTERVAL_MS) + 1;
const REGISTRY_PROGRESS_INTERVAL_ATTEMPTS = Math.floor(30_000 / REGISTRY_POLL_INTERVAL_MS);
export const CANONICAL_RELEASE_REPOSITORY = 'https://github.com/ham-zax/satori.git';
export const CANONICAL_RELEASE_REF = 'refs/remotes/satori-release/master';
export const CANONICAL_MASTER_FETCH_ARGS = Object.freeze([
  'fetch',
  '--no-tags',
  CANONICAL_RELEASE_REPOSITORY,
  `+refs/heads/master:${CANONICAL_RELEASE_REF}`,
]);

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPathWithin(rootPath, candidatePath) {
  try {
    const relative = path.relative(fs.realpathSync(rootPath), fs.realpathSync(candidatePath));
    return relative.length > 0
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function formatEntries(entries) {
  return entries.map((entry) => `${entry.name}@${entry.version}`).join(', ') || 'none';
}

export function ensureNpmAuthenticated(options = {}) {
  const cwd = options.cwd || process.cwd();
  const log = options.log || ((line) => console.log(line));
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const env = createNpmChildEnvironment(process.env);
  const whoami = () => execFileSyncImpl(
    'npm',
    ['whoami', '--registry', PRODUCTION_NPM_REGISTRY],
    { cwd, env, stdio: REGISTRY_PROBE_STDIO, encoding: 'utf8' },
  );

  try {
    return String(whoami()).trim();
  } catch (error) {
    if (classifyRegistryError(error) !== 'auth') {
      throw new Error(
        `Cannot verify npm authentication against ${PRODUCTION_NPM_REGISTRY}: ${errorMessage(error)}`,
      );
    }
  }

  log(`npm is not authenticated to ${PRODUCTION_NPM_REGISTRY}. Opening npm web login...`);
  try {
    execFileSyncImpl(
      'npm',
      ['login', '--auth-type=web', '--registry', PRODUCTION_NPM_REGISTRY],
      { cwd, env, stdio: 'inherit' },
    );
  } catch (error) {
    throw new Error(`npm web login did not complete successfully: ${errorMessage(error)}`);
  }

  try {
    const username = String(whoami()).trim();
    log(username ? `Authenticated to npm as ${username}.` : 'npm authentication verified.');
    return username;
  } catch (error) {
    throw new Error(
      `npm web login completed, but authentication could not be verified against ${PRODUCTION_NPM_REGISTRY}: ${errorMessage(error)}`,
    );
  }
}

export function assertSourceAuthority(options) {
  const branch = String(options.branchImpl()).trim();
  if (branch !== 'master') {
    throw new Error(`Refusing to publish from branch ${JSON.stringify(branch)}; expected master`);
  }

  options.fetchCanonicalMasterImpl();
  const head = String(options.headImpl()).trim();
  const canonicalMaster = String(options.canonicalMasterImpl()).trim();
  if (options.allowUnpushedHead === true) {
    if (!options.canonicalMasterIsAncestorImpl()) {
      throw new Error(
        `Refusing emergency publication because canonical release master ${canonicalMaster} is not an ancestor of HEAD ${head}. Rebase the local release onto canonical master first.`,
      );
    }
  } else if (head !== canonicalMaster) {
    throw new Error(
      `Refusing to publish because HEAD ${head} does not equal canonical release master ${canonicalMaster} (${CANONICAL_RELEASE_REF}). Push canonical master first or use --allow-unpushed-head only for a locally-ahead emergency release.`,
    );
  }
}

function validateReleaseReport(report) {
  if (!report || typeof report !== 'object' || !report.packages || typeof report.packages !== 'object') {
    throw new Error('Malformed release graph report: packages are missing.');
  }
  if (report.valid !== true) {
    throw new Error('Malformed release graph report: valid must be exactly true.');
  }
  const keys = Object.keys(report.packages).sort();
  const expectedKeys = [...RELEASE_ORDER].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Malformed release graph report: expected packages ${expectedKeys.join(', ')}; received ${keys.join(', ')}.`);
  }
  for (const key of RELEASE_ORDER) {
    const pkg = report.packages[key];
    if (
      !pkg
      || typeof pkg !== 'object'
      || pkg.key !== key
      || pkg.name !== RELEASE_PACKAGES[key].name
      || typeof pkg.localVersion !== 'string'
      || !STABLE_VERSION_PATTERN.test(pkg.localVersion)
      || (pkg.status !== 'unpublished' && pkg.status !== 'published-identical')
    ) {
      throw new Error(`Malformed release graph report: package ${key} must carry its key, name, an exact version and a known status.`);
    }
  }
}

function validateRetainedStorage(report, publisherTempRoot) {
  if (
    typeof report?.tempDirectory !== 'string'
    || !isPathWithin(publisherTempRoot, report.tempDirectory)
  ) {
    throw new Error('Malformed release graph report: retained verification directory is outside the publisher-owned root.');
  }
  for (const key of RELEASE_ORDER) {
    const tarballPath = report.tarballs?.[key];
    if (
      typeof tarballPath !== 'string'
      || !isPathWithin(publisherTempRoot, tarballPath)
      || !isPathWithin(report.tempDirectory, tarballPath)
    ) {
      throw new Error(`Verified tarball for ${key} is outside the retained verification directory.`);
    }
  }
}

function validateVerifiedTarballs(report, toPublish) {
  if (!report || typeof report.tempDirectory !== 'string' || !report.tarballs || typeof report.tarballs !== 'object') {
    throw new Error('Malformed release graph report: retained verified tarballs are missing.');
  }
  for (const key of toPublish) {
    const tarballPath = report.tarballs[key];
    const packageName = RELEASE_PACKAGES[key].name;
    const version = report.packages[key].localVersion;
    if (typeof tarballPath !== 'string' || !path.isAbsolute(tarballPath)) {
      throw new Error(`Verified tarball for ${packageName}@${version} is missing or not absolute.`);
    }
    let stat;
    try {
      stat = fs.lstatSync(tarballPath);
    } catch {
      throw new Error(`Verified tarball for ${packageName}@${version} does not exist: ${tarballPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Verified tarball for ${packageName}@${version} must not be a symbolic link.`);
    }
    if (!stat.isFile() || !isPathWithin(report.tempDirectory, tarballPath)) {
      throw new Error(`Verified tarball for ${packageName}@${version} is outside the retained verification directory.`);
    }
    const expectedName = `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    if (path.basename(fs.realpathSync(tarballPath)) !== expectedName) {
      throw new Error(`Verified tarball for ${packageName}@${version} has an unexpected filename.`);
    }
  }
}

export async function publishReleaseGraph(options = {}) {
  const cwd = options.cwd || process.cwd();
  const log = options.log || ((line) => console.log(line));
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const gitStatusImpl = options.gitStatusImpl
    || (() => execFileSyncImpl('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }));
  const branchImpl = options.branchImpl
    || (() => execFileSyncImpl('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim());
  const fetchCanonicalMasterImpl = options.fetchCanonicalMasterImpl
    || (() => execFileSyncImpl('git', [...CANONICAL_MASTER_FETCH_ARGS], { cwd, stdio: 'inherit' }));
  const headImpl = options.headImpl
    || (() => execFileSyncImpl('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim());
  const canonicalMasterImpl = options.canonicalMasterImpl
    || (() => execFileSyncImpl('git', ['rev-parse', CANONICAL_RELEASE_REF], { cwd, encoding: 'utf8' }).trim());
  const canonicalMasterIsAncestorImpl = options.canonicalMasterIsAncestorImpl
    || (() => {
      try {
        execFileSyncImpl(
          'git',
          ['merge-base', '--is-ancestor', CANONICAL_RELEASE_REF, 'HEAD'],
          { cwd, stdio: 'ignore' },
        );
        return true;
      } catch (error) {
        if (error && typeof error === 'object' && error.status === 1) {
          return false;
        }
        throw error;
      }
    });
  const qualifyImpl = options.qualifyImpl
    || ((tempRoot) => qualifyReleaseCandidate({
      cwd,
      tempRoot,
      keepTempDirectory: true,
      execFileSyncImpl,
      gitStatusImpl,
    }));
  const registryClient = options.registryClient || createReleaseRegistryClient({ cwd, execFileSyncImpl });
  const authenticateImpl = options.authenticateImpl
    || (options.publishImpl
      ? null
      : () => ensureNpmAuthenticated({ cwd, log, execFileSyncImpl }));
  const publishImpl = options.publishImpl
    || ((packageName, version, tarballPath) => {
      if (typeof tarballPath !== 'string') {
        throw new Error(`No verified tarball for ${packageName}@${version}; publish is refused`);
      }
      return execFileSyncImpl(
        'npm',
        [
          'publish',
          tarballPath,
          '--registry',
          PRODUCTION_NPM_REGISTRY,
          '--tag',
          PRODUCTION_NPM_TAG,
          '--access',
          'public',
        ],
        { cwd, env: createNpmChildEnvironment(process.env), stdio: 'inherit' }
      );
    });
  const viewVersionImpl = options.viewVersionImpl
    || ((packageName, version) => registryClient.viewVersion(packageName, version));
  const viewDependenciesImpl = options.viewDependenciesImpl
    || ((packageName, version) => registryClient.viewDependencies(packageName, version));
  const viewManagedRuntimeImpl = options.viewManagedRuntimeImpl
    || ((packageName, version) => registryClient.viewManagedRuntime(packageName, version));
  const sleepImpl = options.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const verifyReleaseImpl = options.verifyReleaseImpl
    || ((localVersions) => verifyReleaseRegistry({
      localVersions,
      registryClient,
      attempts: REGISTRY_POLL_ATTEMPTS,
      sleepImpl,
      retryDelayMs: REGISTRY_POLL_INTERVAL_MS,
    }));
  const verifySkippedLatestImpl = options.verifySkippedLatestImpl
    || ((packageKeys, localVersions) => verifyPublishedIdenticalLatest({
      packageKeys,
      localVersions,
      registryClient,
    }));

  const status = String(gitStatusImpl()).trim();
  if (status !== '') {
    throw new Error(`Working tree is not clean; refusing to publish:\n${status}`);
  }
  const sourceAuthorityOptions = {
    allowUnpushedHead: options.allowUnpushedHead === true,
    branchImpl,
    fetchCanonicalMasterImpl,
    headImpl,
    canonicalMasterImpl,
    canonicalMasterIsAncestorImpl,
  };
  assertSourceAuthority(sourceAuthorityOptions);
  authenticateImpl?.();
  let report = null;
  const publisherTempRoot = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), 'satori-publish-'));
  try {
    report = await qualifyImpl(publisherTempRoot);
    assertSourceAuthority(sourceAuthorityOptions);
    if (!report || !report.valid) {
      throw new Error('Release graph is invalid; refusing to publish.');
    }
    validateReleaseReport(report);
    const localVersions = Object.freeze(
      Object.fromEntries(RELEASE_ORDER.map((key) => [key, report.packages[key].localVersion]))
    );
    const toPublish = RELEASE_ORDER.filter((key) => report.packages[key].status === 'unpublished');
    const toSkip = RELEASE_ORDER.filter((key) => report.packages[key].status === 'published-identical');

    if (toPublish.length > 0) {
      verifySkippedLatestImpl(toSkip, localVersions);
      validateRetainedStorage(report, publisherTempRoot);
      if (!options.publishImpl) {
        validateVerifiedTarballs(report, toPublish);
      }
    }

    if (toPublish.length === 0) {
      log('All packages are published-identical; nothing to publish.');
    } else {
      log(`Publishing in order: ${toPublish.map((key) => RELEASE_PACKAGES[key].name).join(' -> ')}`);
    }
    const publishCommandSucceeded = [];
    const registryVerified = [];
    for (const key of toPublish) {
      const packageName = RELEASE_PACKAGES[key].name;
      const version = localVersions[key];
      const entry = { key, name: packageName, version };
      log(`Publishing ${packageName}@${version}...`);
      try {
        publishImpl(packageName, version, report.tarballs?.[key]);
        publishCommandSucceeded.push(entry);
      } catch (error) {
        const detail = errorMessage(error);
        throw new Error(
          `The publish command for ${packageName}@${version} failed.\n`
          + `The registry state of ${packageName}@${version} may be unknown. Query the exact version before retrying.\n`
          + `Registry-verified packages:\n- ${formatEntries(registryVerified).replace(/, /g, '\n- ')}\n`
          + `Publish commands that succeeded:\n- ${formatEntries(publishCommandSucceeded).replace(/, /g, '\n- ')}\n`
          + detail
        );
      }
      try {
        await verifyPublished(key, version, localVersions, {
          viewVersionImpl,
          viewDependenciesImpl,
          viewManagedRuntimeImpl,
          sleepImpl,
          log,
        });
      } catch (error) {
        throw new Error(
          `The publish command succeeded for ${packageName}@${version}, but registry verification failed.\n`
          + `${errorMessage(error)}\n`
          + 'The package may already be published. Do not retry publication until npm registry state is checked.\n'
          + `Publish commands that succeeded:\n- ${formatEntries(publishCommandSucceeded).replace(/, /g, '\n- ')}\n`
          + `Registry-verified packages:\n- ${formatEntries(registryVerified).replace(/, /g, '\n- ')}`
        );
      }
      registryVerified.push(entry);
    }
    await verifyReleaseImpl(localVersions);
    log(toPublish.length === 0 ? 'Release graph verified.' : 'Release graph published and verified.');
    return {
      published: Object.freeze(registryVerified),
      skipped: Object.freeze(toSkip),
      publishCommandSucceeded: Object.freeze(publishCommandSucceeded),
      registryVerified: Object.freeze(registryVerified),
    };
  } finally {
    fs.rmSync(publisherTempRoot, { recursive: true, force: true });
  }
}

async function verifyPublished(key, version, localVersions, impls) {
  const { viewVersionImpl, viewDependenciesImpl, viewManagedRuntimeImpl, sleepImpl, log } = impls;
  const packageName = RELEASE_PACKAGES[key].name;
  let lastDependencyMismatch = null;
  for (let attempt = 1; attempt <= REGISTRY_POLL_ATTEMPTS; attempt += 1) {
    let visible = false;
    try {
      const registryVersion = viewVersionImpl(packageName, version);
      visible = registryVersion === version;
    } catch (error) {
      const classification = classifyRegistryError(error);
      if (classification === 'auth') {
        throw new Error(
          `Registry authentication failed while verifying ${packageName}@${version} after publish: ${errorMessage(error)}`
        );
      }
      if (classification === 'permanent') {
        throw new Error(
          `Registry verification failed for ${packageName}@${version} after publish: ${errorMessage(error)}`
        );
      }
      // Transient network failures and exact-version E404s during propagation
      // continue within the bounded polling window.
    }
    if (visible) {
      if (key === 'core') {
        return;
      }
      if (key === 'mcp') {
        let dependencies;
        try {
          dependencies = viewDependenciesImpl(packageName, version);
        } catch (error) {
          const classification = classifyRegistryError(error);
          if (classification === 'auth') {
            throw new Error(
              `Registry authentication failed while verifying ${packageName}@${version} dependency metadata: ${errorMessage(error)}`
            );
          }
          if (classification === 'permanent') {
            throw new Error(
              `Registry dependency verification failed for ${packageName}@${version} after publish: ${errorMessage(error)}`
            );
          }
          lastDependencyMismatch = `Published ${packageName}@${version} dependency metadata is not visible yet.`;
        }
        if (dependencies?.['@zokizuan/satori-core'] === localVersions.core) {
          return;
        }
        lastDependencyMismatch = dependencies && typeof dependencies === 'object'
          ? `Published ${packageName}@${version} dependency @zokizuan/satori-core is ${JSON.stringify(dependencies['@zokizuan/satori-core'])}, expected ${localVersions.core}`
          : `Published ${packageName}@${version} dependency metadata is not visible yet.`;
      } else {
        let runtime;
        try {
          runtime = viewManagedRuntimeImpl(packageName, version);
        } catch (error) {
          const classification = classifyRegistryError(error);
          if (classification === 'auth') {
            throw new Error(
              `Registry authentication failed while verifying ${packageName}@${version} satoriManagedRuntime metadata: ${errorMessage(error)}`
            );
          }
          if (classification === 'permanent') {
            throw new Error(
              `Registry managed-runtime verification failed for ${packageName}@${version} after publish: ${errorMessage(error)}`
            );
          }
          lastDependencyMismatch = `Published ${packageName}@${version} satoriManagedRuntime metadata is not visible yet.`;
        }
        if (runtime?.core === localVersions.core && runtime?.mcp === localVersions.mcp) {
          return;
        }
        lastDependencyMismatch = runtime && typeof runtime === 'object'
          ? `Published ${packageName}@${version} satoriManagedRuntime targets Core ${JSON.stringify(runtime.core)} and MCP ${JSON.stringify(runtime.mcp)}; expected ${localVersions.core} and ${localVersions.mcp}`
          : `Published ${packageName}@${version} satoriManagedRuntime metadata is not visible yet.`;
      }
    }
    if (attempt < REGISTRY_POLL_ATTEMPTS) {
      if (attempt % REGISTRY_PROGRESS_INTERVAL_ATTEMPTS === 0) {
        const elapsedSeconds = Math.round((attempt * REGISTRY_POLL_INTERVAL_MS) / 1000);
        log(
          `Waiting for npm registry processing: ${packageName}@${version} is not fully visible after ${elapsedSeconds}s...`,
        );
      }
      await sleepImpl(REGISTRY_POLL_INTERVAL_MS);
    }
  }
  const timeoutMinutes = REGISTRY_PROPAGATION_TIMEOUT_MS / 60_000;
  if (lastDependencyMismatch) {
    throw new Error(`${lastDependencyMismatch} after waiting up to ${timeoutMinutes} minutes`);
  }
  throw new Error(
    `${packageName}@${version} was not visible on the registry after waiting up to ${timeoutMinutes} minutes`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const allowUnpushedHead = args.includes('--allow-unpushed-head');
  if (args.some((arg) => arg !== '--allow-unpushed-head')) {
    console.error('Usage: node scripts/publish-release-graph.mjs [--allow-unpushed-head]');
    process.exit(2);
  }
  try {
    await publishReleaseGraph({ allowUnpushedHead });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
