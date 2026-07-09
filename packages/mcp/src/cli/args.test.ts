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

test("parseCliArgs hard-deprecates install to satori-cli (F2 SSOT)", () => {
    assert.throws(
        () => parseCliArgs(["install", "--client", "codex", "--dry-run"]),
        /Install is owned by @zokizuan\/satori-cli/,
    );
});

test("parseCliArgs hard-deprecates uninstall to satori-cli (F2 SSOT)", () => {
    assert.throws(
        () => parseCliArgs(["uninstall", "--client", "claude"]),
        /Uninstall is owned by @zokizuan\/satori-cli/,
    );
});
