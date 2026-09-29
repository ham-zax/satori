import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_LATEON_PROFILE_ID,
    calculateRequiredLateOnFreeBytes,
    ensureDefaultLateOnModel,
    loadAcquisitionAuthority,
    readLateOnAcquisitionAuthority,
    resolveDefaultLateOnModelDirectory,
    verifyLateOnModelDirectory,
} from "./lateon-model-store.js";

const REVISION = "07ef20f406c86badca122464808f4cac2f6e4b25";
const FROZEN_PROFILE_SHA256 = "2957cec1aabc1790e6c58d9e02ae2829cbda9b9ae3b176e9a22363b3fbf688f4";
const SHIPPED_MCP_PACKAGE_ROOT = fileURLToPath(new URL("../../mcp/", import.meta.url));

function digest(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function writeAcquisitionFixture(
    runtimePackageRoot: string,
    artifacts: Readonly<Record<string, string>>,
): void {
    const assetsRoot = path.join(runtimePackageRoot, "assets", "lateon");
    fs.mkdirSync(assetsRoot, { recursive: true });
    const profile = {
        schemaVersion: "satori_lateon_runtime_profile_v5",
        profileId: DEFAULT_LATEON_PROFILE_ID,
        identity: {
            repository: "lightonai/LateOn-Code-edge",
            revision: REVISION,
            license: "Apache-2.0",
        },
        inference: { candidateDepth: 32 },
        artifacts: Object.entries(artifacts).map(([artifactPath, content]) => ({
            path: artifactPath,
            sha256: digest(content),
        })),
    };
    const profileBytes = Buffer.from(JSON.stringify(profile, null, 2), "utf8");
    fs.writeFileSync(path.join(assetsRoot, "runtime-profile-v5-d32.json"), profileBytes);
    const entries = Object.entries(artifacts).map(([artifactPath, content]) => ({
        path: artifactPath,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        sha256: digest(content),
    }));
    const manifest = {
        schemaVersion: "satori_lateon_acquisition_v1",
        runtimeProfileSha256: digest(profileBytes),
        artifacts: entries,
        totalExpectedArtifactBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
        policy: {
            downloadDeadlineMilliseconds: 10 * 60 * 1000,
            maximumRedirects: 5,
            diskHeadroomFraction: 0.1,
            diskHeadroomFormula:
                "totalExpectedArtifactBytes + ceil(totalExpectedArtifactBytes * diskHeadroomFraction)",
        },
    };
    fs.writeFileSync(
        path.join(assetsRoot, "runtime-profile-v5-d32.acquisition.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
    );
}

function writeModelDirectory(
    modelDirectory: string,
    artifacts: Readonly<Record<string, string>>,
): void {
    for (const [artifactPath, content] of Object.entries(artifacts)) {
        const filePath = path.join(modelDirectory, artifactPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
    }
}

async function withLateOnFixture(
    artifacts: Readonly<Record<string, string>>,
    run: (input: { homeDir: string; runtimePackageRoot: string }) => Promise<void>,
): Promise<void> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-"));
    try {
        const runtimePackageRoot = path.join(homeDir, "runtime");
        writeAcquisitionFixture(runtimePackageRoot, artifacts);
        await run({ homeDir, runtimePackageRoot });
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
}

/** Files left in resumable staging directories. */
function stagingLeftovers(homeDir: string): string[] {
    const parent = path.join(homeDir, ".satori", "models", "lateon");
    return fs.readdirSync(parent)
        .filter((name) => name.endsWith(".partial"))
        .flatMap((name) => fs.readdirSync(path.join(parent, name), { recursive: true }).map(String));
}

test("shipped dry-run profile ID equals the frozen shipped profile ID", () => {
    const profile = JSON.parse(fs.readFileSync(
        path.join(SHIPPED_MCP_PACKAGE_ROOT, "assets", "lateon", "runtime-profile-v5-d32.json"),
        "utf8",
    ));
    assert.equal(profile.profileId, DEFAULT_LATEON_PROFILE_ID);
    assert.equal(profile.identity.repository, "lightonai/LateOn-Code-edge");
    assert.equal(profile.identity.revision, REVISION);
});

test("acquisition manifest binds the exact frozen profile digest", () => {
    const authority = readLateOnAcquisitionAuthority(SHIPPED_MCP_PACKAGE_ROOT);
    assert.equal(authority.runtimeProfileSha256, FROZEN_PROFILE_SHA256);
    assert.equal(authority.profileId, DEFAULT_LATEON_PROFILE_ID);
    assert.equal(authority.totalExpectedArtifactBytes, 71577202);
    assert.equal(authority.downloadDeadlineMilliseconds, 10 * 60 * 1000);
    assert.equal(authority.maximumRedirects, 5);
});

test("rejects a runtime package root that is not absolute", () => {
    assert.throws(
        () => readLateOnAcquisitionAuthority("relative/package"),
        /must be absolute/,
    );
});

test("LateOn model store downloads the pinned closure once and reuses it", async () => {
    const artifacts = {
        "model.onnx": "model-bytes",
        "tokenizer.json": "tokenizer-bytes",
    };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const requested: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = String(input);
            requested.push(url);
            const artifactPath = url.slice(url.lastIndexOf("/") + 1) as keyof typeof artifacts;
            return new Response(artifacts[artifactPath], { status: 200 });
        }) as typeof fetch;
        const first = await ensureDefaultLateOnModel({ retryDelaysMs: [],
            homeDir,
            runtimePackageRoot,
            fetchImpl,
            authorityLoader: loadAcquisitionAuthority,
        });
        const second = await ensureDefaultLateOnModel({ retryDelaysMs: [],
            homeDir,
            runtimePackageRoot,
            fetchImpl: (async () => {
                throw new Error("The verified model should be reused.");
            }) as typeof fetch,
            authorityLoader: loadAcquisitionAuthority,
        });

        assert.equal(first.modelDirectory, resolveDefaultLateOnModelDirectory(homeDir));
        assert.equal(second.modelDirectory, first.modelDirectory);
        assert.equal(second.profileId, DEFAULT_LATEON_PROFILE_ID);
        assert.equal(second.runtimeProfileSha256, first.runtimeProfileSha256);
        assert.equal(
            fs.readFileSync(path.join(first.modelDirectory, "model.onnx"), "utf8"),
            "model-bytes",
        );
        assert.equal(requested.length, 2);
        assert.equal(
            requested.every((url) => url.startsWith(
                "https://huggingface.co/lightonai/LateOn-Code-edge/resolve/",
            )),
            true,
        );
    });
});

