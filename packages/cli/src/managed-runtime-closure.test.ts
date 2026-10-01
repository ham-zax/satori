import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import {
    managedRuntimeClosureMatches,
    resolveLanceDbNativePackage,
    resolveLateOnNativePackages,
    resolveOxcParserNativePackage,
    writeManagedRuntimeClosureManifest,
} from "./managed-runtime-closure.js";

const corePackageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "core",
    "package.json",
);
const corePackageJson = JSON.parse(fs.readFileSync(corePackageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
};
const oxcParserVersion = corePackageJson.dependencies?.["oxc-parser"];
const oxcParserPackageJsonPath = createRequire(corePackageJsonPath).resolve("oxc-parser/package.json");
const oxcParserPackageJson = JSON.parse(fs.readFileSync(oxcParserPackageJsonPath, "utf8")) as {
    optionalDependencies?: Record<string, string>;
};

test("resolves the exact WSL Linux GNU LanceDB native package", () => {
    assert.equal(
        resolveLanceDbNativePackage({
            vectorStore: "LanceDB",
            platform: "linux",
            architecture: "x64",
            libc: "gnu",
        }),
        "@lancedb/lancedb-linux-x64-gnu@0.39.0",
    );
});

test("resolves supported Linux musl and Windows architectures deterministically", () => {
    assert.equal(
        resolveLanceDbNativePackage({
            vectorStore: "LanceDB",
            platform: "linux",
            architecture: "arm64",
            libc: "musl",
        }),
        "@lancedb/lancedb-linux-arm64-musl@0.39.0",
    );
    assert.equal(
        resolveLanceDbNativePackage({
            vectorStore: "LanceDB",
            platform: "win32",
            architecture: "x64",
        }),
        "@lancedb/lancedb-win32-x64-msvc@0.39.0",
    );
});

test("rejects a platform without a published LanceDB native closure", () => {
    assert.throws(
        () => resolveLanceDbNativePackage({
            vectorStore: "LanceDB",
            platform: "darwin",
            architecture: "x64",
        }),
        (error: unknown) => (
            error instanceof CliError
            && error.token === "E_USAGE"
            && /unsupported on darwin\/x64/.test(error.message)
        ),
    );
});

test("resolves the exact pinned oxc-parser native binding for the host platform", () => {
    assert.equal(
        resolveOxcParserNativePackage({
            vectorStore: "LanceDB",
            platform: "linux",
            architecture: "x64",
            libc: "gnu",
        }),
        `@oxc-parser/binding-linux-x64-gnu@${oxcParserVersion}`,
    );
    assert.equal(
        resolveOxcParserNativePackage({
            vectorStore: "LanceDB",
            platform: "darwin",
            architecture: "arm64",
        }),
        `@oxc-parser/binding-darwin-arm64@${oxcParserVersion}`,
    );
    assert.equal(
        resolveOxcParserNativePackage({
            vectorStore: "LanceDB",
            platform: "win32",
            architecture: "x64",
        }),
        `@oxc-parser/binding-win32-x64-msvc@${oxcParserVersion}`,
    );
});

test("mapped Oxc native packages match the upstream optional dependency metadata", () => {
    const cases = [
        ["linux", "x64", "gnu", "@oxc-parser/binding-linux-x64-gnu"],
        ["linux", "arm64", "musl", "@oxc-parser/binding-linux-arm64-musl"],
        ["darwin", "arm64", undefined, "@oxc-parser/binding-darwin-arm64"],
        ["darwin", "x64", undefined, "@oxc-parser/binding-darwin-x64"],
        ["win32", "x64", undefined, "@oxc-parser/binding-win32-x64-msvc"],
    ] as const;
    for (const [platform, architecture, libc, packageName] of cases) {
        const specifier = resolveOxcParserNativePackage({
            vectorStore: "LanceDB",
            platform,
            architecture,
            ...(libc ? { libc } : {}),
        });
        assert.equal(specifier, `${packageName}@${oxcParserVersion}`);
        assert.equal(oxcParserPackageJson.optionalDependencies?.[packageName], oxcParserVersion);
    }
});

test("resolves the exact host-native Sharp closure required by LateOn", () => {
    assert.deepEqual(
        resolveLateOnNativePackages({
            vectorStore: "LanceDB",
            lateOn: true,
            platform: "linux",
            architecture: "x64",
            libc: "gnu",
        }),
        [
            "@img/sharp-linux-x64@0.35.5",
            "@img/sharp-libvips-linux-x64@1.3.4",
        ],
    );
    assert.deepEqual(resolveLateOnNativePackages({
        vectorStore: "LanceDB",
        lateOn: false,
        platform: "linux",
        architecture: "x64",
        libc: "gnu",
    }), []);
});

test("rejects a platform without a published oxc-parser native binding", () => {
    assert.throws(
        () => resolveOxcParserNativePackage({
            vectorStore: "LanceDB",
            platform: "linux",
            architecture: "s390x",
            libc: "gnu",
        }),
        (error: unknown) => (
            error instanceof CliError
            && error.token === "E_USAGE"
            && /unsupported on linux\/s390x\/gnu/.test(error.message)
        ),
    );
});

test("runtime closure manifest distinguishes slim LanceDB and Milvus installs", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-runtime-closure-"));
    try {
        const lanceDbClosure = {
            vectorStore: "LanceDB" as const,
            platform: "linux" as const,
            architecture: "x64",
            libc: "gnu" as const,
        };
        assert.equal(managedRuntimeClosureMatches(runtimeRoot, lanceDbClosure), false);

        writeManagedRuntimeClosureManifest(runtimeRoot, lanceDbClosure);

        assert.equal(managedRuntimeClosureMatches(runtimeRoot, lanceDbClosure), true);
        assert.equal(managedRuntimeClosureMatches(runtimeRoot, {
            ...lanceDbClosure,
            vectorStore: "Milvus",
        }), false);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("closure identity pins the oxc-parser native binding", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-runtime-closure-oxc-"));
    try {
        const closure = {
            vectorStore: "LanceDB" as const,
            lateOn: true,
            platform: "linux" as const,
            architecture: "x64",
            libc: "gnu" as const,
        };
        writeManagedRuntimeClosureManifest(runtimeRoot, closure);
        const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ".satori-runtime-closure.json"), "utf8"));
        assert.equal(manifest.formatVersion, 3);
        assert.equal(manifest.oxcParserNativePackage, `@oxc-parser/binding-linux-x64-gnu@${oxcParserVersion}`);
        assert.deepEqual(manifest.lateOnNativePackages, [
            "@img/sharp-linux-x64@0.35.5",
            "@img/sharp-libvips-linux-x64@1.3.4",
        ]);
        assert.equal(managedRuntimeClosureMatches(runtimeRoot, closure), true);

        fs.writeFileSync(
            path.join(runtimeRoot, ".satori-runtime-closure.json"),
            JSON.stringify({ ...manifest, formatVersion: 2 }),
        );
        assert.equal(managedRuntimeClosureMatches(runtimeRoot, closure), false);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});
