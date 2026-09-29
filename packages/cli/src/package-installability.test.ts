import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyManagedPackageInstallability } from "./package-installability.js";

function withTempPackageJson(
    packageJson: Record<string, unknown>,
    run: (packageJsonPath: string) => void
): void {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-package-installability-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    try {
        fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
        run(packageJsonPath);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test("verifyManagedPackageInstallability rejects unpublished managed-runtime targets with explicit guidance", () => {
    withTempPackageJson({
        name: "@satori-code/cli",
        version: "2.0.6",
        satoriManagedRuntime: { mcp: "4.4.1", core: "1.1.1" },
    }, (packageJsonPath) => {
        const seen: string[] = [];
        assert.throws(
            () => verifyManagedPackageInstallability({
                packageJsonPath,
                execFileSyncImpl: ((command: string, args: string[]) => {
                    seen.push(`${command} ${args.join(" ")}`);
                    if (args[1] === "@satori-code/mcp@4.4.1") {
                        return JSON.stringify("4.4.1");
                    }
                    throw Object.assign(new Error("missing"), {
                        stdout: "",
                        stderr: "npm error notarget No matching version found for @satori-code/core@1.1.1.\n",
                    });
                }) as never,
            }),
            /required dependency @satori-code\/core@1\.1\.1 is not published on npm/
        );
        assert.deepEqual(seen, [
            "npm view @satori-code/mcp@4.4.1 version --json",
            "npm view @satori-code/core@1.1.1 version --json",
        ]);
    });
});

test("verifyManagedPackageInstallability verifies exact managed-runtime targets and returns the MCP specifier", () => {
    withTempPackageJson({
        name: "@satori-code/cli",
        version: "2.0.6",
        satoriManagedRuntime: { mcp: "4.4.1", core: "1.0.0" },
    }, (packageJsonPath) => {
        const seen: string[] = [];
        const packageSpecifier = verifyManagedPackageInstallability({
            packageJsonPath,
            execFileSyncImpl: ((command: string, args: string[]) => {
                seen.push(`${command} ${args.join(" ")}`);
                return JSON.stringify(args[1].split("@").at(-1));
            }) as never,
        });
        assert.equal(packageSpecifier, "@satori-code/mcp@4.4.1");
        assert.deepEqual(seen, [
            "npm view @satori-code/mcp@4.4.1 version --json",
            "npm view @satori-code/core@1.0.0 version --json",
        ]);
    });
});

test("verifyManagedPackageInstallability rejects missing runtime metadata", () => {
    withTempPackageJson({
        name: "@satori-code/cli",
        version: "2.0.6",
    }, (packageJsonPath) => {
        assert.throws(
            () => verifyManagedPackageInstallability({ packageJsonPath }),
            /satoriManagedRuntime must pin exact MCP and Core versions/,
        );
    });
});
