import test from "node:test";
import assert from "node:assert/strict";
import { installBootstrapStdioSafety } from "./bootstrap-stdio.js";

test("installBootstrapStdioSafety guards mcp stdout without blocking captured protocol writer", () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const fakeStdout: Record<string, any> = {
        write(chunk: unknown) {
            stdoutWrites.push(String(chunk));
            return true;
        },
    };
    const protocolWrite = fakeStdout.write.bind(fakeStdout);

    const restore = installBootstrapStdioSafety({
        runMode: "mcp",
        guardMode: "drop",
        stdout: fakeStdout,
        writeToStderr: (text) => {
            stderrWrites.push(text);
        },
    });

    fakeStdout.write("third-party warning\n");
    protocolWrite("{\"jsonrpc\":\"2.0\"}\n");

    restore();

    assert.deepEqual(stdoutWrites, ["{\"jsonrpc\":\"2.0\"}\n"]);
    assert.equal(stderrWrites.some((line) => line.includes("[STDOUT_BLOCKED]")), true);
});
