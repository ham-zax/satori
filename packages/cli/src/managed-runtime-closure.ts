import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";
import type { InstallVectorStore } from "./args.js";
import { readManagedRuntimeRelease } from "./managed-package.js";

const LANCEDB_NATIVE_PACKAGES = new Map<string, string>([
    ["darwin-arm64-", "@lancedb/lancedb-darwin-arm64"],
    ["linux-arm64-gnu", "@lancedb/lancedb-linux-arm64-gnu"],
    ["linux-arm64-musl", "@lancedb/lancedb-linux-arm64-musl"],
    ["linux-x64-gnu", "@lancedb/lancedb-linux-x64-gnu"],
    ["linux-x64-musl", "@lancedb/lancedb-linux-x64-musl"],
    ["win32-arm64-", "@lancedb/lancedb-win32-arm64-msvc"],
    ["win32-x64-", "@lancedb/lancedb-win32-x64-msvc"],
]);
const OXC_PARSER_NATIVE_PACKAGES = new Map<string, string>([
    ["darwin-arm64-", "@oxc-parser/binding-darwin-arm64"],
    ["darwin-x64-", "@oxc-parser/binding-darwin-x64"],
    ["linux-arm64-gnu", "@oxc-parser/binding-linux-arm64-gnu"],
    ["linux-arm64-musl", "@oxc-parser/binding-linux-arm64-musl"],
    ["linux-x64-gnu", "@oxc-parser/binding-linux-x64-gnu"],
    ["linux-x64-musl", "@oxc-parser/binding-linux-x64-musl"],
    ["win32-arm64-", "@oxc-parser/binding-win32-arm64-msvc"],
    ["win32-ia32-", "@oxc-parser/binding-win32-ia32-msvc"],
    ["win32-x64-", "@oxc-parser/binding-win32-x64-msvc"],
]);
// TypeScript 7 ships its compiler as a host-native optional dependency and
// resolves it upward from the installed `typescript` package. The managed
// runtime installs with --omit=optional, so every host needs its exact
// platform package installed beside the MCP runtime or semantic analysis fails
// with "Unable to resolve @typescript/typescript-<platform>-<arch>".
const TYPESCRIPT_NATIVE_PACKAGES = new Map<string, string>([
    ["darwin-arm64-", "@typescript/typescript-darwin-arm64"],
    ["darwin-x64-", "@typescript/typescript-darwin-x64"],
    ["linux-arm64-", "@typescript/typescript-linux-arm64"],
    ["linux-x64-", "@typescript/typescript-linux-x64"],
    ["win32-arm64-", "@typescript/typescript-win32-arm64"],
    ["win32-x64-", "@typescript/typescript-win32-x64"],
]);
const MANAGED_RUNTIME_CLOSURE_FILE = ".satori-runtime-closure.json";

export interface ManagedRuntimeClosure {
    readonly vectorStore: InstallVectorStore;
    readonly lateOn?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly architecture?: string;
    readonly libc?: "gnu" | "musl";
}

type ManagedRuntimeClosureIdentity = Readonly<{
    // Format 4 adds the host-native TypeScript compiler package required by
    // semantic analysis. Older manifests intentionally fail closed and trigger
    // a fresh generation.
    formatVersion: 4;
    omitOptional: true;
    vectorStore: InstallVectorStore;
    lanceDbNativePackage: string | null;
    oxcParserNativePackage: string;
    typeScriptNativePackage: string;
    lateOnNativePackages: readonly string[];
}>;

function readManagedLanceDbVersion(): string {
    return readManagedRuntimeRelease().lanceDb;
}

function readManagedOxcParserVersion(): string {
    return readManagedRuntimeRelease().oxcParser;
}

function readManagedTypeScriptVersion(): string {
    return readManagedRuntimeRelease().typescript;
}

function detectLinuxLibc(): "gnu" | "musl" {
    if (process.platform !== "linux") {
        return "gnu";
    }
    try {
        const report = process.report?.getReport() as {
            header?: { glibcVersionRuntime?: unknown };
        } | undefined;
        return typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    } catch {
        return "gnu";
    }
}

export function resolveLanceDbNativePackage(
    closure: ManagedRuntimeClosure,
): string {
    const platform = closure.platform ?? process.platform;
    const architecture = closure.architecture ?? process.arch;
    const libc = closure.libc ?? detectLinuxLibc();
    const platformKey = `${platform}-${architecture}-${platform === "linux" ? libc : ""}`;
    const packageName = LANCEDB_NATIVE_PACKAGES.get(platformKey);
    if (!packageName) {
        throw new CliError(
            "E_USAGE",
            `LanceDB managed runtime is unsupported on ${platform}/${architecture}${platform === "linux" ? `/${libc}` : ""}.`,
            2,
        );
    }
    return `${packageName}@${readManagedLanceDbVersion()}`;
}

