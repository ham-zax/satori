import test from "node:test";
import assert from "node:assert/strict";
import { installCliStdoutRedirect, installConsoleToStderrPatch, WritableStdoutLike } from "./stdio-safety.js";

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

test("installConsoleToStderrPatch only patches selected methods", () => {
    const writes: string[] = [];
    const logCalls: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
        logCalls.push(args);
    };

    const restore = installConsoleToStderrPatch({
        methods: ["warn"],
        writeToStderr: (text) => {
            writes.push(text);
        },
    });

    console.log("startup chatter");
    console.warn("actionable warning");

    restore();
    console.log = originalLog;

    assert.deepEqual(logCalls, [["startup chatter"]]);
    assert.equal(writes.some((line) => line.includes("startup chatter")), false);
    assert.equal(writes.some((line) => line.includes("actionable warning")), true);
});

test("installCliStdoutRedirect blocks writes quietly in drop mode", () => {
    const writes: Array<{ chunk: unknown; encoding?: unknown }> = [];
    const stderrWrites: string[] = [];
    const privateWrites: string[] = [];

    const fakeStdout: WritableStdoutLike & {
        _write(chunk: unknown): void;
        _writev(chunks: unknown): void;
    } = {
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
    assert.deepEqual(stderrWrites, []);
});

test("installCliStdoutRedirect emits deterministic markers in redirect mode", () => {
    const stderrWrites: string[] = [];
    const fakeStdout: WritableStdoutLike = {
        write() {
            return true;
        }
    };

    const restore = installCliStdoutRedirect({
        mode: "redirect",
        stdout: fakeStdout,
        writeToStderr: (text) => {
            stderrWrites.push(text);
        },
    });

    fakeStdout.write("hello");
    fakeStdout.write(Buffer.from("abc"));

    restore();

    assert.equal(stderrWrites.some((line) => line.includes("[STDOUT_BLOCKED] hello")), true);
    assert.equal(stderrWrites.some((line) => line.includes("[STDOUT_BLOCKED_BINARY")), true);
});
