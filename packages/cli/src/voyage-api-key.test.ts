import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readVoyageApiKey, resolveVoyageApiKey } from "./voyage-api-key.js";

test("readVoyageApiKey rejects symlinked ~/.satori/.env and warns on overly broad permissions (P1-6)", {
    skip: process.platform === "win32",
}, async (t) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-voyage-key-"));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    const satoriDir = path.join(homeDir, ".satori");
    const envPath = path.join(satoriDir, ".env");
    fs.mkdirSync(satoriDir, { recursive: true, mode: 0o700 });

    // Case 1: world-readable 0644 .env emits a permission warning while still reading key.
    fs.writeFileSync(envPath, "VOYAGEAI_API_KEY=vk-broad-perms\r\n", { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);
    const warnings: string[] = [];
    const key = await resolveVoyageApiKey(homeDir, {}, {
        isInteractive: false,
        writeMessage: (message) => { warnings.push(message); },
    });
    assert.equal(key, "vk-broad-perms");
    assert.ok(
        warnings.some((warning) => /permissions|0600|chmod 600/i.test(warning)),
        `expected broad-permission warning, got: ${JSON.stringify(warnings)}`,
    );

    // Case 2: symlinked .env is rejected fail-closed.
    const external = path.join(homeDir, "external.env");
    fs.writeFileSync(external, "VOYAGEAI_API_KEY=vk-external\n", { mode: 0o600 });
    fs.unlinkSync(envPath);
    fs.symlinkSync(external, envPath);
    assert.throws(
        () => readVoyageApiKey(homeDir, {}),
        /symbolic link|symlink/i,
    );
});
