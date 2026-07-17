import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(",")}}`;
    }
    return JSON.stringify(value);
}

function collectRuntimeFiles(repoRoot, relativeRoot) {
    const absoluteRoot = path.join(repoRoot, relativeRoot);
    if (!fs.statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
            `Instrumented Satori runtime is missing at '${absoluteRoot}'. Build the Core and MCP runtime before measurement.`,
        );
    }

    const pending = [absoluteRoot];
    const files = [];
    while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(absolutePath);
            } else if (entry.isFile()) {
                const bytes = fs.readFileSync(absolutePath);
                files.push({
                    relativeFile: path.relative(absoluteRoot, absolutePath).replace(/\\/g, "/"),
                    bytes: bytes.length,
                    sha256: sha256(bytes),
                });
            } else {
                throw new Error(`Unsupported entry in Satori runtime output: '${absolutePath}'.`);
            }
        }
    }
    files.sort((left, right) =>
        left.relativeFile < right.relativeFile
            ? -1
            : left.relativeFile > right.relativeFile
              ? 1
              : 0,
    );
    return files;
}

export function getSatoriRuntimeIdentity(repoRoot) {
    const roots = ["packages/core/dist", "packages/mcp/dist"].map((relativeRoot) => {
        const files = collectRuntimeFiles(repoRoot, relativeRoot);
        if (!files.some((file) => file.relativeFile === "index.js")) {
            throw new Error(
                `Instrumented Satori runtime has no index.js under '${path.join(repoRoot, relativeRoot)}'. Build the Core and MCP runtime before measurement.`,
            );
        }
        return {
            relativeRoot,
            fileCount: files.length,
            totalBytes: files.reduce((total, file) => total + file.bytes, 0),
            sha256: sha256(canonicalJson(files)),
        };
    });
    const identity = {
        schemaVersion: 1,
        nodeVersion: process.version,
        roots,
    };
    return {
        ...identity,
        sha256: sha256(canonicalJson(identity)),
    };
}
