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

test("verifyManagedPackageInstallability rejects unpublished exact runtime dependencies with explicit guidance", () => {
    withTempPackageJson({
        name: "@zokizuan/satori-mcp",
        version: "4.4.1",
        dependencies: {
            "@zokizuan/satori-core": "1.1.1",
            chokidar: "^5.0.0",
        }
    }, (packageJsonPath) => {
        const seen: string[] = [];
        assert.throws(
            () => verifyManagedPackageInstallability({
                packageJsonPath,
                execFileSyncImpl: ((command: string, args: string[]) => {
                    seen.push(`${command} ${args.join(" ")}`);
                    if (args[1] === "@zokizuan/satori-mcp@4.4.1") {
                        return JSON.stringify("4.4.1");
                    }
                    throw Object.assign(new Error("missing"), {
                        stdout: "",
                        stderr: "npm error notarget No matching version found for @zokizuan/satori-core@1.1.1.\n",
                    });
                }) as never,
            }),
            /required dependency @zokizuan\/satori-core@1\.1\.1 is not published on npm/
        );
        assert.deepEqual(seen, [
            "npm view @zokizuan/satori-mcp@4.4.1 version --json",
            "npm view @zokizuan/satori-core@1.1.1 version --json",
        ]);
    });
});

test("verifyManagedPackageInstallability skips ranged dependencies and returns the managed package specifier", () => {
    withTempPackageJson({
        name: "@zokizuan/satori-mcp",
        version: "4.4.1",
        dependencies: {
            "@zokizuan/satori-core": "1.0.0",
            chokidar: "^5.0.0",
            ignore: "~7.0.5",
        }
    }, (packageJsonPath) => {
        const seen: string[] = [];
        const packageSpecifier = verifyManagedPackageInstallability({
            packageJsonPath,
            execFileSyncImpl: ((command: string, args: string[]) => {
                seen.push(`${command} ${args.join(" ")}`);
                return JSON.stringify(args[1].split("@").at(-1));
            }) as never,
        });
        assert.equal(packageSpecifier, "@zokizuan/satori-mcp@4.4.1");
        assert.deepEqual(seen, [
            "npm view @zokizuan/satori-mcp@4.4.1 version --json",
            "npm view @zokizuan/satori-core@1.0.0 version --json",
        ]);
    });
});

test("verifyManagedPackageInstallability resolves workspace dependencies to their local package version", () => {
    const repoTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-workspace-installability-"));
    try {
        const mcpDir = path.join(repoTempDir, "packages", "mcp");
        const coreDir = path.join(repoTempDir, "packages", "core");
        fs.mkdirSync(mcpDir, { recursive: true });
        fs.mkdirSync(coreDir, { recursive: true });
        fs.writeFileSync(path.join(mcpDir, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.4.1",
            dependencies: {
                "@zokizuan/satori-core": "workspace:*",
            }
        }, null, 2));
        fs.writeFileSync(path.join(coreDir, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "1.1.1",
        }, null, 2));

        const seen: string[] = [];
        const packageSpecifier = verifyManagedPackageInstallability({
            packageJsonPath: path.join(mcpDir, "package.json"),
            execFileSyncImpl: ((command: string, args: string[]) => {
                seen.push(`${command} ${args.join(" ")}`);
                return JSON.stringify(args[1].split("@").at(-1));
            }) as never,
        });

        assert.equal(packageSpecifier, "@zokizuan/satori-mcp@4.4.1");
        assert.deepEqual(seen, [
            "npm view @zokizuan/satori-mcp@4.4.1 version --json",
            "npm view @zokizuan/satori-core@1.1.1 version --json",
        ]);
    } finally {
        fs.rmSync(repoTempDir, { recursive: true, force: true });
    }
});
