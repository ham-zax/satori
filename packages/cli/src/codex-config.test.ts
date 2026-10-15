import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { parseCodexConfig, updateCodexConfig } from "./codex-config.js";
import { SATORI_RUNTIME_ENV_VARS } from "./install-contracts.js";
import { prepareConfigMutation } from "./client-config-mutations.js";
import { hasSatoriClientEntry, readCodexRuntimeEnvironment, readCodexVectorStore, verifyManagedClientTarget } from "./client-config-inspection.js";
import { readConfiguredClientVectorStore } from "./runtime-selection.js";

const runtime = { command: process.execPath, args: ["/test-home/.satori/bin/satori-mcp.js"] };
const start = "# >>> satori-cli managed satori start >>>";
const end = "# <<< satori-cli managed satori end <<<";
const wiring = `command = ${JSON.stringify(runtime.command)}\nargs = ${JSON.stringify(runtime.args)}\n`;
const install = (content: string) => updateCodexConfig(content, "fixture.toml", runtime, "install");
const uninstall = (content: string) => updateCodexConfig(content, "fixture.toml", runtime, "uninstall");

function withConfig(run: (configPath: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-codex-config-"));
    try { run(path.join(dir, "config.toml")); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("Codex rewrites and displaced markers never own unrelated config", () => {
    const unrelated = '\n# user server\n[mcp_servers.other]\ncommand = "keep-me"\n\n[[skills.config]]\npath = "/keep"\nenabled = true\n';
    for (const markers of [[start, end], ["", end], [start, ""], ["", ""], [end, start], [start + "\n" + start, end]]) {
        const content = `model = "example"\n${markers[0]}\n[mcp_servers.satori]\n${wiring}${unrelated}${markers[1]}\n`;
        const updated = install(content);
        assert.ok(updated.includes(unrelated));
        assert.equal(updated.includes(start), false);
        assert.equal(updated.includes(end), false);
        assert.deepEqual(parseCodexConfig(updated).entry?.args, runtime.args);
        assert.equal(install(updated), updated);
        const removed = uninstall(updated);
        assert.ok(removed.includes(unrelated));
        assert.equal(parseCodexConfig(removed).entry, undefined);
    }
});

test("TOML spellings share ownership, precise edits, and semantic inspection", () => {
    const cmd = JSON.stringify(runtime.command);
    const arg = JSON.stringify(runtime.args[0]);
    const forms = [
        `[mcp_servers."satori"]\ncommand = ${cmd}\nargs = [\n ${arg}, # launcher\n]\n`,
        `mcp_servers.satori.command = ${cmd}\nmcp_servers.satori.args = [${arg}]\n`,
        `[mcp_servers]\nsatori.command = ${cmd}\nsatori.args = [${arg}]\n`,
        `mcp_servers.satori = { args = [${arg}], command = ${cmd} }\n`,
        `mcp_servers = { satori = { command = ${cmd}, args = [${arg}] }, other = { command = "keep" } }\n`,
        `[mcp_servers]\nsatori = { command = ${cmd}, args = [${arg}] }\n`,
        `[mcp_servers.satori]\ncommand = '${runtime.command}'\nargs = ['${runtime.args[0]}']\n`,
    ];
    for (const content of forms) {
        const updated = install(content);
        const entry = parseCodexConfig(updated).entry;
        assert.equal(entry?.command, runtime.command);
        assert.deepEqual(entry?.args, runtime.args);
        assert.deepEqual(entry?.env_vars, [...SATORI_RUNTIME_ENV_VARS]);
        assert.equal(install(updated), updated);
        assert.equal(parseCodexConfig(uninstall(updated)).entry, undefined);
        withConfig((configPath) => {
            fs.writeFileSync(configPath, updated);
            const target = { client: "codex" as const, configPath, companions: [] };
            assert.equal(hasSatoriClientEntry(target), true);
            assert.equal(verifyManagedClientTarget(target, runtime).status, "ok");
        });
    }
});

test("fresh install handles empty, implicit, and inline parent tables", () => {
    for (const [content, preserved] of [["", ""], ['model = "example"', 'model = "example"'], ['mcp_servers = { other = { command = "keep" } }\n', 'other = { command = "keep" }'], ['[mcp_servers.satori.env]\nOPENAI_API_KEY = "keep"\n', 'OPENAI_API_KEY = "keep"\n']]) {
        const updated = install(content);
        assert.deepEqual(parseCodexConfig(updated).entry?.args, runtime.args);
        assert.equal(install(updated), updated);
        assert.ok(updated.includes(preserved));
    }
});

test("new Codex wiring formats env vars and uninstall removes installer comments", () => {
    const created = install("");
    assert.ok(created.indexOf("# Runtime selection is installer-owned") < created.indexOf("[mcp_servers.satori]"));
    assert.ok(created.includes(`env_vars = [${SATORI_RUNTIME_ENV_VARS.map((name) => JSON.stringify(name)).join(", ")}]`));
    assert.equal(uninstall(created).trim(), "");

    const otherServer = '[mcp_servers.other]\ncommand = "keep-me"\n';
    const comments = "# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js.\n"
        + "# env_vars forwards optional credentials and operational overrides.\n";
    const content = `${otherServer}\n${comments}[mcp_servers.satori]\n${wiring}`;
    const removed = uninstall(content);
    assert.ok(removed.includes(otherServer));
    assert.equal(removed.includes(comments), false);
    assert.equal(parseCodexConfig(removed).entry, undefined);
    assert.equal(uninstall(`${comments}${otherServer}`), otherServer);
});

test("install and uninstall preserve user options, environment, and custom forwarding", () => {
    const options = 'enabled = false\nstartup_timeout_sec = 120\ntool_timeout_sec = 60\nenabled_tools = ["search"]\n';
    const environment = '\n[mcp_servers.satori.env]\nOPENAI_API_KEY = "keep-key"\nVECTOR_STORE_PROVIDER = "LanceDB"\n';
    const content = `[mcp_servers.satori]\n${wiring}env_vars = ["MY_CUSTOM_ENV", "OPENAI_API_KEY"]\n${options}${environment}`;
    const updated = install(content);
    assert.ok(updated.includes(options));
    assert.ok(updated.includes(environment));
    assert.ok((parseCodexConfig(updated).entry?.env_vars as string[]).includes("MY_CUSTOM_ENV"));
    const removed = uninstall(updated);
    assert.ok(removed.includes(options));
    assert.ok(removed.includes(environment));
    assert.deepEqual(parseCodexConfig(removed).entry?.env_vars, ["MY_CUSTOM_ENV"]);
    assert.equal(parseCodexConfig(removed).entry?.command, undefined);
    assert.equal(uninstall(removed), removed);
});

test("inline user options survive removal at each comma position", () => {
    const cmd = JSON.stringify(runtime.command);
    const args = JSON.stringify(runtime.args);
    for (const fields of [
        `command=${cmd}, args=${args}, startup_timeout_sec=90`,
        `startup_timeout_sec=90, args=${args}, command=${cmd}`,
        `args=${args}, startup_timeout_sec=90, command=${cmd}`,
    ]) {
        const content = `mcp_servers = { other = {command="keep"}, satori = { ${fields} } }\n`;
        const removed = uninstall(install(content));
        assert.deepEqual(parseCodexConfig(removed).entry, { startup_timeout_sec: 90 });
        assert.ok(removed.includes('other = {command="keep"}'));
    }
});

test("legacy marker text in TOML strings is data, not a removable comment", () => {
    const data = `description = '''\n${start}\n${end}\n'''\n`;
    const content = `${data}${start}\n[mcp_servers.satori]\n${wiring}${end}\n`;
    const updated = install(content);
    assert.ok(updated.startsWith(data));
    assert.equal(updated.split(start).length, 2);
    assert.equal(updated.split(end).length, 2);
});

test("CRLF, multiline values and adjacent comments survive surgical edits", () => {
    const content = `[mcp_servers.satori]\n${wiring}# user option\nstartup_timeout_sec = 100 # keep\n\n[mcp_servers.other]\ncommand = "keep"\n`.replace(/\n/g, "\r\n");
    const updated = install(content);
    assert.ok(updated.includes('startup_timeout_sec = 100 # keep\r\n'));
    assert.ok(updated.includes('[mcp_servers.other]\r\ncommand = "keep"\r\n'));
    assert.equal(updated.replace(/\r\n/g, "").includes("\n"), false);
    assert.equal(install(updated), updated);
});

test("custom entries stay protected even with valid ownership comments", () => {
    for (const custom of [`${wiring}url="https://example.test/mcp"`, 'command="node"\nargs=["/custom/satori.js"]', 'url="https://example.test/mcp"', 'command="node"\nargs=["/other-home/.satori/bin/satori-mcp.js"]', `command="node"\nargs=[${JSON.stringify(runtime.args[0])},"extra"]`]) {
        const content = `${start}\n[mcp_servers.satori]\n${custom}\n${end}\n`;
        assert.throws(() => install(content), /unmanaged Satori config.*custom command or URL/);
        assert.throws(() => uninstall(content), /unmanaged Satori config/);
    }
});

test("invalid TOML and ambiguous entry shapes are rejected without leaking values", () => {
    for (const content of ['[mcp_servers.satori]\nsecret="do-not-print', '[mcp_servers.satori]\ncommand="one"\ncommand="two"\n', 'mcp_servers = "bad"', 'mcp_servers.satori = []', `[mcp_servers.satori]\n${wiring}env_vars = [1]\n`]) {
        assert.throws(() => install(content), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /fixture.toml/);
            assert.doesNotMatch(error.message, /do-not-print/);
            return true;
        });
    }
});

test("diagnostics distinguish disabled and incomplete forwarding without text matching", () => {
    withConfig((configPath) => {
        const target = { client: "codex" as const, configPath, companions: [] };
        fs.writeFileSync(configPath, `[mcp_servers.satori]\n${wiring}`);
        assert.equal(verifyManagedClientTarget(target, runtime).usesManagedLauncher, true);
        assert.match(verifyManagedClientTarget(target, runtime).message, /environment forwarding/);
        fs.writeFileSync(configPath, install(`[mcp_servers.satori]\n${wiring}enabled=false\n`));
        const proof = verifyManagedClientTarget(target, runtime);
        assert.equal(proof.status, "error");
        assert.match(proof.message, /enabled to true/);
    });
});

test("environment and vector-store inspection resolve quoted and inline TOML paths", () => {
    const content = `mcp_servers."satori".env = { VECTOR_STORE_PROVIDER = 'Milvus', OPENAI_API_KEY = "from-config" }\n`;
    assert.equal(readCodexRuntimeEnvironment(content, {}).OPENAI_API_KEY, "from-config");
    withConfig((configPath) => {
        fs.writeFileSync(configPath, content);
        assert.equal(readCodexVectorStore(configPath), "Milvus");
    });
});

test("an unusable unrelated Codex config cannot masquerade as Satori in another client", () => {
    withConfig((configPath) => {
        const homeDir = path.dirname(configPath);
        const codexPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexPath));
        fs.writeFileSync(codexPath, 'provider="satori"\nbroken=[\n');
        fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
            mcpServers: { satori: { command: "node", args: ["/custom.js"], env: { VECTOR_STORE_PROVIDER: "Milvus" } } },
        }));
        const target = { client: "codex" as const, configPath: codexPath, companions: [] };
        assert.equal(hasSatoriClientEntry(target), false);
        assert.equal(readConfiguredClientVectorStore(homeDir, {}), "Milvus");
        assert.equal(verifyManagedClientTarget(target, runtime).status, "error");
        assert.throws(() => readCodexVectorStore(codexPath), /Invalid TOML/);
    });
});

test("prepared Codex writes reject a concurrent config edit", () => {
    withConfig((configPath) => {
        fs.writeFileSync(configPath, '[mcp_servers.satori]\n' + wiring);
        const mutation = prepareConfigMutation({ client: "codex", configPath, companions: [] }, {
            kind: "install", client: "codex", runtime: "voyage", dryRun: false,
        }, runtime);
        const changed = fs.readFileSync(configPath, "utf8") + '\nmodel = "changed"\n';
        fs.writeFileSync(configPath, changed);
        assert.throws(() => mutation.assertUnchanged?.(), /changed after the installation plan/);
        assert.equal(fs.readFileSync(configPath, "utf8"), changed);
    });
});

test("unrelated semantic output remains identical through install and uninstall", () => {
    const content = 'title="keep"\n[mcp_servers.other]\ncommand="keep"\nargs=["a", "b"]\n[[skills.config]]\npath="/keep"\nenabled=true\n';
    const before = getStaticTOMLValue(parseTOML(content));
    const after = getStaticTOMLValue(parseTOML(uninstall(install(content))));
    assert.deepEqual(after, before);
});
