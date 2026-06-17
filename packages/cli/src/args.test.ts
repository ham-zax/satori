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

test("parseCliArgs supports install with explicit client and dry-run", () => {
    const parsed = parseCliArgs(["install", "--client", "codex", "--dry-run"]);
    assert.equal(parsed.command.kind, "install");
    if (parsed.command.kind !== "install") {
        assert.fail("Expected install command parsing");
    }
    assert.equal(parsed.command.client, "codex");
    assert.equal(parsed.command.dryRun, true);
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
});

test("parseCliArgs rejects doctor arguments", () => {
    assert.throws(
        () => parseCliArgs(["doctor", "--live"]),
        /Unknown arguments for doctor/
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
