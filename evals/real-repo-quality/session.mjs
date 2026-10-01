// Spawns the LOCAL workspace MCP build over stdio with the default offline profile, isolated in its own state root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mcpRequire = createRequire(path.join(workspaceRoot, 'packages/mcp/package.json'));

async function sdk(subpath) {
    return import(pathToFileURL(mcpRequire.resolve(`@modelcontextprotocol/sdk/${subpath}`)).href);
}

/** Non-secret runtime selection of the user's installed offline profile (models, embedding, reranker). */
function installedOfflineEnvironment(home) {
    const launcher = path.join(home, '.satori', 'bin', 'satori-mcp.js');
    const line = fs.readFileSync(launcher, 'utf8').split(/\r?\n/).find((l) => l.startsWith('const managedEnv = '));
    if (!line) throw new Error(`No managed runtime environment in ${launcher}; run "satori install --runtime offline" first.`);
    return JSON.parse(line.slice('const managedEnv = '.length, -1));
}

/** Bind the local build's profile identities while reusing installed model artifacts. */
export async function localOfflineEnvironment(home = os.homedir()) {
    const env = installedOfflineEnvironment(home);
    if (env.SATORI_RERANKER_PROVIDER === 'lateon') {
        const { DEFAULT_LATEON_PROFILE_ID, DEFAULT_LATEON_ACTIVATION_POLICY } = await import(
            pathToFileURL(path.join(workspaceRoot, 'packages/cli/dist/lateon-model-store.js')).href
        );
        if (!DEFAULT_LATEON_PROFILE_ID || !DEFAULT_LATEON_ACTIVATION_POLICY) throw new Error('Build the current CLI profile constants before benchmarking the local runtime.');
        env.SATORI_LATEON_PROFILE = DEFAULT_LATEON_PROFILE_ID;
        env.SATORI_LATEON_ACTIVATION_POLICY = DEFAULT_LATEON_ACTIVATION_POLICY;
    }
    return env;
}

export async function openLocalSession({ stateRoot, roots, home = os.homedir() }) {
    const { Client } = await sdk('client/index.js');
    const { StdioClientTransport } = await sdk('client/stdio.js');
    fs.mkdirSync(stateRoot, { recursive: true });
    const modelsLink = path.join(stateRoot, 'models');
    if (!fs.existsSync(modelsLink)) fs.symlinkSync(path.join(home, '.satori', 'models'), modelsLink);
    const env = {
        ...process.env,
        ...await localOfflineEnvironment(home),
        SATORI_STATE_ROOT: stateRoot,
        SATORI_SESSION_ROOTS_JSON: JSON.stringify(roots),
        LANCEDB_PATH: path.join(stateRoot, 'vector', 'lancedb'),
        POTION_HELPER_PATH: path.join(workspaceRoot, 'packages/mcp/assets/potion/linux-x64/satori-potion'),
    };
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(workspaceRoot, 'packages/mcp/dist/index.js')],
        env,
        stderr: 'pipe',
    });
    const client = new Client({ name: 'real-repo-quality', version: '1' });
    // Keep the server's stderr (timestamped) so hangs and warnings are part of the raw data.
    const stderr = [];
    const stderrDecoder = new StringDecoder('utf8');
    transport.stderr?.on('data', (chunk) => stderr.push({ at: new Date().toISOString(), text: stderrDecoder.write(chunk) }));
    // Transport-level problems (e.g. a non-JSON-RPC line on the server's stdout) with their raw text.
    const protocolErrors = [];
    client.onerror = (error) => protocolErrors.push({ at: new Date().toISOString(), source: 'client.onerror', message: error?.message ?? String(error) });
    await client.connect(transport);
    let pending = '';
    const stdoutDecoder = new StringDecoder('utf8');
    transport._process?.stdout?.on('data', (chunk) => {
        pending += stdoutDecoder.write(chunk);
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try { JSON.parse(line); } catch { protocolErrors.push({ at: new Date().toISOString(), source: 'stdout-tap', raw: line }); }
        }
    });
    return {
        processId: transport._process?.pid,
        stderr,
        protocolErrors,
        async call(name, args) {
            const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 });
            const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
            let json;
            try { json = JSON.parse(text); } catch { /* text-only response */ }
            return { text, json, isError: result.isError === true };
        },
        close: () => client.close(),
    };
}
