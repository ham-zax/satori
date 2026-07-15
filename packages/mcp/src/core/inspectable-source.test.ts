import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    withSourceMeasurementOperation,
    type SourceMeasurementLedgerRecord,
} from "@zokizuan/satori-core";
import { prepareInspectableSource } from "./inspectable-source.js";

function readLedger(ledgerFile: string): SourceMeasurementLedgerRecord[] {
    return fs.readFileSync(ledgerFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SourceMeasurementLedgerRecord);
}

test("inspectable source reads above the legacy 256 KiB ceiling under an explicit limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-large-"));
    const relativeFile = "src/large.ts";
    const source = `export function largeOwner() {\n${"  const value = true;\n".repeat(14_000)}}\n`;
    const sourceBytes = Buffer.from(source, "utf8");
    assert.ok(sourceBytes.length > 256 * 1024);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), sourceBytes);

    try {
        const prepared = await prepareInspectableSource({
            codebaseRoot: root,
            relativeFile,
            maxInspectableBytes: sourceBytes.length,
        });
        assert.equal(prepared.status, "available");
        if (prepared.status !== "available") return;
        assert.equal(prepared.evidence.sourceByteLength, sourceBytes.length);
        assert.equal(
            prepared.evidence.observedHash,
            crypto.createHash("sha256").update(sourceBytes).digest("hex"),
        );
        try {
            assert.deepEqual(await prepared.finalizer.finalize(), {
                status: "available",
                freshness: "current_at_final_observation",
            });
        } finally {
            await prepared.finalizer.release();
        }
        assert.deepEqual(prepared.evidence.selectionCapabilities, {
            localLexical: "available",
            lineWindows: "available",
            syntaxBoundaries: "unavailable_streaming_source",
            controlFlowAnchors: "unavailable_streaming_source",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("inspectable source completes measurement only for fully validated evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-measured-"));
    const relativeFile = "src/source.ts";
    const source = "export const value = true;\n";
    const ledgerFile = path.join(root, "source-ledger.jsonl");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), source);

    try {
        const prepared = await withSourceMeasurementOperation({
            operation: "read_file",
            ledgerFile,
            rootDir: root,
        }, async () => {
            const value = await prepareInspectableSource({
                codebaseRoot: root,
                relativeFile,
                maxInspectableBytes: 1024,
            });
            if (value.status !== "available") return value;
            try {
                await value.finalizer.finalize();
                return value;
            } finally {
                await value.finalizer.release();
            }
        });
        assert.equal(prepared.status, "available");
        const records = readLedger(ledgerFile);
        const outcomes = records.filter((record) => record.kind === "source_observation_outcome");
        const bytesObtained = records
            .filter((record) => record.kind === "source_io")
            .reduce((total, record) => total + record.bytesObtained, 0);
        assert.deepEqual(outcomes.map((record) => record.status), ["completed"]);
        assert.equal(bytesObtained, Buffer.byteLength(source));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("inspectable source reports its explicit inspection ceiling without a resource-limit error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-limit-"));
    const relativeFile = "src/large.ts";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, relativeFile), "x".repeat(1025));

    try {
        assert.deepEqual(await prepareInspectableSource({
            codebaseRoot: root,
            relativeFile,
            maxInspectableBytes: 1024,
        }), {
            status: "unavailable",
            reason: "source_exceeds_inspection_limit",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("inspectable source rejects atomic replacement after descriptor validation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-replace-"));
    const relativeFile = "src/source.ts";
    const filePath = path.join(root, relativeFile);
    const replacementPath = path.join(root, "src/replacement.ts");
    const ledgerFile = path.join(root, "source-ledger.jsonl");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(filePath, "export const value = 'old';\n");
    fs.writeFileSync(replacementPath, "export const value = 'new';\n");

    try {
        const prepared = await withSourceMeasurementOperation({
            operation: "read_file",
            ledgerFile,
            rootDir: root,
        }, async () => {
            const value = await prepareInspectableSource({
                codebaseRoot: root,
                relativeFile,
                maxInspectableBytes: 1024,
            });
            if (value.status !== "available") return value;
            try {
                return await value.finalizer.finalize({
                    validatePreparedAuthority: async () => {
                        fs.renameSync(replacementPath, filePath);
                    },
                });
            } finally {
                await value.finalizer.release();
            }
        });
        assert.deepEqual(prepared, {
            status: "stale",
            reason: "path_identity_changed_during_inspection",
        });
        const outcomes = readLedger(ledgerFile).filter((record) => (
            record.kind === "source_observation_outcome"
        ));
        assert.deepEqual(outcomes.map((record) => record.status), ["partial"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("inspectable source rejects an in-place write after descriptor validation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-mutate-"));
    const relativeFile = "src/source.ts";
    const filePath = path.join(root, relativeFile);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(filePath, "export const value = 'old';\n");

    try {
        const prepared = await prepareInspectableSource({
            codebaseRoot: root,
            relativeFile,
            maxInspectableBytes: 1024,
        });
        assert.equal(prepared.status, "available");
        if (prepared.status !== "available") return;
        let finalized;
        try {
            finalized = await prepared.finalizer.finalize({
                validatePreparedAuthority: async () => {
                    fs.writeFileSync(filePath, "export const value = 'new and longer';\n");
                },
            });
        } finally {
            await prepared.finalizer.release();
        }
        assert.deepEqual(finalized, {
            status: "stale",
            reason: "source_changed_during_inspection",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("inspectable source preserves root escape as a safety failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-root-"));
    try {
        assert.deepEqual(await prepareInspectableSource({
            codebaseRoot: root,
            relativeFile: "../outside.ts",
            maxInspectableBytes: 1024,
        }), {
            status: "safety_error",
            reason: "root_binding_invalid",
            diagnosticCode: "ROOT_BINDING_INVALID",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("inspectable source preserves a final path escape as a safety failure", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-final-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "satori-inspectable-outside-"));
    const relativeFile = "src/source.ts";
    const filePath = path.join(root, relativeFile);
    const outsideFile = path.join(outside, "source.ts");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(filePath, "export const value = 'inside';\n");
    fs.writeFileSync(outsideFile, "export const value = 'outside';\n");

    try {
        let symlinkUnavailable = false;
        const prepared = await prepareInspectableSource({
            codebaseRoot: root,
            relativeFile,
            maxInspectableBytes: 1024,
        });
        assert.equal(prepared.status, "available");
        if (prepared.status !== "available") return;
        let finalized;
        try {
            finalized = await prepared.finalizer.finalize({
                validatePreparedAuthority: async () => {
                    fs.rmSync(filePath);
                    try {
                        fs.symlinkSync(outsideFile, filePath);
                    } catch (error: unknown) {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
                            symlinkUnavailable = true;
                            t.skip(`File symlinks are unavailable on this platform: ${code}`);
                            return;
                        }
                        throw error;
                    }
                },
            });
        } finally {
            await prepared.finalizer.release();
        }
        if (symlinkUnavailable) return;
        assert.deepEqual(finalized, {
            status: "safety_error",
            reason: "root_binding_invalid",
            diagnosticCode: "ROOT_BINDING_INVALID",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