test("LateOn model store replaces a corrupt cached copy with a verified download", async () => {
    const artifacts: Record<string, string> = { "model.onnx": "expected", "tokenizer.json": "tokenizer" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = resolveDefaultLateOnModelDirectory(homeDir);
        writeModelDirectory(modelDirectory, { "model.onnx": "corrupt", "tokenizer.json": "tokenizer" });
        const phases: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            const artifactPath = String(input).slice(String(input).lastIndexOf("/") + 1);
            return new Response(artifacts[artifactPath] ?? "missing", { status: 200 });
        }) as typeof fetch;
        await ensureDefaultLateOnModel({
            retryDelaysMs: [],
            homeDir,
            runtimePackageRoot,
            fetchImpl,
            authorityLoader: loadAcquisitionAuthority,
            onProgress: (event) => phases.push(event.phase),
        });
        assert.equal(phases.includes("repairing"), true);
        assert.equal(fs.readFileSync(path.join(modelDirectory, "model.onnx"), "utf8"), "expected");
    });
});

test("LateOn model store rejects a profile outside the pinned D32 authority", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const profilePath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.json",
        );
        const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        profile.identity.revision = "f".repeat(40);
        fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, authorityLoader: loadAcquisitionAuthority }),
            /does not contain the pinned LateOn D32 profile/,
        );
    });
});

test("LateOn model store rejects an acquisition manifest that does not bind the profile bytes", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const manifestPath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.acquisition.json",
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.runtimeProfileSha256 = "0".repeat(64);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, authorityLoader: loadAcquisitionAuthority }),
            /missing or mismatched LateOn acquisition manifest/,
        );
    });
});

test("LateOn model store rejects an unsafe artifact path", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const manifestPath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.acquisition.json",
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.artifacts[0].path = "../escaped.onnx";
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, authorityLoader: loadAcquisitionAuthority }),
            /unsafe artifact path '\.\.\/escaped\.onnx'/,
        );
    });
});

test("LateOn model store rejects insufficient disk space before any download", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        let fetchCalls = 0;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [],
                homeDir,
                runtimePackageRoot,
                statfsImpl: () => ({ bavail: 0, bsize: 4096 }),
                fetchImpl: (async () => {
                    fetchCalls += 1;
                    return new Response("expected", { status: 200 });
                }) as typeof fetch,
                authorityLoader: loadAcquisitionAuthority,
            }),
            /Not enough disk space/,
        );
        assert.equal(fetchCalls, 0);
    });
});

