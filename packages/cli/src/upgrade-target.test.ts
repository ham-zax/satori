import test from "node:test";
import assert from "node:assert/strict";
import {
    compareStableVersions,
    resolveSatoriUpgradeTarget,
} from "./upgrade-target.js";

function manifest(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        name: "@zokizuan/satori-cli",
        version: "1.4.0",
        dependencies: {
            "@zokizuan/satori-mcp": "6.3.0",
            "@zokizuan/satori-core": "3.2.0",
        },
        ...overrides,
    });
}

test("resolveSatoriUpgradeTarget pins the latest CLI runtime closure exactly", () => {
    const calls: string[] = [];
    const target = resolveSatoriUpgradeTarget({
        execFileSyncImpl: ((command: string, args: string[]) => {
            calls.push(`${command} ${args.join(" ")}`);
            return manifest();
        }) as never,
    });

    assert.deepEqual(target, {
        cliPackageSpecifier: "@zokizuan/satori-cli@1.4.0",
        cliVersion: "1.4.0",
        mcpPackageSpecifier: "@zokizuan/satori-mcp@6.3.0",
        mcpVersion: "6.3.0",
        coreVersion: "3.2.0",
    });
    assert.deepEqual(calls, ["npm view @zokizuan/satori-cli@latest --json"]);
});

test("resolveSatoriUpgradeTarget rejects incomplete or non-exact release metadata", () => {
    for (const invalidManifest of [
        manifest({ name: "@example/not-satori" }),
        manifest({ version: "next" }),
        manifest({
            dependencies: {
                "@zokizuan/satori-mcp": "^6.3.0",
                "@zokizuan/satori-core": "3.2.0",
            },
        }),
        manifest({
            dependencies: {
                "@zokizuan/satori-mcp": "6.3.0",
            },
        }),
    ]) {
        assert.throws(
            () => resolveSatoriUpgradeTarget({
                execFileSyncImpl: (() => invalidManifest) as never,
            }),
            /unexpected package identity|stable major\.minor\.patch/,
        );
    }
});

test("resolveSatoriUpgradeTarget reports npm lookup failure without fallback", () => {
    assert.throws(
        () => resolveSatoriUpgradeTarget({
            execFileSyncImpl: (() => {
                throw Object.assign(new Error("registry unavailable"), {
                    stderr: "network offline",
                });
            }) as never,
        }),
        /Unable to resolve the latest Satori release.*network offline/s,
    );
});

test("compareStableVersions orders stable releases and rejects prereleases", () => {
    assert.equal(compareStableVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareStableVersions("1.2.3", "1.3.0"), -1);
    assert.equal(compareStableVersions("2.0.0", "1.9.9"), 1);
    assert.throws(() => compareStableVersions("1.2.3-beta.1", "1.2.3"), /stable major\.minor\.patch/);
});
