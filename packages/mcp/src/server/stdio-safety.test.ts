import test from "node:test";
import assert from "node:assert/strict";
import { installCliStdoutRedirect, installConsoleToStderrPatch } from "./stdio-safety.js";

test("installConsoleToStderrPatch routes console output to stderr writer", () => {
    const writes: string[] = [];
    const restore = installConsoleToStderrPatch({
        writeToStderr: (text) => {
            writes.push(text);
        },
    });

    console.log("log", 1);
    console.info("info", 2);
    console.warn("warn", 3);
    console.error("error", 4);
    console.debug("debug", 5);

    restore();

    const joined = writes.join("");
    assert.match(joined, /log 1/);
    assert.match(joined, /info 2/);
    assert.match(joined, /warn 3/);
    assert.match(joined, /error 4/);
    assert.match(joined, /debug 5/);
});

test("installCliStdoutRedirect blocks writes in drop mode and emits deterministic markers", () => {
    const writes: Array<{ chunk: unknown; encoding?: unknown }> = [];
    const stderrWrites: string[] = [];
    const privateWrites: string[] = [];

    const fakeStdout: Record<string, any> = {
        write(chunk: unknown, encoding?: unknown) {
            writes.push({ chunk, encoding });
            return true;
        },
        end(chunk?: unknown) {
            writes.push({ chunk, encoding: "end" });
            return true;
        },
        writev(chunks: unknown) {
            writes.push({ chunk: chunks, encoding: "writev" });
            return true;
        },
        _write(chunk: unknown) {
            privateWrites.push(String(chunk));
        },
        _writev(chunks: unknown) {
            privateWrites.push(JSON.stringify(chunks));
        }
    };

    const originalPrivateWrite = fakeStdout._write;
    const originalPrivateWritev = fakeStdout._writev;

    const restore = installCliStdoutRedirect({
        mode: "drop",
        stdout: fakeStdout,
        writeToStderr: (text) => {
            stderrWrites.push(text);
        },
    });

    fakeStdout.write("hello");
    fakeStdout.write(Buffer.from("abc"));
    fakeStdout.end("done");
    fakeStdout.writev([{ chunk: "chunked" }]);
    fakeStdout._write("private", "utf8", () => { });
    fakeStdout._writev([{ chunk: "privatev" }], () => { });

    restore();

    assert.equal(writes.length, 0);
    assert.equal(privateWrites.length, 2);
    assert.equal(fakeStdout._write, originalPrivateWrite);
    assert.equal(fakeStdout._writev, originalPrivateWritev);
    assert.equal(stderrWrites.some((line) => line.includes("[STDOUT_BLOCKED]")), true);
    assert.equal(stderrWrites.some((line) => line.includes("[STDOUT_BLOCKED_BINARY")), true);
});
