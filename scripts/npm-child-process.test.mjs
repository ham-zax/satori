import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpmChildEnvironment, REGISTRY_PROBE_STDIO } from './npm-child-process.mjs';

const PNPM_ONLY_ENV_KEYS = Object.freeze([
  'npm_config__jsr_registry',
  'npm_config_auto_install_peers',
  'npm_config_cache_dir',
  'npm_config_child_concurrency',
  'npm_config_dedupe_peer_dependents',
  'npm_config_ignore_workspace_root_check',
  'npm_config_npm_globalconfig',
  'npm_config_prefer_frozen_lockfile',
  'npm_config_shell_emulator',
  'npm_config_store_dir',
  'npm_config_verify_deps_before_run',
]);

const NPM_COMPATIBLE_ENV_KEYS = Object.freeze([
  'npm_config_registry',
  'npm_config_userconfig',
  'npm_config_globalconfig',
  'npm_config_cache',
  'npm_config_proxy',
  'npm_config_http_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
  'npm_config_ca',
  'npm_config_cafile',
  'npm_config_strict_ssl',
  'npm_config_cert',
  'npm_config_key',
  'npm_config_otp',
  'npm_config_provenance',
  'npm_config_access',
  'npm_config_tag',
  'npm_config_loglevel',
  'npm_config_user_agent',
]);

function parentWithPnpmVars() {
  return Object.fromEntries(PNPM_ONLY_ENV_KEYS.map((key) => [key, '1']));
}

test('sanitized environment drops pnpm-only npm config variables', () => {
  const parent = {
    ...parentWithPnpmVars(),
    PATH: '/usr/bin',
    HOME: '/home/user',
  };
  const child = createNpmChildEnvironment(parent);
  for (const key of PNPM_ONLY_ENV_KEYS) {
    assert.equal(key in child, false, `${key} must be removed from the child environment`);
  }
  assert.equal(child.PATH, '/usr/bin');
  assert.equal(child.HOME, '/home/user');
});

test('sanitized environment preserves npm-compatible config variables', () => {
  const parent = Object.fromEntries(NPM_COMPATIBLE_ENV_KEYS.map((key) => [key, 'value']));
  const child = createNpmChildEnvironment(parent);
  for (const key of NPM_COMPATIBLE_ENV_KEYS) {
    assert.equal(child[key], 'value', `${key} must be preserved`);
  }
});

test('sanitized environment preserves non-config variables', () => {
  const parent = {
    HOME: '/home/user',
    PATH: '/usr/bin',
    NODE_AUTH_TOKEN: 'node-token',
    NPM_TOKEN: 'npm-token',
    HTTP_PROXY: 'http://proxy',
    HTTPS_PROXY: 'https://proxy',
    NO_PROXY: 'localhost',
    npm_package_name: '@satori-code/mcp',
    npm_package_version: '6.8.1',
    CUSTOM_KEY: 'kept',
  };
  const child = createNpmChildEnvironment(parent);
  for (const [key, value] of Object.entries(parent)) {
    assert.equal(child[key], value);
  }
});

test('filtering is case-insensitive', () => {
  const parent = {
    NPM_CONFIG_STORE_DIR: '/store',
    Npm_Config_Child_Concurrency: '8',
    NPM_CONFIG__JSR_REGISTRY: 'jsr',
    npm_config_Registry: 'https://registry.npmjs.org/',
    npm_config_USER_AGENT: 'pnpm/10',
  };
  const child = createNpmChildEnvironment(parent);
  assert.equal('NPM_CONFIG_STORE_DIR' in child, false);
  assert.equal('Npm_Config_Child_Concurrency' in child, false);
  assert.equal('NPM_CONFIG__JSR_REGISTRY' in child, false);
  assert.equal(child.npm_config_Registry, 'https://registry.npmjs.org/');
  assert.equal(child.npm_config_USER_AGENT, 'pnpm/10');
});

test('synthetic unknown pnpm config keys are removed', () => {
  const parent = {
    npm_config_virtual_store_dir: '/store',
    npm_config_global_pnpmfile: '/home/user/.pnpmfile.cjs',
    npm_config_registry: 'https://registry.npmjs.org/',
  };
  const child = createNpmChildEnvironment(parent);
  assert.equal('npm_config_virtual_store_dir' in child, false);
  assert.equal('npm_config_global_pnpmfile' in child, false);
  assert.equal(child.npm_config_registry, 'https://registry.npmjs.org/');
});

test('sanitized environment returns a new object and never mutates the parent', () => {
  const parent = { ...parentWithPnpmVars(), PATH: '/bin' };
  const child = createNpmChildEnvironment(parent);
  assert.notEqual(child, parent);
  assert.equal(Object.keys(parent).length, PNPM_ONLY_ENV_KEYS.length + 1);
  for (const key of PNPM_ONLY_ENV_KEYS) {
    assert.equal(parent[key], '1');
  }
});

test('sanitized environment handles empty and default parents', () => {
  assert.deepEqual(createNpmChildEnvironment({}), {});
  const child = createNpmChildEnvironment();
  assert.notEqual(child, process.env);
  assert.equal(child.PATH, process.env.PATH);
  for (const key of PNPM_ONLY_ENV_KEYS) {
    assert.equal(key in child, false);
  }
});

test('registry probe stdio remains captured', () => {
  assert.deepEqual(REGISTRY_PROBE_STDIO, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(Object.freeze(['ignore', 'pipe', 'pipe']), REGISTRY_PROBE_STDIO);
});
