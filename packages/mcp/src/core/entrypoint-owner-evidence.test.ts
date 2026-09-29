import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import {
    prepareEntrypointOwnerEvidence,
    type EntrypointOwnerEvidenceResolution,
} from "./entrypoint-owner-evidence.js";

function withTempRepo<T>(run: (repoPath: string) => Promise<T>): Promise<T> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-entrypoint-owner-"));
    const repoPath = path.join(tempRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    return run(repoPath).finally(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });
}

function writeFile(repoPath: string, relativePath: string, content: string): void {
    const absolutePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
}

function symbol(
    file: string,
    qualifiedName: string,
    ordinal = 1,
): SymbolRecord {
    const name = qualifiedName.split(".").at(-1) as string;
    return {
        symbolKey: `symkey_${file}_${qualifiedName}`,
        symbolInstanceId: `syminst_${file}_${qualifiedName}_${ordinal}`,
        language: "python",
        kind: "function",
        name,
        qualifiedName,
        label: `function ${qualifiedName}`,
        file,
        span: { startLine: ordinal, endLine: ordinal + 1 },
        parentQualifiedNamePath: qualifiedName.split(".").slice(0, -1),
        fileHash: "a".repeat(64),
        extractorVersion: "test-extractor-v1",
    };
}

function registry(records: SymbolRecord[]): SymbolRegistry {
    const byFile = new Map<string, SymbolRecord[]>();
    for (const record of records) {
        byFile.set(record.file, [...(byFile.get(record.file) ?? []), record]);
    }
    return {
        manifest: {
            files: [...byFile.keys()].map((file) => ({
                path: file,
                language: "python",
            })),
        },
        symbolsByFile: byFile,
    } as unknown as SymbolRegistry;
}

const publication = {
    publicationId: "publication-v1",
    collectionName: "collection-v1",
    policyHash: "b".repeat(64),
    navigationPublicationId: "publication-v1",
    symbolRegistryManifestHash: "c".repeat(64),
};

async function resolvePrepared(input: {
    repoPath: string;
    registry: SymbolRegistry;
}): Promise<EntrypointOwnerEvidenceResolution> {
    const prepared = await prepareEntrypointOwnerEvidence({
        codebaseRoot: input.repoPath,
        publication,
        registry: input.registry,
    });
    if (!("resolution" in prepared)) return prepared;
    try {
        const finalized = await prepared.finalize();
        assert.equal(finalized.status, "available");
        return prepared.resolution;
    } finally {
        await prepared.release();
    }
}

test("resolves PEP 621 scripts to exact canonical Python symbols", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project]",
            'name = "fixture"',
            "",
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
            '"qap-admin" = "cli.admin:Admin.entry_point"',
            'qap-worker = "worker.main:worker_entry_point"',
        ].join("\n"));
        const records = [
            symbol("src/cli/main.py", "cli_entry_point"),
            symbol("src/cli/admin.py", "Admin.entry_point"),
            symbol("worker/main.py", "worker_entry_point"),
        ];

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry(records),
        });

        assert.equal(resolution.status, "resolved");
        assert.equal(resolution.declaredOwnerCount, 3);
        assert.equal(resolution.resolvedOwnerCount, 3);
        assert.equal(resolution.resolutionComplete, true);
        assert.equal(resolution.manifestSourceIdentity?.length, 64);
        assert.deepEqual(resolution.publicationBinding, publication);
        assert.equal(resolution.publicationIdentity.length, 64);
        assert.deepEqual(
            resolution.owners.map((owner) => ({
                command: owner.command,
                line: owner.declaration.startLine,
                path: owner.target.relativePath,
                symbol: owner.target.symbol,
                symbolInstanceId: owner.target.symbolInstanceId,
                confidence: owner.resolutionConfidence,
            })),
            [
                {
                    command: "qap",
                    line: 5,
                    path: "src/cli/main.py",
                    symbol: "cli_entry_point",
                    symbolInstanceId: records[0]?.symbolInstanceId,
                    confidence: "exact",
                },
                {
                    command: "qap-admin",
                    line: 6,
                    path: "src/cli/admin.py",
                    symbol: "Admin.entry_point",
                    symbolInstanceId: records[1]?.symbolInstanceId,
                    confidence: "exact",
                },
                {
                    command: "qap-worker",
                    line: 7,
                    path: "worker/main.py",
                    symbol: "worker_entry_point",
                    symbolInstanceId: records[2]?.symbolInstanceId,
                    confidence: "exact",
                },
            ],
        );
    });
});

test("fails closed when a module or exact symbol is ambiguous", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
        ].join("\n"));

        const ambiguousModule = await resolvePrepared({
            repoPath,
            registry: registry([
                symbol("cli/main.py", "cli_entry_point"),
                symbol("src/cli/main.py", "cli_entry_point"),
            ]),
        });
        assert.equal(ambiguousModule.status, "no_resolved_owners");

        const duplicateSymbol = await resolvePrepared({
            repoPath,
            registry: registry([
                symbol("src/cli/main.py", "cli_entry_point", 1),
                symbol("src/cli/main.py", "cli_entry_point", 2),
            ]),
        });
        assert.equal(duplicateSymbol.status, "no_resolved_owners");
    });
});

