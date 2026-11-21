import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    prepareProjectProfileInstall,
    prepareSessionHookInstall,
    prepareSessionHookRemoval,
    prepareSkillInstall,
} from "./client-config-mutations.js";

test("prepareProjectProfileInstall refuses live and dangling symlinks at satori.toml (P4-2)", (t) => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "satori-profile-symlink-"));
    t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
    const repoDir = path.join(outer, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Case 1: live symlink pointing outside repoDir.
    const victimFile = path.join(outer, "victim.txt");
    fs.writeFileSync(victimFile, "precious user content\n", "utf8");
    const satoriToml = path.join(repoDir, "satori.toml");
    fs.symlinkSync(victimFile, satoriToml);

    assert.throws(
        () => {
            const mutation = prepareProjectProfileInstall(repoDir, "minimal");
            mutation.apply();
        },
        /symbolic link|symlink/i,
    );
    assert.equal(fs.readFileSync(victimFile, "utf8"), "precious user content\n");

    // Case 2: dangling symlink pointing to a missing external path.
    fs.unlinkSync(satoriToml);
    const missingExternal = path.join(outer, "nested-missing", "created-outside.toml");
    fs.symlinkSync(missingExternal, satoriToml);
    assert.throws(
        () => {
            const mutation = prepareProjectProfileInstall(repoDir, "minimal");
            mutation.apply();
        },
        /symbolic link|symlink/i,
    );
    assert.equal(fs.existsSync(missingExternal), false);
});

test("prepareSkillInstall refuses a symlink at SKILL.md (P4-2)", (t) => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "satori-skill-symlink-"));
    t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
    const skillDir = path.join(outer, "skills", "satori");
    fs.mkdirSync(skillDir, { recursive: true });
    const victimFile = path.join(outer, "victim-skill.md");
    fs.writeFileSync(victimFile, "<!-- satori-managed-skill -->\nprecious external file\n", "utf8");
    fs.symlinkSync(victimFile, path.join(skillDir, "SKILL.md"));

    assert.throws(
        () => {
            const mutation = prepareSkillInstall(skillDir, "<!-- satori-managed-skill -->\nnew content\n");
            mutation.apply();
        },
        /symbolic link|symlink/i,
    );
    assert.equal(fs.readFileSync(victimFile, "utf8"), "<!-- satori-managed-skill -->\nprecious external file\n");
});

test("prepareSessionHookInstall quotes POSIX shell metacharacters safely and uninstall removes it (P4-3)", {
    skip: process.platform === "win32",
}, (t) => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "satori-hook-quote-"));
    t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
    const markerPath = path.join(outer, "shell-injection-ran.marker");
    // Path containing $(...), backticks, spaces, and a single quote.
    const trickyHome = path.join(outer, `user's $(touch ${markerPath}) home`);
    const binDir = path.join(trickyHome, ".satori", "bin");
    const settingsPath = path.join(trickyHome, ".claude", "settings.json");
    fs.mkdirSync(binDir, { recursive: true });
    const launcherPath = path.join(binDir, "satori-mcp.js");
    const runtimeCommand = { command: process.execPath, args: [launcherPath] };

    const installMutation = prepareSessionHookInstall(settingsPath, runtimeCommand);
    installMutation.apply();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const hookCommand = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    assert.equal(typeof hookCommand, "string");

    // Actually execute the generated hook command via /bin/sh -c to prove
    // $(touch ...) is NOT expanded by the shell.
    execFileSync("/bin/sh", ["-c", hookCommand!], {
        input: "{}",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(
        fs.existsSync(markerPath),
        false,
        `Generated SessionStart hook command must not allow POSIX shell expansion: ${hookCommand}`,
    );

    // Uninstall must cleanly recognize and remove the single-quoted hook entry.
    const removalMutation = prepareSessionHookRemoval(settingsPath, runtimeCommand);
    assert.equal(removalMutation.changed, true);
    removalMutation.apply();
    const afterRemove = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: unknown };
    assert.equal(afterRemove.hooks, undefined);
});

test("prepareSessionHookInstall rejects newlines or NUL bytes in command/shim paths (P4-3)", (t) => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "satori-hook-ctrl-"));
    t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
    const settingsPath = path.join(outer, "settings.json");

    assert.throws(
        () => prepareSessionHookInstall(settingsPath, {
            command: `${process.execPath}\nid`,
            args: [path.join(outer, "satori-mcp.js")],
        }),
        /newline|null|control/i,
    );
});
