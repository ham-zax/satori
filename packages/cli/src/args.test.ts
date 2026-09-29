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

test("parseCliArgs accepts global options between built-in command words", () => {
    const parsed = parseCliArgs(["tools", "--debug", "list"]);
    assert.equal(parsed.command.kind, "tools-list");
    assert.equal(parsed.globals.debug, true);
});

test("parseCliArgs accepts global options after a built-in command", () => {
    const toolsList = parseCliArgs(["tools", "list", "--format", "json"]);
    assert.equal(toolsList.command.kind, "tools-list");
    assert.equal(toolsList.globals.format, "json");
    assert.equal(toolsList.globals.formatExplicit, true);

    const doctor = parseCliArgs(["doctor", "--debug", "--verbose", "--call-timeout-ms", "5"]);
    assert.deepEqual(doctor.command, { kind: "doctor", json: false, verbose: true });
    assert.equal(doctor.globals.debug, true);
    assert.equal(doctor.globals.callTimeoutMs, 5);

    const install = parseCliArgs(["install", "--dry-run", "--format", "text", "--startup-timeout-ms", "7"]);
    assert.equal(install.command.kind, "install");
    assert.equal(install.globals.startupTimeoutMs, 7);
    assert.equal(install.globals.format, "text");
});

test("parseCliArgs never treats a command flag's value as a global option", () => {
    const parsed = parseCliArgs(["tool", "call", "search_codebase", "--args-json", "--format"]);
    assert.equal(parsed.globals.formatExplicit, false);
    assert.equal(parsed.command.kind, "tool-call");
    if (parsed.command.kind !== "tool-call") assert.fail("Expected tool-call parsing");
    assert.deepEqual(parsed.command.rawArgsMode, { kind: "json", value: "--format" });

    const fileMode = parseCliArgs(["tool", "call", "search_codebase", "--args-file", "--debug", "--format", "json"]);
    assert.equal(fileMode.globals.debug, false);
    assert.equal(fileMode.globals.format, "json");
    if (fileMode.command.kind !== "tool-call") assert.fail("Expected tool-call parsing");
    assert.deepEqual(fileMode.command.rawArgsMode, { kind: "file", path: "--debug" });

    // An install --ollama-model value equal to a global flag name is the model, not the global.
    const install = parseCliArgs(["install", "--ollama-model", "--debug", "--dry-run"]);
    assert.equal(install.globals.debug, false);
    if (install.command.kind !== "install") assert.fail("Expected install parsing");
    assert.equal(install.command.ollamaModel, "--debug");
});

test("parseCliArgs passes a wrapper tool's own --format and --debug tokens through untouched", () => {
    const parsed = parseCliArgs(["some_tool", "--format", "markdown", "--debug", "--startup-timeout-ms", "9"]);
    assert.equal(parsed.globals.formatExplicit, false);
    assert.equal(parsed.globals.debug, false);
    assert.equal(parsed.globals.startupTimeoutMs, 30000);
    if (parsed.command.kind !== "wrapper") assert.fail("Expected wrapper command parsing");
    assert.deepEqual(parsed.command.wrapperArgs, ["--format", "markdown", "--debug", "--startup-timeout-ms", "9"]);

    // Leading globals still apply; only tokens after the tool name belong to the tool.
    const leading = parseCliArgs(["--format", "text", "some_tool", "--format", "markdown"]);
    assert.equal(leading.globals.format, "text");
    if (leading.command.kind !== "wrapper") assert.fail("Expected wrapper command parsing");
    assert.deepEqual(leading.command.wrapperArgs, ["--format", "markdown"]);
});

test("parseCliArgs rejects an unknown leading option", () => {
    assert.throws(() => parseCliArgs(["--bogus", "doctor"]), /Unknown option '--bogus'/);
});

test("parseCliArgs selects per-command help and keeps top-level help topic-free", () => {
    assert.deepEqual(parseCliArgs(["install", "--help"]).command, { kind: "help", topic: "install" });
    assert.deepEqual(parseCliArgs(["doctor", "-h"]).command, { kind: "help", topic: "doctor" });
    assert.deepEqual(parseCliArgs(["update", "--help"]).command, { kind: "help", topic: "upgrade" });
    assert.deepEqual(parseCliArgs(["tools", "list", "--help"]).command, { kind: "help", topic: "tools-list" });
    assert.deepEqual(parseCliArgs(["tool", "call", "--help"]).command, { kind: "help", topic: "tool-call" });
    assert.deepEqual(parseCliArgs(["--help"]).command, { kind: "help" });
    assert.deepEqual(parseCliArgs(["help"]).command, { kind: "help" });
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

test("parseCliArgs treats upgrade and update as the same command", () => {
    assert.deepEqual(parseCliArgs(["upgrade"]).command, { kind: "upgrade" });
    assert.deepEqual(parseCliArgs(["update"]).command, { kind: "upgrade" });
    assert.throws(
        () => parseCliArgs(["upgrade", "--client", "codex"]),
        /Unknown arguments for upgrade/,
    );
});

test("parseCliArgs supports terminate without accepting command-specific arguments", () => {
    assert.deepEqual(parseCliArgs(["terminate"]).command, { kind: "terminate" });
    assert.throws(
        () => parseCliArgs(["terminate", "--force"]),
        /Unknown arguments for terminate/,
    );
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
    assert.equal(parsed.command.reranker, undefined);
});

test("parseCliArgs supports the offline LateOn reranker opt-out", () => {
    const parsed = parseCliArgs(["install", "--runtime", "offline", "--reranker", "none"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") assert.fail("Expected install command parsing");
    assert.equal(parsed.command.runtime, "offline");
    assert.equal(parsed.command.reranker, "none");

    assert.throws(
        () => parseCliArgs(["install", "--runtime", "voyage", "--reranker", "lateon"]),
        /only valid with --runtime offline/,
    );
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

test("parseCliArgs rejects the retired Codex guidance hook flag", () => {
    assert.throws(() => parseCliArgs(["install", "--client", "codex", "--install-guidance-hook"]));
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

test("parseCliArgs defaults install client to auto-detection", () => {
    const parsed = parseCliArgs(["install"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "auto");
    assert.equal(parsed.command.dryRun, false);
});

test("parseCliArgs defaults uninstall client to all supported clients", () => {
    const parsed = parseCliArgs(["uninstall"]);
    assert.equal(parsed.command.kind, "uninstall");
    if (parsed.command.kind !== "uninstall") {
        assert.fail("Expected uninstall command parsing");
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
        /--client must be one of: auto, all, claude, codex, opencode/
    );
});