export function resolveOxcParserNativePackage(
    closure: ManagedRuntimeClosure,
): string {
    const platform = closure.platform ?? process.platform;
    const architecture = closure.architecture ?? process.arch;
    const libc = closure.libc ?? detectLinuxLibc();
    const platformKey = `${platform}-${architecture}-${platform === "linux" ? libc : ""}`;
    const packageName = OXC_PARSER_NATIVE_PACKAGES.get(platformKey);
    if (!packageName) {
        throw new CliError(
            "E_USAGE",
            `The Satori managed runtime is unsupported on ${platform}/${architecture}${platform === "linux" ? `/${libc}` : ""}.`,
            2,
        );
    }
    return `${packageName}@${readManagedOxcParserVersion()}`;
}

export function resolveTypeScriptNativePackage(
    closure: ManagedRuntimeClosure,
): string {
    const platform = closure.platform ?? process.platform;
    const architecture = closure.architecture ?? process.arch;
    const packageName = TYPESCRIPT_NATIVE_PACKAGES.get(`${platform}-${architecture}-`);
    if (!packageName) {
        throw new CliError(
            "E_USAGE",
            `The Satori managed runtime is unsupported on ${platform}/${architecture}: no managed TypeScript compiler target exists for this host.`,
            2,
        );
    }
    return `${packageName}@${readManagedTypeScriptVersion()}`;
}

export function resolveLateOnNativePackages(
    closure: ManagedRuntimeClosure,
): readonly string[] {
    if (closure.lateOn !== true) {
        return [];
    }
    const platform = closure.platform ?? process.platform;
    const architecture = closure.architecture ?? process.arch;
    const libc = closure.libc ?? detectLinuxLibc();
    const platformKey = `${platform}-${architecture}-${platform === "linux" ? libc : ""}`;
    const packages = readManagedRuntimeRelease().lateOn.sharpNativePackages[platformKey];
    if (!packages) {
        throw new CliError(
            "E_USAGE",
            `LateOn managed runtime is unsupported on ${platform}/${architecture}${platform === "linux" ? `/${libc}` : ""}.`,
            2,
        );
    }
    return packages;
}

export function resolveManagedRuntimeClosureIdentity(
    closure: ManagedRuntimeClosure,
): ManagedRuntimeClosureIdentity {
    return {
        formatVersion: 4,
        omitOptional: true,
        vectorStore: closure.vectorStore,
        lanceDbNativePackage: closure.vectorStore === "LanceDB"
            ? resolveLanceDbNativePackage(closure)
            : null,
        oxcParserNativePackage: resolveOxcParserNativePackage(closure),
        typeScriptNativePackage: resolveTypeScriptNativePackage(closure),
        lateOnNativePackages: resolveLateOnNativePackages(closure),
    };
}

function closureManifestPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, MANAGED_RUNTIME_CLOSURE_FILE);
}

export function managedRuntimeClosureMatches(
    runtimeRoot: string,
    closure: ManagedRuntimeClosure,
): boolean {
    try {
        const actual = JSON.parse(
            fs.readFileSync(closureManifestPath(runtimeRoot), "utf8"),
        ) as unknown;
        const expected = resolveManagedRuntimeClosureIdentity(closure);
        return typeof actual === "object"
            && actual !== null
            && !Array.isArray(actual)
            && (actual as Record<string, unknown>).formatVersion === expected.formatVersion
            && (actual as Record<string, unknown>).omitOptional === expected.omitOptional
            && (actual as Record<string, unknown>).vectorStore === expected.vectorStore
            && (actual as Record<string, unknown>).lanceDbNativePackage
                === expected.lanceDbNativePackage
            && (actual as Record<string, unknown>).oxcParserNativePackage
                === expected.oxcParserNativePackage
            && (actual as Record<string, unknown>).typeScriptNativePackage
                === expected.typeScriptNativePackage
            && Array.isArray((actual as Record<string, unknown>).lateOnNativePackages)
            && JSON.stringify((actual as Record<string, unknown>).lateOnNativePackages)
                === JSON.stringify(expected.lateOnNativePackages);
    } catch {
        return false;
    }
}

export function writeManagedRuntimeClosureManifest(
    runtimeRoot: string,
    closure: ManagedRuntimeClosure,
): void {
    const manifestPath = closureManifestPath(runtimeRoot);
    const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify(resolveManagedRuntimeClosureIdentity(closure), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporaryPath, manifestPath);
}
