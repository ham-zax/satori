import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CANONICAL_MASTER_FETCH_ARGS,
  CANONICAL_RELEASE_REF,
  CANONICAL_RELEASE_REPOSITORY,
  publishReleaseGraph,
} from './publish-release-graph.mjs';
import { createNpmChildEnvironment, REGISTRY_PROBE_STDIO } from './npm-child-process.mjs';

const NAMES = {
  core: '@zokizuan/satori-core',
  mcp: '@zokizuan/satori-mcp',
  cli: '@zokizuan/satori-cli',
};

const VERSIONS = Object.freeze({ core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' });

function fakeReport(statuses, extra = {}) {
  return {
    valid: Object.values(statuses).every((status) => status === 'unpublished' || status === 'published-identical'),
    packages: Object.fromEntries(
      Object.entries(statuses).map(([key, status]) => [
        key,
        { key, name: NAMES[key], localVersion: VERSIONS[key], status },
      ])
    ),
    tarballs: extra.tarballs || {
      core: 'verified/@zokizuan/satori-core-3.6.0.tgz',
      mcp: 'verified/@zokizuan/satori-mcp-6.8.0.tgz',
      cli: 'verified/@zokizuan/satori-cli-1.9.0.tgz',
    },
    ...(extra.tempDirectory ? { tempDirectory: extra.tempDirectory } : {}),
  };
}

function verifiedTarballFixture(statuses = { core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' }, parent) {
  const tempDirectory = fs.mkdtempSync(path.join(parent || os.tmpdir(), 'satori-verified-'));
  const tarballs = {
    core: path.join(tempDirectory, 'zokizuan-satori-core-3.6.0.tgz'),
    mcp: path.join(tempDirectory, 'zokizuan-satori-mcp-6.8.0.tgz'),
    cli: path.join(tempDirectory, 'zokizuan-satori-cli-1.9.0.tgz'),
  };
  for (const file of Object.values(tarballs)) {
    fs.writeFileSync(file, 'verified tarball');
  }
  return { tempDirectory, tarballs, report: fakeReport(statuses, { tarballs, tempDirectory }) };
}

function retainedReport(statuses) {
  return (cwd, tempRoot) => {
    const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'satori-release-check-'));
    const tarballs = {
      core: path.join(tempDirectory, 'zokizuan-satori-core-3.6.0.tgz'),
      mcp: path.join(tempDirectory, 'zokizuan-satori-mcp-6.8.0.tgz'),
      cli: path.join(tempDirectory, 'zokizuan-satori-cli-1.9.0.tgz'),
    };
    for (const file of Object.values(tarballs)) {
      fs.writeFileSync(file, 'verified tarball');
    }
    return fakeReport(statuses, { tarballs, tempDirectory });
  };
}

function runnerOptions(extra = {}) {
  const published = [];
  const skipped = [];
  const publishCalls = [];
  const viewCalls = [];
  const sleepCalls = [];
  const verifyReleaseCalls = [];
  const fetchCalls = [];
  const ancestorCalls = [];
  const skippedLatestCalls = [];
  let coreVisibleAfter = 0;
  let mcpDependencies = { '@zokizuan/satori-core': VERSIONS.core };
  let cliManagedRuntime = { core: VERSIONS.core, mcp: VERSIONS.mcp };
  const gitStatusImpl = extra.gitStatusImpl || (() => '');
  const versionsCheckImpl = extra.versionsCheckImpl || (() => '');
  const buildImpl = extra.buildImpl || (() => '');
  const smokeMcpImpl = extra.smokeMcpImpl || (() => '');
  const smokeCliImpl = extra.smokeCliImpl || (() => '');
  const checkGraphImpl = extra.checkGraphImpl || retainedReport({ core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' });
  const options = {
    log: extra.log || (() => {}),
    gitStatusImpl,
    branchImpl: extra.branchImpl || (() => 'master'),
    fetchCanonicalMasterImpl: extra.fetchCanonicalMasterImpl || (() => { fetchCalls.push(true); }),
    headImpl: extra.headImpl || (() => 'release-head'),
    canonicalMasterImpl: extra.canonicalMasterImpl || (() => 'release-head'),
    canonicalMasterIsAncestorImpl: extra.canonicalMasterIsAncestorImpl || (() => {
      ancestorCalls.push(true);
      return true;
    }),
    qualifyImpl: extra.qualifyImpl || (async (tempRoot) => {
      versionsCheckImpl();
      buildImpl();
      smokeMcpImpl();
      smokeCliImpl();
      const status = String(gitStatusImpl()).trim();
      if (status !== '') {
        throw new Error(`Working tree became dirty during release qualification:\n${status}`);
      }
      return checkGraphImpl(extra.cwd || process.cwd(), tempRoot);
    }),
    verifyReleaseImpl: extra.verifyReleaseImpl || ((localVersions) => {
      verifyReleaseCalls.push(localVersions);
    }),
    verifySkippedLatestImpl: extra.verifySkippedLatestImpl || ((packageKeys, localVersions) => {
      skippedLatestCalls.push({ packageKeys, localVersions });
    }),
    sleepImpl: (milliseconds) => {
      sleepCalls.push(milliseconds);
      return Promise.resolve();
    },
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
    ...(extra.execFileSyncImpl ? { execFileSyncImpl: extra.execFileSyncImpl } : {}),
    ...(extra.allowUnpushedHead === true ? { allowUnpushedHead: true } : {}),
  };
  if (!extra.useDefaultExecImpls) {
    options.publishImpl = extra.publishImpl || ((packageName) => {
      publishCalls.push(packageName);
      published.push(packageName);
    });
    options.viewVersionImpl = extra.viewVersionImpl || ((packageName, version) => {
      viewCalls.push(`version:${packageName}@${version}`);
      if (packageName === '@zokizuan/satori-core' && viewCalls.length > coreVisibleAfter) {
        return version;
      }
      return version;
    });
    options.viewDependenciesImpl = extra.viewDependenciesImpl || ((packageName, version) => {
      viewCalls.push(`deps:${packageName}@${version}`);
      return packageName === '@zokizuan/satori-mcp' ? mcpDependencies : {};
    });
    options.viewManagedRuntimeImpl = extra.viewManagedRuntimeImpl || ((packageName, version) => {
      viewCalls.push(`runtime:${packageName}@${version}`);
      return packageName === '@zokizuan/satori-cli' ? cliManagedRuntime : {};
    });
  }
  options.records = {
    publishCalls,
    viewCalls,
    sleepCalls,
    verifyReleaseCalls,
    fetchCalls,
    ancestorCalls,
    skippedLatestCalls,
  };
  return options;
}

test('all-unpublished graph publishes Core, MCP, CLI in order', async () => {
  const options = runnerOptions();
  const result = await publishReleaseGraph(options);
  assert.deepEqual(options.records.publishCalls, ['@zokizuan/satori-core', '@zokizuan/satori-mcp', '@zokizuan/satori-cli']);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
  assert.deepEqual(result.skipped, []);
});

test('published-identical Core is skipped while MCP/CLI publish', async () => {
  const options = runnerOptions({
    checkGraphImpl: retainedReport({ core: 'published-identical', mcp: 'unpublished', cli: 'unpublished' }),
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(options.records.publishCalls, ['@zokizuan/satori-mcp', '@zokizuan/satori-cli']);
  assert.deepEqual(options.records.skippedLatestCalls, [{ packageKeys: ['core'], localVersions: VERSIONS }]);
  assert.deepEqual(result.skipped, ['core']);
});

test('stale latest on a skipped package prevents the first registry write', async () => {
  const options = runnerOptions({
    checkGraphImpl: retainedReport({ core: 'published-identical', mcp: 'unpublished', cli: 'unpublished' }),
    verifySkippedLatestImpl: () => {
      throw new Error('@zokizuan/satori-core@latest is stale');
    },
  });
  await assert.rejects(publishReleaseGraph(options), /satori-core@latest is stale/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('CLI-only release skips Core and MCP', async () => {
  const options = runnerOptions({
    checkGraphImpl: retainedReport({ core: 'published-identical', mcp: 'published-identical', cli: 'unpublished' }),
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(options.records.publishCalls, ['@zokizuan/satori-cli']);
  assert.deepEqual(result.skipped, ['core', 'mcp']);
});

test('stale graph publishes nothing', async () => {
  const options = runnerOptions({
    checkGraphImpl: () => {
      throw new Error('Release graph invalid.');
    },
  });
  await assert.rejects(publishReleaseGraph(options), /Release graph invalid/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('async check graph results are awaited', async () => {
  const options = runnerOptions({
    checkGraphImpl: (cwd, tempRoot) => Promise.resolve(retainedReport({ core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' })(cwd, tempRoot)),
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(options.records.publishCalls, ['@zokizuan/satori-core', '@zokizuan/satori-mcp', '@zokizuan/satori-cli']);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
});

for (const mode of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'E401', 'malformed npm output']) {
  test(`publisher publishes nothing when the registry cannot be verified (${mode})`, async () => {
    const options = runnerOptions({
      checkGraphImpl: () => {
        throw new Error(`registry unavailable: ${mode}`);
      },
    });
    await assert.rejects(publishReleaseGraph(options), new RegExp(mode));
    assert.deepEqual(options.records.publishCalls, []);
  });
}

test('dirty tree publishes nothing', async () => {
  const options = runnerOptions({ gitStatusImpl: () => ' M packages/core/package.json' });
  await assert.rejects(publishReleaseGraph(options), /Working tree is not clean/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('non-master branch publishes nothing', async () => {
  const options = runnerOptions({ branchImpl: () => 'develop' });
  await assert.rejects(publishReleaseGraph(options), /expected master/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('canonical master fetch binds the release repository to a dedicated authority ref', () => {
  assert.equal(CANONICAL_RELEASE_REPOSITORY, 'https://github.com/ham-zax/satori.git');
  assert.equal(CANONICAL_RELEASE_REF, 'refs/remotes/satori-release/master');
  assert.deepEqual(CANONICAL_MASTER_FETCH_ARGS, [
    'fetch',
    '--no-tags',
    CANONICAL_RELEASE_REPOSITORY,
    `+refs/heads/master:${CANONICAL_RELEASE_REF}`,
  ]);
});

test('unpushed or diverged master publishes nothing', async () => {
  const options = runnerOptions({
    headImpl: () => 'local-head',
    canonicalMasterImpl: () => 'canonical-head',
  });
  await assert.rejects(publishReleaseGraph(options), /does not equal canonical release master/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('canonical authority is refetched after qualification before the first registry write', async () => {
  let canonicalReadCount = 0;
  const options = runnerOptions({
    headImpl: () => 'head-a',
    canonicalMasterImpl: () => {
      canonicalReadCount += 1;
      return canonicalReadCount === 1 ? 'head-a' : 'head-b';
    },
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /HEAD head-a does not equal canonical release master head-b/,
  );
  assert.equal(options.records.fetchCalls.length, 2);
  assert.deepEqual(options.records.publishCalls, []);
});

test('explicit emergency override permits only a locally-ahead master', async () => {
  const options = runnerOptions({
    headImpl: () => 'local-head',
    canonicalMasterImpl: () => 'canonical-head',
    allowUnpushedHead: true,
  });
  const result = await publishReleaseGraph(options);
  assert.equal(result.published.length, 3);
  assert.equal(options.records.fetchCalls.length, 2);
  assert.equal(options.records.ancestorCalls.length, 2);
});

test('explicit emergency override rejects stale or diverged history', async () => {
  let fetched = 0;
  const options = runnerOptions({
    headImpl: () => 'local-head',
    canonicalMasterImpl: () => 'canonical-head',
    canonicalMasterIsAncestorImpl: () => false,
    fetchCanonicalMasterImpl: () => { fetched += 1; },
    allowUnpushedHead: true,
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /canonical release master .* is not an ancestor of HEAD/,
  );
  assert.equal(fetched, 1);
  assert.deepEqual(options.records.publishCalls, []);
});

test('Core registry verification failure prevents MCP publish', async () => {
  const options = runnerOptions({
    viewVersionImpl: () => {
      throw { status: 1, stderr: 'npm error code E404\nversion not found' };
    },
  });
  await assert.rejects(publishReleaseGraph(options), /not visible on the registry/);
  assert.deepEqual(options.records.publishCalls, ['@zokizuan/satori-core']);
  assert.equal(options.records.sleepCalls.length, 180);
});

test('MCP dependency mismatch prevents CLI publish', async () => {
  const options = runnerOptions({
    viewDependenciesImpl: (packageName) => {
      if (packageName === '@zokizuan/satori-mcp') {
        return { '@zokizuan/satori-core': '3.5.0' };
      }
      return { '@zokizuan/satori-core': VERSIONS.core, '@zokizuan/satori-mcp': VERSIONS.mcp };
    },
  });
  await assert.rejects(publishReleaseGraph(options), /expected 3\.6\.0/);
  assert.deepEqual(options.records.publishCalls, ['@zokizuan/satori-core', '@zokizuan/satori-mcp']);
});

test('CLI managed-runtime verification succeeds', async () => {
  const options = runnerOptions();
  const result = await publishReleaseGraph(options);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
  const cliRuntimeCalls = options.records.viewCalls.filter((call) => call.includes('@zokizuan/satori-cli') && call.startsWith('runtime:'));
  assert.equal(cliRuntimeCalls.length, 1);
});

test('publish command failure reports uncertain registry state and prior verification', async () => {
  const recordedCalls = [];
  const options = runnerOptions({
    publishImpl: (packageName) => {
      recordedCalls.push(packageName);
      if (packageName === '@zokizuan/satori-mcp') {
        throw new Error('EPUBLISHCONFLICT');
      }
    },
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /The publish command for @zokizuan\/satori-mcp@6\.8\.0 failed\.[\s\S]*registry state of @zokizuan\/satori-mcp@6\.8\.0 may be unknown[\s\S]*Query the exact version before retrying[\s\S]*Registry-verified packages:[\s\S]*@zokizuan\/satori-core@3\.6\.0/,
  );
  assert.deepEqual(recordedCalls, ['@zokizuan/satori-core', '@zokizuan/satori-mcp']);
});

test('registry visibility retries are bounded', async () => {
  const recordedVersionCalls = [];
  const options = runnerOptions({
    viewVersionImpl: (packageName, version) => {
      recordedVersionCalls.push(`${packageName}@${version}`);
      throw { status: 1, stderr: 'npm error code E404\nversion not found' };
    },
  });
  await assert.rejects(publishReleaseGraph(options), /not visible on the registry after waiting up to 15 minutes/);
  assert.deepEqual(recordedVersionCalls, Array.from({ length: 181 }, () => '@zokizuan/satori-core@3.6.0'));
  assert.equal(options.records.sleepCalls.length, 180);
});

test('registry visibility may arrive after the legacy one-minute window', async () => {
  let coreVersionCalls = 0;
  const logs = [];
  const options = runnerOptions({
    log: (line) => logs.push(line),
    viewVersionImpl: (packageName, version) => {
      if (packageName === NAMES.core) {
        coreVersionCalls += 1;
        if (coreVersionCalls <= 13) {
          throw { status: 1, stderr: 'npm error code E404\nversion not found' };
        }
      }
      return version;
    },
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
  assert.equal(coreVersionCalls, 14);
  assert.equal(options.records.sleepCalls.length, 13);
  assert.ok(logs.some((line) => line.includes('Waiting for npm registry processing')));
});

test('publish itself is never automatically retried', async () => {
  let mcpAttempts = 0;
  const options = runnerOptions({
    publishImpl: (packageName) => {
      if (packageName === '@zokizuan/satori-mcp') {
        mcpAttempts += 1;
        throw new Error('EPUBLISHCONFLICT');
      }
    },
  });
  await assert.rejects(publishReleaseGraph(options), /The publish command for @zokizuan\/satori-mcp@6\.8\.0 failed/);
  assert.equal(mcpAttempts, 1);
});

test('default publish uses the exact verified tarballs in graph order', async () => {
  const calls = [];
  const execFileSyncImpl = (command, args, callOptions) => {
    calls.push({ command, args, callOptions });
    if (command === 'npm' && args[0] === 'view') {
      if (args.includes('dependencies')) {
        return JSON.stringify({ '@zokizuan/satori-core': VERSIONS.core });
      }
      if (args.includes('satoriManagedRuntime')) {
        return JSON.stringify({ core: VERSIONS.core, mcp: VERSIONS.mcp });
      }
      return JSON.stringify(args[1].slice(args[1].lastIndexOf('@') + 1));
    }
    return '';
  };
  let fixture = null;
  const options = runnerOptions({
    useDefaultExecImpls: true,
    execFileSyncImpl,
    versionsCheckImpl: () => execFileSyncImpl('pnpm', ['run', 'versions:check'], {}),
    buildImpl: () => execFileSyncImpl('pnpm', ['run', 'build'], {}),
    smokeMcpImpl: () => execFileSyncImpl('pnpm', ['-C', 'packages/mcp', 'release:smoke'], {}),
    smokeCliImpl: () => execFileSyncImpl('pnpm', ['-C', 'packages/cli', 'release:smoke'], {}),
    checkGraphImpl: (cwd, tempRoot) => {
      fixture = verifiedTarballFixture(undefined, tempRoot);
      return fixture.report;
    },
  });
  const result = await publishReleaseGraph(options);
  assert.equal(result.published.length, 3);
  const { tarballs } = fixture;
  const expectedEnv = createNpmChildEnvironment(process.env);
  const publishCalls = calls.filter((call) => call.command === 'npm' && call.args[0] === 'publish');
  assert.equal(publishCalls.length, 3);
  assert.deepEqual(
    publishCalls.map((call) => call.args),
    [
      ['publish', tarballs.core, '--registry', 'https://registry.npmjs.org/', '--tag', 'latest', '--access', 'public'],
      ['publish', tarballs.mcp, '--registry', 'https://registry.npmjs.org/', '--tag', 'latest', '--access', 'public'],
      ['publish', tarballs.cli, '--registry', 'https://registry.npmjs.org/', '--tag', 'latest', '--access', 'public'],
    ]
  );
  for (const call of publishCalls) {
    assert.equal(call.callOptions.stdio, 'inherit');
    assert.deepEqual(call.callOptions.env, expectedEnv);
    assert.equal('encoding' in call.callOptions, false);
    assert.equal(call.callOptions.cwd, process.cwd());
  }
  const probeCalls = calls.filter((call) => call.command === 'npm' && call.args[0] === 'view');
  assert.equal(probeCalls.length, 5);
  for (const call of probeCalls) {
    assert.deepEqual(call.callOptions.stdio, REGISTRY_PROBE_STDIO);
    assert.deepEqual(call.callOptions.env, expectedEnv);
    assert.deepEqual(call.args.slice(-2), ['--registry', 'https://registry.npmjs.org/']);
  }
  const pnpmCalls = calls.filter((call) => call.command === 'pnpm');
  assert.equal(pnpmCalls.length, 4);
  for (const call of pnpmCalls) {
    assert.equal('env' in call.callOptions, false);
    assert.equal(call.args.includes('publish'), false);
    assert.equal(call.args.includes('pack'), false);
  }
});

test('EOTP failure reports no verified publication and runs no verification', async () => {
  const options = runnerOptions({
    publishImpl: () => {
      const error = new Error('Command failed: pnpm publish');
      error.status = 1;
      error.stderr = 'npm error code EOTP\nThis operation requires a one-time password.';
      throw error;
    },
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /The publish command for @zokizuan\/satori-core@3\.6\.0 failed\.[\s\S]*registry state of @zokizuan\/satori-core@3\.6\.0 may be unknown[\s\S]*Query the exact version before retrying/,
  );
  assert.deepEqual(options.records.viewCalls, []);
  assert.deepEqual(options.records.sleepCalls, []);
});

test('EOTP failure on a later package keeps verified names and stops verification', async () => {
  const publishAttempts = [];
  const options = runnerOptions({
    publishImpl: (packageName) => {
      publishAttempts.push(packageName);
      if (packageName === '@zokizuan/satori-mcp') {
        const error = new Error('Command failed: pnpm publish');
        error.status = 1;
        error.stderr = 'npm error code EOTP\nThis operation requires a one-time password.';
        throw error;
      }
    },
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /The publish command for @zokizuan\/satori-mcp@6\.8\.0 failed\.[\s\S]*Registry-verified packages:[\s\S]*@zokizuan\/satori-core@3\.6\.0/,
  );
  assert.deepEqual(publishAttempts, ['@zokizuan/satori-core', '@zokizuan/satori-mcp']);
  const coreVerifications = options.records.viewCalls.filter(
    (call) => call.startsWith('version:') && call.includes('satori-core')
  );
  assert.equal(coreVerifications.length, 1);
  assert.equal(options.records.viewCalls.filter((call) => call.includes('satori-mcp')).length, 0);
});

test('build and release smokes run before graph validation', async () => {
  const order = [];
  const options = runnerOptions({
    versionsCheckImpl: () => order.push('versionsCheck'),
    buildImpl: () => order.push('build'),
    smokeMcpImpl: () => order.push('smokeMcp'),
    smokeCliImpl: () => order.push('smokeCli'),
    checkGraphImpl: (cwd, tempRoot) => {
      order.push('checkGraph');
      return retainedReport({ core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' })(cwd, tempRoot);
    },
    publishImpl: () => order.push('publish'),
  });
  await publishReleaseGraph(options);
  const checkIndex = order.indexOf('checkGraph');
  assert.ok(order.indexOf('versionsCheck') < checkIndex);
  assert.ok(order.indexOf('build') < checkIndex);
  assert.ok(order.indexOf('smokeMcp') < checkIndex);
  assert.ok(order.indexOf('smokeCli') < checkIndex);
  assert.ok(order.indexOf('publish') > checkIndex);
});

test('graph validation sees the post-build state', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-cwd-'));
  const builtMarker = path.join(cwd, 'built.marker');
  try {
    const options = runnerOptions({
      cwd,
      buildImpl: () => fs.writeFileSync(builtMarker, 'final artifacts'),
      checkGraphImpl: (cwd, tempRoot) => {
        if (!fs.existsSync(builtMarker)) {
          throw new Error('graph validated before build completed');
        }
        return retainedReport({ core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' })(cwd, tempRoot);
      },
    });
    const result = await publishReleaseGraph(options);
    assert.equal(result.published.length, 3);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dirty tree after build or smokes prevents every publish call', async () => {
  let statusCalls = 0;
  let graphChecked = false;
  const options = runnerOptions({
    gitStatusImpl: () => {
      statusCalls += 1;
      return statusCalls === 1 ? '' : ' M server.json';
    },
    checkGraphImpl: (cwd, tempRoot) => {
      graphChecked = true;
      return retainedReport({ core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' })(cwd, tempRoot);
    },
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /Working tree became dirty during release qualification/
  );
  assert.equal(statusCalls, 2);
  assert.equal(graphChecked, false);
  assert.deepEqual(options.records.publishCalls, []);
});

test('publisher verifies the complete release closure after publication', async () => {
  const options = runnerOptions();
  await publishReleaseGraph(options);
  assert.deepEqual(options.records.verifyReleaseCalls, [VERSIONS]);
});

test('verified tarballs exist during publishing and publisher-owned storage is cleaned after success', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const seen = [];
  let createdRetainedDir = null;
  let receivedTempRoot = null;
  const options = runnerOptions({
    tempRoot: parent,
    checkGraphImpl: (cwd, tempRoot) => {
      receivedTempRoot = tempRoot;
      const fixture = verifiedTarballFixture(undefined, tempRoot);
      createdRetainedDir = fixture.tempDirectory;
      return fixture.report;
    },
    publishImpl: (packageName, version, tarballPath) => {
      seen.push({ packageName, exists: fs.existsSync(tarballPath) });
    },
  });
  const result = await publishReleaseGraph(options);
  assert.equal(result.published.length, 3);
  assert.deepEqual(
    seen.map((entry) => entry.exists),
    [true, true, true]
  );
  assert.equal(fs.existsSync(receivedTempRoot), false);
  assert.equal(fs.existsSync(createdRetainedDir), false);
  assert.deepEqual(fs.readdirSync(parent), []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('publisher-owned storage is cleaned after a publish failure', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  let receivedTempRoot = null;
  let createdRetainedDir = null;
  const options = runnerOptions({
    tempRoot: parent,
    checkGraphImpl: (cwd, tempRoot) => {
      receivedTempRoot = tempRoot;
      const fixture = verifiedTarballFixture(undefined, tempRoot);
      createdRetainedDir = fixture.tempDirectory;
      return fixture.report;
    },
    publishImpl: (packageName) => {
      if (packageName === '@zokizuan/satori-mcp') {
        throw new Error('EPUBLISHCONFLICT');
      }
    },
  });
  await assert.rejects(publishReleaseGraph(options), /may be unknown/);
  assert.equal(fs.existsSync(receivedTempRoot), false);
  assert.equal(fs.existsSync(createdRetainedDir), false);
  assert.deepEqual(fs.readdirSync(parent), []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a successful publish with failed registry verification is reported without retrying', async () => {
  const options = runnerOptions({
    viewDependenciesImpl: (packageName) => {
      if (packageName === NAMES.mcp) {
        return { '@zokizuan/satori-core': '3.5.0' };
      }
      return { '@zokizuan/satori-core': VERSIONS.core, '@zokizuan/satori-mcp': VERSIONS.mcp };
    },
  });
  await assert.rejects(
    publishReleaseGraph(options),
    /The publish command succeeded for @zokizuan\/satori-mcp@6\.8\.0,[\s\S]*registry verification failed[\s\S]*Publish commands that succeeded:[\s\S]*@zokizuan\/satori-core@3\.6\.0[\s\S]*@zokizuan\/satori-mcp@6\.8\.0[\s\S]*Registry-verified packages:[\s\S]*@zokizuan\/satori-core@3\.6\.0/,
  );
  assert.deepEqual(options.records.publishCalls, [NAMES.core, NAMES.mcp]);
  assert.equal(options.records.viewCalls.filter((call) => call.startsWith('version:') && call.includes(NAMES.cli)).length, 0);
});

test('dependency metadata that appears after the version is polled until it matches', async () => {
  let dependencyCalls = 0;
  const options = runnerOptions({
    viewDependenciesImpl: (packageName) => {
      if (packageName === NAMES.mcp) {
        dependencyCalls += 1;
        return dependencyCalls < 3 ? {} : { '@zokizuan/satori-core': VERSIONS.core };
      }
      return { '@zokizuan/satori-core': VERSIONS.core, '@zokizuan/satori-mcp': VERSIONS.mcp };
    },
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
  assert.equal(dependencyCalls, 3);
  assert.equal(options.records.sleepCalls.length, 2);
});

test('incorrect dependency pins remain bounded and fail after all verification attempts', async () => {
  let dependencyCalls = 0;
  const options = runnerOptions({
    viewDependenciesImpl: (packageName) => {
      if (packageName === NAMES.mcp) {
        dependencyCalls += 1;
        return { '@zokizuan/satori-core': '3.5.0' };
      }
      return { '@zokizuan/satori-core': VERSIONS.core, '@zokizuan/satori-mcp': VERSIONS.mcp };
    },
  });
  await assert.rejects(publishReleaseGraph(options), /expected 3\.6\.0/);
  assert.equal(dependencyCalls, 181);
  assert.equal(options.records.sleepCalls.length, 180);
  assert.deepEqual(options.records.publishCalls, [NAMES.core, NAMES.mcp]);
});

test('a malformed report is rejected and its foreign temp path is never deleted', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const fixture = verifiedTarballFixture(undefined, parent);
  const options = runnerOptions({
    tempRoot: parent,
    checkGraphImpl: () => ({ valid: true, tempDirectory: fixture.tempDirectory, packages: null }),
  });
  await assert.rejects(publishReleaseGraph(options), /packages are missing/);
  assert.equal(fs.existsSync(fixture.tempDirectory), true);
  assert.deepEqual(fs.readdirSync(parent), [path.basename(fixture.tempDirectory)]);
  assert.deepEqual(options.records.publishCalls, []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a malformed report cannot delete unrelated paths', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-home-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-repo-'));
  fs.writeFileSync(path.join(cwd, 'marker'), 'keep');
  fs.writeFileSync(path.join(home, 'marker'), 'keep');
  fs.writeFileSync(path.join(repoRoot, 'marker'), 'keep');
  const fixture = verifiedTarballFixture(undefined, parent);
  const options = runnerOptions({
    tempRoot: parent,
    cwd,
    checkGraphImpl: () => ({
      valid: true,
      tempDirectory: fixture.tempDirectory,
      packages: null,
      tarballs: { core: path.join(home, 'core.tgz') },
    }),
  });
  await assert.rejects(publishReleaseGraph(options), /packages are missing/);
  for (const dir of [cwd, home, repoRoot, fixture.tempDirectory]) {
    assert.equal(fs.existsSync(dir), true, `${dir} must not be removed`);
  }
  assert.deepEqual(fs.readdirSync(parent), [path.basename(fixture.tempDirectory)]);
  for (const dir of [cwd, home, repoRoot, parent]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real checker receives the publisher root and its retained child is deleted on success and failure', async () => {
  for (const outcome of ['success', 'failure']) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
    let receivedTempRoot = null;
    let createdRetainedDir = null;
    const options = runnerOptions({
      tempRoot: parent,
      checkGraphImpl: (cwd, tempRoot) => {
        receivedTempRoot = tempRoot;
        createdRetainedDir = fs.mkdtempSync(path.join(tempRoot, 'satori-release-check-'));
        const tarballs = {
          core: path.join(createdRetainedDir, 'zokizuan-satori-core-3.6.0.tgz'),
          mcp: path.join(createdRetainedDir, 'zokizuan-satori-mcp-6.8.0.tgz'),
          cli: path.join(createdRetainedDir, 'zokizuan-satori-cli-1.9.0.tgz'),
        };
        for (const file of Object.values(tarballs)) {
          fs.writeFileSync(file, 'verified tarball');
        }
        return fakeReport(
          { core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' },
          { tarballs, tempDirectory: createdRetainedDir },
        );
      },
      publishImpl: (packageName) => {
        if (outcome === 'failure' && packageName === NAMES.mcp) {
          throw new Error('EPUBLISHCONFLICT');
        }
      },
    });
    if (outcome === 'success') {
      await publishReleaseGraph(options);
    } else {
      await assert.rejects(publishReleaseGraph(options), /may be unknown/);
    }
    assert.ok(receivedTempRoot, 'checker must receive the publisher-created root');
    assert.ok(createdRetainedDir && createdRetainedDir.startsWith(receivedTempRoot));
    assert.equal(fs.existsSync(receivedTempRoot), false, `${outcome}: publisher root must be removed`);
    assert.equal(fs.existsSync(createdRetainedDir), false, `${outcome}: retained child must be removed`);
    assert.deepEqual(fs.readdirSync(parent), []);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a report pointing at a foreign retained directory is rejected without publishing', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const foreign = verifiedTarballFixture(undefined, parent);
  let receivedTempRoot = null;
  const options = runnerOptions({
    tempRoot: parent,
    checkGraphImpl: (cwd, tempRoot) => {
      receivedTempRoot = tempRoot;
      return foreign.report;
    },
    publishImpl: () => {},
  });
  await assert.rejects(publishReleaseGraph(options), /outside the publisher-owned root/);
  assert.deepEqual(options.records.publishCalls, []);
  assert.equal(fs.existsSync(foreign.tempDirectory), true, 'foreign directory must not be deleted');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a foreign tarball with the expected filename is rejected without publishing', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-foreign-tarball-'));
  const foreignTarball = path.join(foreignDir, 'zokizuan-satori-core-3.6.0.tgz');
  fs.writeFileSync(foreignTarball, 'foreign');
  let receivedTempRoot = null;
  const options = runnerOptions({
    tempRoot: parent,
    checkGraphImpl: (cwd, tempRoot) => {
      receivedTempRoot = tempRoot;
      const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'satori-release-check-'));
      const tarballs = {
        core: foreignTarball,
        mcp: path.join(tempDirectory, 'zokizuan-satori-mcp-6.8.0.tgz'),
        cli: path.join(tempDirectory, 'zokizuan-satori-cli-1.9.0.tgz'),
      };
      for (const [key, file] of Object.entries(tarballs)) {
        if (key !== 'core') {
          fs.writeFileSync(file, 'verified tarball');
        }
      }
      return fakeReport(
        { core: 'unpublished', mcp: 'unpublished', cli: 'unpublished' },
        { tarballs, tempDirectory },
      );
    },
    publishImpl: () => {},
  });
  await assert.rejects(publishReleaseGraph(options), /outside the retained verification directory/);
  assert.deepEqual(options.records.publishCalls, []);
  assert.equal(fs.existsSync(foreignTarball), true, 'foreign tarball must not be deleted');
  fs.rmSync(parent, { recursive: true, force: true });
  fs.rmSync(foreignDir, { recursive: true, force: true });
});

test('a report with an unknown status publishes nothing', async () => {
  const options = runnerOptions({
    checkGraphImpl: () => ({
      valid: true,
      packages: {
        core: { key: 'core', name: NAMES.core, localVersion: VERSIONS.core, status: 'unpublished' },
        mcp: { key: 'mcp', name: NAMES.mcp, localVersion: VERSIONS.mcp, status: 'unknown' },
        cli: { key: 'cli', name: NAMES.cli, localVersion: VERSIONS.cli, status: 'unpublished' },
      },
    }),
  });
  await assert.rejects(publishReleaseGraph(options), /known status/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('a report with a wrong package key publishes nothing', async () => {
  const options = runnerOptions({
    checkGraphImpl: () => ({
      valid: true,
      packages: {
        core: { key: 'core', name: NAMES.core, localVersion: VERSIONS.core, status: 'unpublished' },
        mcp: { key: 'mcp', name: NAMES.mcp, localVersion: VERSIONS.mcp, status: 'unpublished' },
        cli: { key: 'not-cli', name: NAMES.cli, localVersion: VERSIONS.cli, status: 'unpublished' },
      },
    }),
  });
  await assert.rejects(publishReleaseGraph(options), /must carry its key/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('a report with a wrong package name publishes nothing', async () => {
  const options = runnerOptions({
    checkGraphImpl: () => ({
      valid: true,
      packages: {
        core: { key: 'core', name: 'wrong-core', localVersion: VERSIONS.core, status: 'unpublished' },
        mcp: { key: 'mcp', name: NAMES.mcp, localVersion: VERSIONS.mcp, status: 'unpublished' },
        cli: { key: 'cli', name: NAMES.cli, localVersion: VERSIONS.cli, status: 'unpublished' },
      },
    }),
  });
  await assert.rejects(publishReleaseGraph(options), /must carry its key/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('a truthy non-boolean valid flag publishes nothing', async () => {
  const options = runnerOptions({
    checkGraphImpl: () => ({
      valid: 'yes',
      packages: {
        core: { key: 'core', name: NAMES.core, localVersion: VERSIONS.core, status: 'unpublished' },
        mcp: { key: 'mcp', name: NAMES.mcp, localVersion: VERSIONS.mcp, status: 'unpublished' },
        cli: { key: 'cli', name: NAMES.cli, localVersion: VERSIONS.cli, status: 'unpublished' },
      },
    }),
  });
  await assert.rejects(publishReleaseGraph(options), /valid must be exactly true/);
  assert.deepEqual(options.records.publishCalls, []);
});

test('transient version-lookup failures retry within the bounded window', async () => {
  let coreVersionCalls = 0;
  const options = runnerOptions({
    viewVersionImpl: (packageName, version) => {
      if (packageName === NAMES.core) {
        coreVersionCalls += 1;
        if (coreVersionCalls < 4) {
          throw { status: 1, stderr: 'npm error code ETIMEDOUT\nrequest timed out' };
        }
      }
      return version;
    },
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
  assert.equal(coreVersionCalls, 4);
  assert.equal(options.records.sleepCalls.length, 3);
});

test('HTTP 5xx and ECONNRESET during verification are transient', async () => {
  let versionCalls = 0;
  const options = runnerOptions({
    viewVersionImpl: (packageName, version) => {
      versionCalls += 1;
      if (packageName === NAMES.core && versionCalls === 1) {
        throw { status: 1, stderr: 'npm error HTTP 503 Service Unavailable' };
      }
      if (packageName === NAMES.mcp && versionCalls === 2) {
        throw { status: 1, stderr: 'npm error code ECONNRESET\nsocket closed' };
      }
      return version;
    },
  });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(result.published.map((entry) => entry.key), ['core', 'mcp', 'cli']);
});

test('authentication failures during verification fail immediately', async () => {
  let versionCalls = 0;
  const options = runnerOptions({
    viewVersionImpl: (packageName, version) => {
      versionCalls += 1;
      throw { status: 1, stderr: 'npm error code E401\nUnauthorized' };
    },
  });
  await assert.rejects(publishReleaseGraph(options), /authentication failed while verifying/);
  assert.equal(versionCalls, 1);
  assert.equal(options.records.sleepCalls.length, 0);
});

test('authentication failures during dependency verification fail immediately', async () => {
  let dependencyCalls = 0;
  const options = runnerOptions({
    viewDependenciesImpl: (packageName) => {
      if (packageName === NAMES.mcp) {
        dependencyCalls += 1;
        throw { status: 1, stderr: 'npm error code E403\nForbidden' };
      }
      return { '@zokizuan/satori-core': VERSIONS.core, '@zokizuan/satori-mcp': VERSIONS.mcp };
    },
  });
  await assert.rejects(publishReleaseGraph(options), /authentication failed while verifying/);
  assert.equal(dependencyCalls, 1);
});

test('publisher rejects a verified tarball outside the retained verification directory', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-outside-tarball-'));
  const outsideTarball = path.join(outsideRoot, 'zokizuan-satori-core-3.6.0.tgz');
  fs.writeFileSync(outsideTarball, 'outside');
  const calls = [];
  const options = runnerOptions({
    tempRoot: parent,
    useDefaultExecImpls: true,
    execFileSyncImpl: (command, args) => {
      calls.push({ command, args });
      return '';
    },
    checkGraphImpl: (cwd, tempRoot) => {
      const fixture = verifiedTarballFixture(
        { core: 'unpublished', mcp: 'published-identical', cli: 'published-identical' },
        tempRoot,
      );
      return fakeReport(
        { core: 'unpublished', mcp: 'published-identical', cli: 'published-identical' },
        { tarballs: { ...fixture.tarballs, core: outsideTarball }, tempDirectory: fixture.tempDirectory },
      );
    },
  });
  await assert.rejects(publishReleaseGraph(options), /outside the retained verification directory/);
  assert.equal(calls.some((call) => call.command === 'npm' && call.args[0] === 'publish'), false);
  assert.equal(fs.existsSync(outsideTarball), true);
  assert.deepEqual(fs.readdirSync(parent), []);
  fs.rmSync(parent, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

test('publisher rejects a symlink tarball before publishing', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const calls = [];
  let createdRetainedDir = null;
  const options = runnerOptions({
    tempRoot: parent,
    useDefaultExecImpls: true,
    execFileSyncImpl: (command, args) => {
      calls.push({ command, args });
      return '';
    },
    checkGraphImpl: (cwd, tempRoot) => {
      const fixture = verifiedTarballFixture(undefined, tempRoot);
      createdRetainedDir = fixture.tempDirectory;
      const outsideTarball = path.join(fixture.tempDirectory, 'real-core.tgz');
      fs.writeFileSync(outsideTarball, 'outside');
      fs.rmSync(fixture.tarballs.core);
      fs.symlinkSync(outsideTarball, fixture.tarballs.core);
      return fixture.report;
    },
  });
  await assert.rejects(publishReleaseGraph(options), /symbolic link/);
  assert.equal(calls.some((call) => call.command === 'npm' && call.args[0] === 'publish'), false);
  assert.equal(fs.existsSync(createdRetainedDir), false);
  assert.deepEqual(fs.readdirSync(parent), []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('published-identical graph cleans publisher-owned verification storage', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-publish-parent-'));
  const fixture = verifiedTarballFixture({ core: 'published-identical', mcp: 'published-identical', cli: 'published-identical' }, parent);
  const options = runnerOptions({ tempRoot: parent, checkGraphImpl: () => fixture.report });
  const result = await publishReleaseGraph(options);
  assert.deepEqual(result.published, []);
  assert.deepEqual(fs.readdirSync(parent), [path.basename(fixture.tempDirectory)]);
  fs.rmSync(parent, { recursive: true, force: true });
});
