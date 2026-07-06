import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJsonShape {
    name: string;
    version: string;
    description?: string;
}

function buildManifest(pkg: PackageJsonShape, cliPkg: PackageJsonShape) {
    return {
        schemaVersion: 1,
        id: "satori",
        name: "Satori MCP",
        packageName: pkg.name,
        version: pkg.version,
        description: pkg.description || "MCP server for Satori with agent-safe semantic search and indexing",
        install: {
            command: "npx",
            args: ["-y", `${cliPkg.name}@latest`, "install", "--client", "all"],
            managedRuntime: true,
        },
        clients: {
            codex: {
                configPath: "~/.codex/config.toml",
                configFormat: "toml",
            },
            claude: {
                configPath: "~/.claude.json",
                configFormat: "json",
            },
            opencode: {
                configPath: "~/.config/opencode/opencode.json",
                configFormat: "jsonc",
            },
        },
    };
}

function main(): void {
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(currentFile), "..");
    const repoRoot = path.resolve(packageRoot, "..", "..");
    const packageJsonPath = path.join(packageRoot, "package.json");
    const cliPackageJsonPath = path.join(repoRoot, "packages", "cli", "package.json");
    const manifestPath = path.join(repoRoot, "server.json");
    const checkMode = process.argv.includes("--check");

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJsonShape;
    const cliPkg = JSON.parse(fs.readFileSync(cliPackageJsonPath, "utf8")) as PackageJsonShape;
    const next = `${JSON.stringify(buildManifest(pkg, cliPkg), null, 2)}\n`;

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
