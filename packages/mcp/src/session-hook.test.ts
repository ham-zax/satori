import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildSessionStartHookOutput, runSessionStartHook } from "./session-hook.js";

function tempDir(t: { after(fn: () => void): void }): string {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-session-hook-")));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function writeCurrentPublication(stateRoot: string, canonicalRoot: string, version: number): void {
    const key = crypto.createHash("sha256").update(canonicalRoot).digest("hex");
    const generationRoot = path.join(stateRoot, "publications", key, "generations", "current");
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(path.join(generationRoot, "publication.json"), JSON.stringify({
        version,
        id: "current",
        canonicalRoot,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "partial",
        policy: {
            profile: "default", customExtensions: [], customIgnorePatterns: [],
            fileBasedIgnorePatterns: [], supportedExtensions: [".ts"], effectiveIgnorePatterns: [],
            policyHash: "test-policy", controlSignature: "test-control",
        },
        format: { indexFormatVersion: "test", embeddingIdentity: "test", relationshipVersion: "test" },
        vector: { collectionName: "test-collection", indexedFiles: 0, totalChunks: 0 },
        packageOwnership: false,
        navigation: null,
    }));
    fs.writeFileSync(
        path.join(stateRoot, "publications", key, "current.json"),
        JSON.stringify({ version: 1, publicationId: "current" }),
    );
}

test("indexed subdirectory points the agent at the indexed root", (t) => {
    const directory = tempDir(t);
    const stateRoot = path.join(directory, "state");
    const repo = path.join(directory, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    writeCurrentPublication(stateRoot, repo, 2);

    const output = buildSessionStartHookOutput({ cwd: path.join(repo, "src") }, { stateRoot });
    assert.equal(output?.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output!.hookSpecificOutput.additionalContext, new RegExp(`search_codebase with path="${repo}"`));
    assert.match(output!.hookSpecificOutput.additionalContext, /If run_script is available, use it to chain related tool calls/);
    assert.match(output!.hookSpecificOutput.additionalContext, /description gives the tools\.<name>\(args\) signatures for compact mode/);
    assert.equal(output!.systemMessage, undefined);
});

test("incompatible index reports automatic background rebuild guidance without user prompt", (t) => {
    const directory = tempDir(t);
    const stateRoot = path.join(directory, "state");
    const repo = path.join(directory, "repo");
    fs.mkdirSync(repo);
    writeCurrentPublication(stateRoot, repo, 1);

    const output = buildSessionStartHookOutput({ cwd: repo }, { stateRoot });
    assert.match(output!.hookSpecificOutput.additionalContext, /rebuilds repositories within its automatic byte budgets in the background/);
    assert.match(output!.hookSpecificOutput.additionalContext, /indexing\.mode="auto_indexing"/);
    assert.equal(output!.systemMessage, undefined);
});

test("unindexed git repository reports background auto-indexing without asking the user", (t) => {
    const directory = tempDir(t);
    const repo = path.join(directory, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "pkg"));

    const output = buildSessionStartHookOutput({ cwd: path.join(repo, "pkg") }, { stateRoot: path.join(directory, "state") });
    assert.match(output!.hookSpecificOutput.additionalContext, /auto-indexes <=20 MiB offline Git workspaces on startup/);
    assert.match(output!.hookSpecificOutput.additionalContext, /do not ask the user whether to index or migrate/);
    assert.match(output!.hookSpecificOutput.additionalContext, /paid\/connected API repos/);
    assert.match(output!.hookSpecificOutput.additionalContext, /If run_script is available/);
    assert.equal(output!.systemMessage, undefined);
});

test("unindexed directory outside a git repository prints nothing", (t) => {
    const directory = tempDir(t);
    assert.equal(buildSessionStartHookOutput({ cwd: directory }, { stateRoot: path.join(directory, "state") }), null);
    assert.equal(buildSessionStartHookOutput({ cwd: "relative/path" }, { stateRoot: path.join(directory, "state") }), null);
    assert.equal(buildSessionStartHookOutput({ cwd: path.join(directory, "absent") }, { stateRoot: path.join(directory, "state") }), null);
});

test("malformed stdin fails open with no output", async () => {
    const stdin = new PassThrough();
    let written = "";
    const done = runSessionStartHook({ stdin, stdout: { write: (text: string) => { written += text; } }, cwd: os.tmpdir() });
    stdin.end("{not json");
    await done;
    assert.equal(written, "");
});

test("session hook sanitizes control/invisible Unicode chars and JSON-quotes paths (P1-5)", (t) => {
    const directory = tempDir(t);
    const stateRoot = path.join(directory, "state");
    // Directory name containing quotes, a newline, a bidi override (U+202E), and a Unicode Tag char (U+E0041).
    const hiddenTag = String.fromCodePoint(0xe0041, 0xe0042);
    const repo = path.join(directory, `repo" \n\u202e${hiddenTag}evil`);
    fs.mkdirSync(repo, { recursive: true });
    writeCurrentPublication(stateRoot, repo, 2);

    const output = buildSessionStartHookOutput({ cwd: repo }, { stateRoot });
    assert.ok(output);
    const text = output.hookSpecificOutput.additionalContext;
    assert.equal(text.includes("\n"), false, "additionalContext must not contain raw newlines from repo path");
    assert.equal(text.includes("\u202e"), false, "additionalContext must strip bidi override characters");
    assert.equal(text.includes(hiddenTag), false, "additionalContext must strip Unicode Tag smuggling characters");
    // Embedded double quote must be JSON-escaped inside path="...".
    assert.match(text, /search_codebase with path="[^"]*\\"[^"]*"/);
});
