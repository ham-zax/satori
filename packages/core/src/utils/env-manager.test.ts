import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('envManager follows HOME changed after the singleton module loads', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-env-manager-'));
    const savedHome = process.env.HOME;
    const variable = 'SATORI_ENV_MANAGER_HOME_TEST';
    const savedVariable = process.env[variable];
    try {
        const initialHome = path.join(temp, 'initial');
        const currentHome = path.join(temp, 'current');
        fs.mkdirSync(initialHome);
        fs.mkdirSync(path.join(currentHome, '.satori'), { recursive: true });
        fs.writeFileSync(path.join(currentHome, '.satori', '.env'), `${variable}=fake-current-home\n`);
        // Load only after isolating HOME, so even the broken singleton cannot read the real env file.
        process.env.HOME = initialHome;
        delete process.env[variable];
        const { envManager } = await import('./env-manager.js');
        process.env.HOME = currentHome;

        assert.equal(envManager.get(variable), 'fake-current-home');
        assert.equal(envManager.getEnvFilePath(), path.join(currentHome, '.satori', '.env'));
        envManager.set(variable, 'fake-updated-home');
        assert.equal(fs.readFileSync(path.join(currentHome, '.satori', '.env'), 'utf8'), `${variable}=fake-updated-home\n`);
        assert.equal(fs.existsSync(path.join(initialHome, '.satori')), false);

        process.env[variable] = 'process-wins';
        assert.equal(envManager.get(variable), 'process-wins');
        process.env.HOME = initialHome;
        delete process.env[variable];
        assert.equal(envManager.get(variable), undefined);
    } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedVariable === undefined) delete process.env[variable];
        else process.env[variable] = savedVariable;
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

for (const failRename of [false, true]) {
    test(`envManager publishes private files atomically (rename failure: ${failRename})`, async (t) => {
        const home = fs.mkdtempSync(path.resolve('satori-env-private-'));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        t.mock.method(os, 'homedir', () => home);
        const { EnvManager } = await import('./env-manager.js');
        const manager = new EnvManager();
        const envPath = path.join(home, '.satori', '.env');
        const originalWrite = fs.writeFileSync;
        const originalRename = fs.renameSync;
        const failure = new Error('injected rename failure');
        let temporaryPath: string | undefined;
        let renamed = false;
        t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
            assert.notEqual(args[0], envPath, 'never overwrite the published file in place');
            temporaryPath = String(args[0]);
            assert.deepEqual(args[2], { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            return originalWrite(...args);
        });
        t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
            assert.equal(fs.statSync(String(args[0])).mode & 0o777, 0o600);
            assert.equal(args[1], envPath);
            renamed = true;
            if (failRename) throw failure;
            return originalRename(...args);
        });
        if (failRename) {
            fs.mkdirSync(path.dirname(envPath), { mode: 0o700 });
            originalWrite(envPath, 'OTHER=fixture\n', { mode: 0o644 });
            assert.throws(() => manager.set('SETTING', 'fixture'), (error) => error === failure);
            assert.equal(fs.readFileSync(envPath, 'utf8'), 'OTHER=fixture\n');
        } else {
            manager.set('SETTING', 'fixture');
            assert.equal(fs.readFileSync(envPath, 'utf8'), 'SETTING=fixture\n');
            assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
            manager.set('SETTING', 'updated');
            assert.equal(fs.readFileSync(envPath, 'utf8'), 'SETTING=updated\n');
        }
        assert.equal(renamed, true);
        assert.equal(fs.statSync(path.dirname(envPath)).mode & 0o777, 0o700);
        assert.ok(temporaryPath);
        assert.equal(fs.existsSync(temporaryPath), false);
        assert.deepEqual(fs.readdirSync(path.dirname(envPath)), ['.env']);
    });
}
