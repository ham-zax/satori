import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "./args.js";

test("parseCliArgs consumes leading --debug as a global flag", () => {
    const parsed = parseCliArgs(["--debug", "tools", "list"]);
    assert.equal(parsed.globals.debug, true);
    assert.equal(parsed.command.kind, "tools-list");
});

test("parseCliArgs defaults startup timeout to normal MCP client budget", () => {
    const parsed = parseCliArgs(["tools", "list"]);
    assert.equal(parsed.globals.startupTimeoutMs, 30000);
    assert.equal(parsed.globals.formatExplicit, false);
});

test("parseCliArgs records an explicit global output format", () => {
    const parsed = parseCliArgs(["--format", "json", "doctor"]);
    assert.equal(parsed.globals.format, "json");
    assert.equal(parsed.globals.formatExplicit, true);
});

test("parseCliArgs preserves trailing --debug as wrapper flag input", () => {
    const parsed = parseCliArgs(["search_codebase", "--path", "/repo", "--query", "auth", "--debug"]);
    assert.equal(parsed.globals.debug, false);
    assert.equal(parsed.command.kind, "wrapper");
    if (parsed.command.kind !== "wrapper") {
        assert.fail("Expected wrapper command parsing");
    }
    assert.deepEqual(parsed.command.wrapperArgs, ["--path", "/repo", "--query", "auth", "--debug"]);
});

test("parseCliArgs does not treat post-command --debug as global", () => {
    assert.throws(
        () => parseCliArgs(["tools", "--debug", "list"]),
        /Unsupported tools subcommand/
    );
});

test("parseCliArgs defaults install to offline Potion", () => {
    const parsed = parseCliArgs(["install", "--client", "codex", "--dry-run"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "codex");
    assert.equal(parsed.command.dryRun, true);
    assert.equal(parsed.command.runtime, "offline");
    assert.equal(parsed.command.ollamaModel, undefined);
});

test("parseCliArgs accepts the strict offline runtime variant", () => {
    const parsed = parseCliArgs([
        "install",
        "--runtime",
        "offline",
        "--ollama-model",
        "nomic-embed-text",
    ]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") assert.fail("Expected install command parsing");
    assert.equal(parsed.command.runtime, "offline");
    assert.equal(parsed.command.ollamaModel, "nomic-embed-text");
});

test("parseCliArgs defaults offline installation to bundled Potion", () => {
    const parsed = parseCliArgs(["install", "--runtime", "offline"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") assert.fail("Expected install command parsing");
    assert.equal(parsed.command.runtime, "offline");
    assert.equal(parsed.command.ollamaModel, undefined);
});

test("parseCliArgs accepts an explicit connected Milvus backend", () => {
    const parsed = parseCliArgs(["install", "--runtime", "voyage", "--vector-store", "milvus"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") assert.fail("Expected install command parsing");
    assert.equal(parsed.command.vectorStore, "Milvus");
});

test("parseCliArgs accepts Ollama under the default offline runtime and rejects contradictions", () => {
    const ollama = parseCliArgs(["install", "--ollama-model", "nomic-embed-text"]);
    assert.equal(ollama.command.kind, "install");
    if (ollama.command.kind !== "install") assert.fail("Expected install command parsing");
    assert.equal(ollama.command.runtime, "offline");
    assert.equal(ollama.command.ollamaModel, "nomic-embed-text");

    assert.throws(
        () => parseCliArgs([
            "install",
            "--runtime",
            "offline",
            "--ollama-model",
            "nomic-embed-text",
            "--vector-store",
            "milvus",
        ]),
        /offline requires --vector-store lancedb/,
    );
});

test("parseCliArgs supports install profile selection", () => {
    const parsed = parseCliArgs(["install", "--client", "all", "--profile", "minimal"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "all");
    assert.equal(parsed.command.profile, "minimal");
});

test("parseCliArgs supports opt-in Codex guidance hook install flag", () => {
    const parsed = parseCliArgs(["install", "--client", "codex", "--install-guidance-hook"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "codex");
    assert.equal(parsed.command.installGuidanceHook, true);
});

test("parseCliArgs rejects unsupported install profiles", () => {
    assert.throws(
        () => parseCliArgs(["install", "--profile", "everything"]),
        /--profile must be one of: default, minimal, all-text/
    );
});

test("parseCliArgs supports install with OpenCode client", () => {
    const parsed = parseCliArgs(["install", "--client", "opencode"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "opencode");
});

test("parseCliArgs supports doctor command", () => {
    const parsed = parseCliArgs(["doctor"]);
    assert.equal(parsed.command.kind, "doctor");
    if (parsed.command.kind !== "doctor") assert.fail("Expected doctor command parsing");
    assert.equal(parsed.command.json, false);
    assert.equal(parsed.command.verbose, false);
});

test("parseCliArgs supports explicit doctor output modes", () => {
    const parsed = parseCliArgs(["doctor", "--verbose", "--json"]);
    assert.equal(parsed.command.kind, "doctor");
    if (parsed.command.kind !== "doctor") assert.fail("Expected doctor command parsing");
    assert.equal(parsed.command.json, true);
    assert.equal(parsed.command.verbose, true);
});

test("parseCliArgs rejects unknown doctor arguments", () => {
    assert.throws(
        () => parseCliArgs(["doctor", "--live"]),
        /Unknown argument for doctor/
    );
});

test("parseCliArgs defaults install client to all", () => {
    const parsed = parseCliArgs(["install"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "all");
    assert.equal(parsed.command.dryRun, false);
});

test("parseCliArgs supports uninstall with explicit client", () => {
    const parsed = parseCliArgs(["uninstall", "--client", "claude"]);
    assert.equal(parsed.command.kind, "uninstall");
    if (parsed.command.kind !== "uninstall") {
        assert.fail("Expected uninstall command parsing");
    }
    assert.equal(parsed.command.client, "claude");
    assert.equal(parsed.command.dryRun, false);
});

test("parseCliArgs rejects guidance hook flag for uninstall", () => {
    assert.throws(
        () => parseCliArgs(["uninstall", "--client", "codex", "--install-guidance-hook"]),
        /Unknown arguments for uninstall/
    );
});

test("parseCliArgs rejects unsupported install clients", () => {
    assert.throws(
        () => parseCliArgs(["install", "--client", "cursor"]),
        /--client must be one of: all, claude, codex, opencode/
    );
});
