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
