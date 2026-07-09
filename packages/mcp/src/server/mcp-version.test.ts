import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpPackageVersion } from "../config.js";

// F-OP-01: default MCP version must come from package.json, not stale 1.0.0.
test("resolveMcpPackageVersion matches packages/mcp package.json and is not stale 1.0.0", () => {
    const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string };
    const resolved = resolveMcpPackageVersion();

    assert.equal(resolved, packageJson.version);
    assert.notEqual(resolved, "1.0.0");
    assert.match(resolved, /^\d+\.\d+\.\d+/);
});
