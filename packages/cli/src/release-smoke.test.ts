import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

test("release smoke isolates machine configuration and removes pnpm-only npm variables", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-release-smoke-test-"));
    const fakeBin = path.join(fixtureRoot, "bin");
    const sourceHome = path.join(fixtureRoot, "source-home");
    const capturePath = path.join(fixtureRoot, "npm-env.jsonl");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const index = process.argv.indexOf("--pack-destination");
const destination = process.argv[index + 1];
const packageName = path.basename(process.cwd());
fs.writeFileSync(path.join(destination, packageName + "-fixture.tgz"), "fixture");
`);
    fs.writeFileSync(path.join(fakeBin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.SATORI_SMOKE_CAPTURE, JSON.stringify({
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  npmCache: process.env.npm_config_cache,
  shellEmulator: process.env.npm_config_shell_emulator,
  registry: process.env.npm_config_registry,
}) + "\\n");
`);
    fs.chmodSync(path.join(fakeBin, "pnpm"), 0o755);
    fs.chmodSync(path.join(fakeBin, "npm"), 0o755);

    try {
        execFileSync(process.execPath, ["--import", "tsx", "scripts/release-smoke.ts"], {
            cwd: PACKAGE_ROOT,
            env: {
                ...process.env,
                HOME: sourceHome,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
                SATORI_SMOKE_CAPTURE: capturePath,
                npm_config_shell_emulator: "true",
                npm_config_registry: "https://registry.npmjs.org/",
            },
            stdio: "pipe",
        });

        const captures = fs.readFileSync(capturePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, string | undefined>);
        assert.equal(captures.length, 2);
        for (const capture of captures) {
            assert.notEqual(capture.home, sourceHome);
            assert.match(capture.home || "", /satori-cli-release-home-/);
            assert.equal(capture.xdgConfigHome, path.join(capture.home || "", ".config"));
            assert.equal(capture.npmCache, path.join(capture.home || "", ".npm"));
            assert.equal(capture.shellEmulator, undefined);
            assert.equal(capture.registry, "https://registry.npmjs.org/");
        }
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
