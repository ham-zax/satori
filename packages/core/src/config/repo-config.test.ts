import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSatoriRepoConfig, SatoriRepoConfigAuthorityError } from './repo-config';

test('legacy repo config refuses symbolic links inside and outside the root, including dangling links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-repo-config-'));
    try {
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo);
        const inside = path.join(repo, 'inside.toml');
        const outside = path.join(root, 'outside.toml');
        fs.writeFileSync(inside, '[index]\nprofile = "minimal"\n');
        fs.writeFileSync(outside, '[index]\nprofile = "all-text"\n');
        const config = path.join(repo, 'satori.toml');
        for (const target of [inside, outside, path.join(root, 'missing.toml')]) {
            fs.symlinkSync(target, config);
            assert.throws(() => loadSatoriRepoConfig(repo), (error: unknown) => {
                assert.ok(error instanceof SatoriRepoConfigAuthorityError);
                assert.match(error.message, /symbolic link/);
                return true;
            });
            fs.unlinkSync(config);
        }
        assert.deepEqual(loadSatoriRepoConfig(repo), { profile: 'default' });
        fs.writeFileSync(config, '[index]\nprofile = "minimal"\n');
        assert.deepEqual(loadSatoriRepoConfig(repo), { configPath: config, profile: 'minimal' });
        const alias = path.join(root, 'alias');
        fs.symlinkSync(repo, alias);
        assert.equal(loadSatoriRepoConfig(alias).profile, 'minimal');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('legacy repo config refuses a resolved config path outside the canonical root', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-repo-config-'));
    try {
        const config = path.join(root, 'satori.toml');
        fs.writeFileSync(config, '[index]\nprofile = "minimal"\n');
        const realpath = fs.realpathSync;
        t.mock.method(fs, 'realpathSync', (file: fs.PathLike, ...args: unknown[]) => {
            if (String(file) === config) return path.join(root, '..', 'outside.toml');
            return Reflect.apply(realpath, fs, [file, ...args]);
        });
        assert.throws(() => loadSatoriRepoConfig(root), /outside.*root/);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('legacy repo config refuses a final symlink swapped in during path resolution', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-repo-config-swap-'));
    try {
        const config = path.join(root, 'satori.toml');
        const target = path.join(root, 'target.toml');
        fs.writeFileSync(config, '[index]\nprofile = "default"\n');
        fs.writeFileSync(target, '[index]\nprofile = "minimal"\n');
        const realpath = fs.realpathSync;
        t.mock.method(fs, 'realpathSync', (file: fs.PathLike, ...args: unknown[]) => {
            if (String(file) === config) {
                fs.unlinkSync(config);
                fs.symlinkSync(target, config);
            }
            return Reflect.apply(realpath, fs, [file, ...args]);
        });
        assert.throws(() => loadSatoriRepoConfig(root), /symbolic link|ELOOP/);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
