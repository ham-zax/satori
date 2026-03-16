import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function npmOutput(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const stdout = "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    const stderr = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    return `${stdout}\n${stderr}\n${error.message}`.trim();
}

function main(): void {
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(currentFile), "..");
    const smokePackDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-release-smoke-"));
    const smokeExecDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-release-exec-"));

    try {
        const beforeFiles = new Set(fs.readdirSync(smokePackDir));
        execFileSync("pnpm", ["pack", "--pack-destination", smokePackDir], {
            cwd: packageRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const tarballName = fs.readdirSync(smokePackDir).find((entry) => entry.endsWith(".tgz") && !beforeFiles.has(entry));
        if (!tarballName) {
            throw new Error("pnpm pack did not produce a tarball.");
        }

        execFileSync("npm", ["exec", "--yes", "--package", path.join(smokePackDir, tarballName), "--", "satori", "--help"], {
            cwd: smokeExecDir,
            encoding: "utf8",
            env: {
                ...process.env,
                npm_config_package_lock: "false",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        console.log("[release:smoke] MCP tarball starts via npm exec.");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = error instanceof Error ? npmOutput(error) : "";
        console.error(`[release:smoke] ${message}${detail ? ` ${detail}` : ""}`);
        process.exit(1);
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
        fs.rmSync(smokeExecDir, { recursive: true, force: true });
    }
}

main();
