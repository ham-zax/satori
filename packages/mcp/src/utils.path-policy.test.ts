import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
    absolutePathOrRaw,
    requireAbsoluteFilesystemPath,
    requireRepoRelativeFilePath,
} from "./utils.js";
import { repoRelativeFilePathSchema } from "./tools/types.js";

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

test("requireRepoRelativeFilePath rejects Windows drive-relative C:foo", () => {
    for (const driveRelative of ["C:foo", "C:secret.ts", "C:/secret.ts", "C:\\secret.ts", "d:bar"]) {
        const result = requireRepoRelativeFilePath(driveRelative, "file");
        assert.equal(result.ok, false, `expected reject for ${driveRelative}`);
    }
});

test("repoRelativeFilePathSchema rejects Windows drive-relative C:foo", () => {
    const schema = repoRelativeFilePathSchema("repo-relative file");
    for (const driveRelative of ["C:foo", "C:secret.ts", "C:/secret.ts", "C:\\secret.ts", "d:bar"]) {
        const parsed = schema.safeParse(driveRelative);
        assert.equal(parsed.success, false, `expected schema reject for ${driveRelative}`);
    }
    assert.equal(schema.safeParse("src/app.ts").success, true);
});

test("absolutePathOrRaw preserves relative inputs for error envelopes", () => {
    assert.equal(absolutePathOrRaw("relative/path"), "relative/path");
    assert.equal(absolutePathOrRaw("/abs/path"), path.resolve("/abs/path"));
});
