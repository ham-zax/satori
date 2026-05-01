import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
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

function runInitializeSmoke(tarballPath: string, smokeExecDir: string): Promise<void> {
    const initializeInput = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
                name: "satori-release-smoke",
                version: "1.0.0",
            },
        },
    }) + "\n";

    return new Promise((resolve, reject) => {
        const child = spawn("npm", ["exec", "--yes", "--package", tarballPath, "--", "satori"], {
            cwd: smokeExecDir,
            env: {
                PATH: process.env.PATH || "",
                HOME: smokeExecDir,
                EMBEDDING_PROVIDER: "",
                OPENAI_API_KEY: "",
                VOYAGEAI_API_KEY: "",
                GEMINI_API_KEY: "",
                MILVUS_ADDRESS: "",
                MILVUS_TOKEN: "",
                MCP_ENABLE_WATCHER: "false",
                npm_config_package_lock: "false",
                npm_config_cache: path.join(smokeExecDir, ".npm-cache"),
            },
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        let stdout = "";
        let stderr = "";

        const terminateChild = () => {
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (child.pid && process.platform !== "win32") {
                try {
                    process.kill(-child.pid, "SIGTERM");
                    child.unref();
                    return;
                } catch {
                    // Fall back to killing the direct npm process below.
                }
            }
            child.kill("SIGTERM");
            child.unref();
        };

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            terminateChild();
            reject(new Error(`MCP initialize smoke timed out. stdout=${stdout} stderr=${stderr}`));
        }, 60000);

        const settleOk = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            terminateChild();
            resolve();
        };

        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            const initializeResponse = stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                })
                .find((message) => message?.id === 1);
            if (initializeResponse?.result?.serverInfo) {
                settleOk();
            }
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });
        child.on("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`MCP initialize smoke exited before initialize response. code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
        });

        child.stdin?.end(initializeInput);
    });
}

async function main(): Promise<void> {
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

        const tarballPath = path.join(smokePackDir, tarballName);
        execFileSync("npm", ["exec", "--yes", "--package", tarballPath, "--", "satori", "--help"], {
            cwd: smokeExecDir,
            encoding: "utf8",
            env: {
                ...process.env,
                npm_config_package_lock: "false",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        await runInitializeSmoke(tarballPath, smokeExecDir);
        console.log("[release:smoke] MCP tarball starts and responds to initialize with empty provider env.");
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

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release:smoke] ${message}`);
    process.exit(1);
});