test("LateOn model store follows HTTPS redirects within the acquisition policy", async () => {
    const artifacts: Record<string, string> = { "model.onnx": "expected" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const requested: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = String(input);
            requested.push(url);
            if (requested.length === 1) {
                return new Response(null, {
                    status: 302,
                    headers: { location: "https://cdn.example.test/lateon/model.onnx" },
                });
            }
            return new Response("expected", { status: 200 });
        }) as typeof fetch;
        const result = await ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority });
        assert.equal(
            fs.readFileSync(path.join(result.modelDirectory, "model.onnx"), "utf8"),
            "expected",
        );
        assert.deepEqual(requested, [
            `https://huggingface.co/lightonai/LateOn-Code-edge/resolve/${REVISION}/model.onnx`,
            "https://cdn.example.test/lateon/model.onnx",
        ]);
    });
});

test("LateOn model store rejects more than five redirects", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async () => new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.test/lateon/model.onnx" },
        })) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority }),
            /too many redirects/,
        );
    });
});

test("LateOn model store rejects a non-HTTPS redirect", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async () => new Response(null, {
            status: 302,
            headers: { location: "http://cdn.example.test/lateon/model.onnx" },
        })) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority }),
            /non-HTTPS redirect/,
        );
    });
});

test("LateOn model store rejects an artifact body that exceeds its manifest size", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async () => new Response("x".repeat(100), { status: 200 })) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority }),
            /exceeded its expected size of 8 bytes/,
        );
    });
});

test("LateOn model store rejects a short artifact body", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async () => new Response("short", { status: 200 })) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority }),
            /ended at 5 bytes; expected 8/,
        );
    });
});

test("LateOn model store rejects an artifact body whose checksum mismatches", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async () => new Response("tampered", { status: 200 })) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority }),
            /failed checksum verification/,
        );
    });
});

test("LateOn model store discards a staged file that fails its checksum", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async () => new Response("tampered", { status: 200 })) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority }),
            /failed checksum verification/,
        );
        assert.deepEqual(stagingLeftovers(homeDir), []);
    });
});

test("LateOn model store verifies and reuses a valid destination that appears during acquisition", async () => {
    const artifacts: Record<string, string> = { "model.onnx": "expected", "tokenizer.json": "tokenizer" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = resolveDefaultLateOnModelDirectory(homeDir);
        const fetchImpl = (async (input: string | URL | Request) => {
            writeModelDirectory(modelDirectory, artifacts);
            const artifactPath = String(input).slice(String(input).lastIndexOf("/") + 1);
            return new Response(artifacts[artifactPath] ?? "missing", { status: 200 });
        }) as typeof fetch;
        const result = await ensureDefaultLateOnModel({ retryDelaysMs: [], homeDir, runtimePackageRoot, fetchImpl, authorityLoader: loadAcquisitionAuthority });
        assert.equal(result.modelDirectory, modelDirectory);
        assert.equal(fs.readFileSync(path.join(modelDirectory, "model.onnx"), "utf8"), "expected");
        assert.deepEqual(stagingLeftovers(homeDir), []);
    });
});

test("verifyLateOnModelDirectory accepts a verified explicit directory", async () => {
    const artifacts: Record<string, string> = { "model.onnx": "expected" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = path.join(homeDir, "explicit-model");
        writeModelDirectory(modelDirectory, artifacts);
        const verified = verifyLateOnModelDirectory({ modelDirectory, runtimePackageRoot, authorityLoader: loadAcquisitionAuthority });
        assert.equal(verified.modelDirectory, path.resolve(modelDirectory));
        assert.equal(verified.profileId, DEFAULT_LATEON_PROFILE_ID);
        assert.equal(verified.runtimeProfileSha256.length, 64);
    });
});

test("verifyLateOnModelDirectory rejects a directory missing an artifact", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = path.join(homeDir, "explicit-model");
        fs.mkdirSync(modelDirectory, { recursive: true });
        assert.throws(
            () => verifyLateOnModelDirectory({ modelDirectory, runtimePackageRoot, authorityLoader: loadAcquisitionAuthority }),
            /failed verification: model\.onnx: /,
        );
    });
});

