import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
    absolutePathOrRaw,
    requireAbsoluteFilesystemPath,
    requireRepoRelativeFilePath,
} from "./utils.js";

test("requireAbsoluteFilesystemPath rejects relative paths without CWD resolve", () => {
    const relative = requireAbsoluteFilesystemPath("repo/src", "path");
    assert.equal(relative.ok, false);
    if (!relative.ok) {
        assert.match(relative.message, /absolute filesystem path/i);
        assert.match(relative.message, /CWD/i);
        assert.equal(relative.path, "repo/src");
    }
});

test("requireAbsoluteFilesystemPath accepts absolute paths and collapses .. segments", () => {
    const abs = requireAbsoluteFilesystemPath("/tmp/indexed/../indexed/src", "path");
    assert.equal(abs.ok, true);
    if (abs.ok) {
        assert.equal(abs.absolutePath, path.resolve("/tmp/indexed/../indexed/src"));
    }
});

test("requireRepoRelativeFilePath rejects absolute and .. escapes", () => {
    const absolute = requireRepoRelativeFilePath("/etc/passwd", "file");
    assert.equal(absolute.ok, false);

    const escape = requireRepoRelativeFilePath("../secret.ts", "file");
    assert.equal(escape.ok, false);

    const ok = requireRepoRelativeFilePath("src/app.ts", "file");
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.relativePath, "src/app.ts");
    }
});

test("absolutePathOrRaw preserves relative inputs for error envelopes", () => {
    assert.equal(absolutePathOrRaw("relative/path"), "relative/path");
    assert.equal(absolutePathOrRaw("/abs/path"), path.resolve("/abs/path"));
});