test("does not claim exact ownership when the declared symbol is absent", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
        ].join("\n"));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([symbol("src/cli/main.py", "other_entry_point")]),
        });

        assert.equal(resolution.status, "no_resolved_owners");
        assert.deepEqual(resolution.owners, []);
        assert.equal(resolution.declaredOwnerCount, 1);
        assert.equal(resolution.resolvedOwnerCount, 0);
        assert.equal(resolution.resolutionComplete, false);
    });
});

test("does not resolve a unique suffix outside supported Python source roots", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
        ].join("\n"));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([
                symbol("examples/cli/main.py", "cli_entry_point"),
            ]),
        });

        assert.equal(resolution.status, "no_resolved_owners");
        assert.deepEqual(resolution.owners, []);
        assert.equal(resolution.resolutionComplete, false);
    });
});

test("retains declaration completeness when only one of several commands resolves", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
            'qap-worker = "worker.main:worker_entry_point"',
        ].join("\n"));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([
                symbol("src/cli/main.py", "cli_entry_point"),
            ]),
        });

        assert.equal(resolution.status, "resolved");
        assert.deepEqual(resolution.owners.map((owner) => owner.command), ["qap"]);
        assert.equal(resolution.declaredOwnerCount, 2);
        assert.equal(resolution.resolvedOwnerCount, 1);
        assert.equal(resolution.resolutionComplete, false);
    });
});

test("fails closed instead of partially reading an unsupported scripts table", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
            'unsupported = { call = "cli.other:entrypoint" }',
        ].join("\n"));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([symbol("src/cli/main.py", "cli_entry_point")]),
        });

        assert.equal(resolution.status, "unsupported_manifest");
        assert.deepEqual(resolution.owners, []);
    });
});

test("fails closed for duplicate script tables or command declarations", async () => {
    await withTempRepo(async (repoPath) => {
        const fixtureRegistry = registry([symbol("src/cli/main.py", "cli_entry_point")]);
        for (const source of [
            [
                "[project.scripts]",
                'qap = "cli.main:cli_entry_point"',
                "",
                "[project.scripts]",
                'qap-admin = "cli.main:cli_entry_point"',
            ].join("\n"),
            [
                "[project.scripts]",
                'qap = "cli.main:cli_entry_point"',
                'qap = "cli.main:cli_entry_point"',
            ].join("\n"),
        ]) {
            writeFile(repoPath, "pyproject.toml", source);
            const resolution = await resolvePrepared({
                repoPath,
                registry: fixtureRegistry,
            });
            assert.equal(resolution.status, "unsupported_manifest");
        }
    });
});

test("returns no owners when a project declares no installed commands", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project]",
            'name = "fixture"',
        ].join("\n"));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([]),
        });

        assert.equal(resolution.status, "no_resolved_owners");
        assert.deepEqual(resolution.owners, []);
    });
});

test("fails closed when the scripts table exceeds the bounded entry limit", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            ...Array.from(
                { length: 65 },
                (_, index) => `command-${index} = "cli.main:cli_entry_point"`,
            ),
        ].join("\n"));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([symbol("src/cli/main.py", "cli_entry_point")]),
        });

        assert.equal(resolution.status, "manifest_entry_limit_exceeded");
        assert.deepEqual(resolution.owners, []);
        assert.equal(resolution.declaredOwnerCount, undefined);
        assert.equal(resolution.declaredOwnerCountLowerBound, 65);
    });
});

test("fails closed when pyproject.toml exceeds the byte inspection limit", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", "x".repeat((256 * 1024) + 1));

        const resolution = await resolvePrepared({
            repoPath,
            registry: registry([]),
        });

        assert.equal(resolution.status, "manifest_too_large");
        assert.deepEqual(resolution.owners, []);
        assert.equal(resolution.resolutionComplete, false);
    });
});

test("finalization rejects manifest changes after owner evidence was prepared", async () => {
    await withTempRepo(async (repoPath) => {
        writeFile(repoPath, "pyproject.toml", [
            "[project.scripts]",
            'qap = "cli.main:cli_entry_point"',
        ].join("\n"));
        const prepared = await prepareEntrypointOwnerEvidence({
            codebaseRoot: repoPath,
            publication,
            registry: registry([symbol("src/cli/main.py", "cli_entry_point")]),
        });
        assert.equal("resolution" in prepared, true);
        if (!("resolution" in prepared)) return;

        try {
            writeFile(repoPath, "pyproject.toml", [
                "[project.scripts]",
                'qap = "cli.admin:admin_entry_point"',
            ].join("\n"));
            const finalized = await prepared.finalize();
            assert.equal(finalized.status, "stale");
        } finally {
            await prepared.release();
        }
    });
});
