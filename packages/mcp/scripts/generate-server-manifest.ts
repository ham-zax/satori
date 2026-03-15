import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJsonShape {
    name: string;
    version: string;
    description?: string;
}

function buildManifest(pkg: PackageJsonShape) {
    return {
        schemaVersion: 1,
        id: "satori",
        name: "Satori MCP",
        packageName: pkg.name,
        version: pkg.version,
        description: pkg.description || "MCP server for Satori with agent-safe semantic search and indexing",
        install: {
            command: "npx",
            args: ["-y", "--package", `${pkg.name}@${pkg.version}`, "satori"],
            startupTimeoutMs: 180000,
        },
        clients: {
            codex: {
                configPath: "~/.codex/config.toml",
                configFormat: "toml",
                skillsPath: "~/.codex/skills",
            },
            claude: {
                configPath: "~/.claude/settings.json",
                configFormat: "json",
                skillsPath: "~/.claude/skills",
            },
        },
        skills: [
            "satori-search",
            "satori-navigation",
            "satori-indexing",
        ],
    };
}

function main(): void {
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(currentFile), "..");
    const repoRoot = path.resolve(packageRoot, "..", "..");
    const packageJsonPath = path.join(packageRoot, "package.json");
    const manifestPath = path.join(repoRoot, "server.json");
    const checkMode = process.argv.includes("--check");

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJsonShape;
    const next = `${JSON.stringify(buildManifest(pkg), null, 2)}\n`;

    if (checkMode) {
        const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
        if (current !== next) {
            console.error("[manifest:check] server.json is out of date. Run: pnpm -C packages/mcp manifest:generate");
            process.exit(1);
        }
        console.log("[manifest:check] server.json is up to date.");
        return;
    }

    fs.writeFileSync(manifestPath, next, "utf8");
    console.log("[manifest:generate] server.json updated.");
}

main();