test("verifyLateOnModelDirectory rejects an intermediate directory symlink", async () => {
    const artifacts: Record<string, string> = { "nested/model.onnx": "expected" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = path.join(homeDir, "explicit-model");
        const target = path.join(homeDir, "real-nested");
        writeModelDirectory(target, { "model.onnx": "expected" });
        fs.mkdirSync(modelDirectory, { recursive: true });
        fs.symlinkSync(target, path.join(modelDirectory, "nested"));
        assert.throws(
            () => verifyLateOnModelDirectory({ modelDirectory, runtimePackageRoot, authorityLoader: loadAcquisitionAuthority }),
            /failed verification: nested\/model\.onnx: intermediate component 'nested' is not a real directory/,
        );
    });
});

test("production model acquisition binds the exact frozen profile digest", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const profilePath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.json",
        );
        const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        const reserialized = Buffer.from(JSON.stringify(profile), "utf8");
        fs.writeFileSync(profilePath, reserialized);
        const manifestPath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.acquisition.json",
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.runtimeProfileSha256 = digest(reserialized);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [],
                homeDir,
                runtimePackageRoot,
                fetchImpl: (async () => new Response("expected", { status: 200 })) as typeof fetch,
            }),
            /not the frozen profile/,
        );
    });
});

test("production explicit model verification binds the exact frozen profile digest", async () => {
    await withLateOnFixture({ "model.onnx": "expected" }, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = path.join(homeDir, "explicit-model");
        writeModelDirectory(modelDirectory, { "model.onnx": "expected" });
        const profilePath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.json",
        );
        const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        const reserialized = Buffer.from(JSON.stringify(profile), "utf8");
        fs.writeFileSync(profilePath, reserialized);
        const manifestPath = path.join(
            runtimePackageRoot,
            "assets",
            "lateon",
            "runtime-profile-v5-d32.acquisition.json",
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.runtimeProfileSha256 = digest(reserialized);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
        assert.throws(
            () => verifyLateOnModelDirectory({ modelDirectory, runtimePackageRoot }),
            /not the frozen profile/,
        );
    });
});

test("LateOn model store reuses a valid destination that appears before the rename", async () => {
    const artifacts: Record<string, string> = { "model.onnx": "expected" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const modelDirectory = resolveDefaultLateOnModelDirectory(homeDir);
        let renamed = false;
        const fetchImpl = (async (input: string | URL | Request) => {
            const artifactPath = String(input).slice(String(input).lastIndexOf("/") + 1);
            return new Response(artifacts[artifactPath] ?? "missing", { status: 200 });
        }) as typeof fetch;
        const result = await ensureDefaultLateOnModel({ retryDelaysMs: [],
            homeDir,
            runtimePackageRoot,
            fetchImpl,
            authorityLoader: loadAcquisitionAuthority,
            renameImpl: (from, to) => {
                renamed = true;
                writeModelDirectory(to, artifacts);
                throw new Error("ENOTEMPTY: destination appeared concurrently");
            },
        });
        assert.equal(renamed, true);
        assert.equal(result.modelDirectory, modelDirectory);
        assert.equal(
            fs.readFileSync(path.join(modelDirectory, "model.onnx"), "utf8"),
            "expected",
        );
        assert.deepEqual(stagingLeftovers(homeDir), []);
    });
});

test("LateOn model store refuses a corrupt destination that appears before the rename", async () => {
    const artifacts: Record<string, string> = { "model.onnx": "expected" };
    await withLateOnFixture(artifacts, async ({ homeDir, runtimePackageRoot }) => {
        const fetchImpl = (async (input: string | URL | Request) => {
            const artifactPath = String(input).slice(String(input).lastIndexOf("/") + 1);
            return new Response(artifacts[artifactPath] ?? "missing", { status: 200 });
        }) as typeof fetch;
        await assert.rejects(
            ensureDefaultLateOnModel({ retryDelaysMs: [],
                homeDir,
                runtimePackageRoot,
                fetchImpl,
                authorityLoader: loadAcquisitionAuthority,
                renameImpl: (from, to) => {
                    writeModelDirectory(to, { "model.onnx": "corrupt" });
                    throw new Error("ENOTEMPTY: destination appeared concurrently");
                },
            }),
            /failed verification: model\.onnx: artifact size or checksum verification failed/,
        );
    });
});

test("calculateRequiredLateOnFreeBytes applies the manifest headroom formula", () => {
    assert.equal(calculateRequiredLateOnFreeBytes(100, 0.1), 110);
    assert.equal(
        calculateRequiredLateOnFreeBytes(71577202),
        71577202 + Math.ceil(71577202 * 0.1),
    );
    assert.throws(() => calculateRequiredLateOnFreeBytes(0), /positive safe integer/);
    assert.throws(() => calculateRequiredLateOnFreeBytes(100, -0.1), /finite and non-negative/);
});
