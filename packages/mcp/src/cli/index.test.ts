import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isExecutedDirectlyForPaths, runCli } from "./index.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_SERVER_ENTRY = path.join(PACKAGE_ROOT, "src", "index.ts");

function writeTempScript(prefix: string, content: string): string {
    const tempDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, `.tmp-${prefix}-`));
    const scriptPath = path.join(tempDir, `${prefix}.mjs`);
    fs.writeFileSync(scriptPath, content, "utf8");
    return scriptPath;
}

function captureIo() {
    let stdout = "";
    let stderr = "";
    return {
        writeStdout: (text: string) => {
            stdout += text;
        },
        writeStderr: (text: string) => {
            stderr += text;
        },
        read: () => ({ stdout, stderr }),
    };
}

const WELL_BEHAVED_SERVER = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

for (const method of ["log","info","warn","error","debug"]) {
  console[method] = (...args) => process.stderr.write(\`[\${method}] \${args.map(String).join(" ")}\\n\`);
}
console.log("noise-log");
process.stderr.write("noise-stderr\\n");

const mode = process.env.FAKE_MODE || "normal";
const envelopeStatus = process.env.ENVELOPE_STATUS || "not_ready";
const envelopeReason = process.env.ENVELOPE_REASON || "indexing";

let statusPolls = 0;
const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "manage_index",
      description: "manage",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "reindex", "status"] },
          path: { type: "string" }
        },
        required: ["action", "path"]
      }
    },
    {
      name: "search_codebase",
      description: "search",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          query: { type: "string" },
          debug: { type: "boolean" }
        },
        required: ["path", "query"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};
  if (mode === "envelope") {
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ status: envelopeStatus, reason: envelopeReason }) }]
    };
  }

  if (mode === "manage_wait" && name === "manage_index") {
    if (args.action === "create" || args.action === "reindex") {
      return { isError: false, content: [{ type: "text", text: "started indexing" }] };
    }
    if (args.action === "status") {
      statusPolls += 1;
      if (statusPolls < 3) {
        return { isError: false, content: [{ type: "text", text: "🔄 Codebase '/repo' is currently being indexed." }] };
      }
      return { isError: false, content: [{ type: "text", text: \`✅ Codebase '/repo' is fully indexed and ready for search. polls=\${statusPolls}\` }] };
    }
  }

  if (mode === "manage_initial_error" && name === "manage_index" && (args.action === "create" || args.action === "reindex")) {
    return { isError: true, content: [{ type: "text", text: "create failed immediately" }] };
  }

  if (mode === "manage_initial_blocked" && name === "manage_index") {
    if (args.action === "create" || args.action === "reindex") {
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ status: "not_ready", reason: "indexing" }) }]
      };
    }
    if (args.action === "status") {
      return { isError: false, content: [{ type: "text", text: "POLLED_STATUS_SHOULD_NOT_HAPPEN" }] };
    }
  }

  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: name, args }) }]
  };
});

await server.connect(new StdioServerTransport());
`;

const CORRUPTED_SERVER = `
process.stdout.write("NOISE\\n");
setTimeout(() => process.exit(0), 10);
`;

test("runCli tools list succeeds with stderr noise and emits JSON to stdout", async () => {
    const scriptPath = writeTempScript("fake-mcp", WELL_BEHAVED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli(["tools", "list"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            serverEnv: { FAKE_MODE: "normal" },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 0);
        const parsed = JSON.parse(stdout);
        const toolNames = parsed.tools.map((tool: { name: string }) => tool.name);
        assert.equal(toolNames.includes("manage_index"), true);
        assert.equal(toolNames.includes("search_codebase"), true);
        assert.equal(stderr.includes("noise-stderr"), true);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("runCli fails with deterministic protocol error when server corrupts stdout stream", async () => {
    const scriptPath = writeTempScript("fake-mcp-corrupt", CORRUPTED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli(["tools", "list"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 3);
        assert.equal(stderr.includes("E_PROTOCOL_FAILURE"), true);
        assert.equal(stdout.trim().length, 0);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("runCli treats structured non-ok envelope as tool error even when isError=false", async () => {
    const scriptPath = writeTempScript("fake-mcp-envelope", WELL_BEHAVED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli(["search_codebase", "--path", "/repo", "--query", "auth"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            serverEnv: { FAKE_MODE: "envelope", ENVELOPE_STATUS: "not_ready", ENVELOPE_REASON: "indexing" },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stderr } = io.read();
        assert.equal(exitCode, 1);
        assert.equal(stderr.includes("E_TOOL_ERROR"), true);
        assert.equal(stderr.includes("status=not_ready"), true);
        assert.equal(stderr.includes("reason=indexing"), true);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("runCli waits for manage_index create until status reaches terminal indexed state", async () => {
    const scriptPath = writeTempScript("fake-mcp-manage", WELL_BEHAVED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli([
            "--call-timeout-ms",
            "10000",
            "manage_index",
            "--action",
            "create",
            "--path",
            "/repo"
        ], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            serverEnv: { FAKE_MODE: "manage_wait" },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stdout } = io.read();
        assert.equal(exitCode, 0);
        assert.equal(stdout.includes("fully indexed"), true);
        assert.equal(stdout.includes("polls=3"), true);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("runCli forwards wrapper --debug to tool arguments instead of consuming it globally", async () => {
    const scriptPath = writeTempScript("fake-mcp-wrapper-debug", WELL_BEHAVED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli(["search_codebase", "--path", "/repo", "--query", "auth", "--debug"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            serverEnv: { FAKE_MODE: "normal" },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stdout } = io.read();
        assert.equal(exitCode, 0);
        const parsed = JSON.parse(stdout);
        const contentText = parsed?.content?.[0]?.text as string;
        const payload = JSON.parse(contentText);
        assert.equal(payload?.args?.debug, true);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("runCli returns initial manage_index create error without polling status", async () => {
    const scriptPath = writeTempScript("fake-mcp-manage-create-error", WELL_BEHAVED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli(["manage_index", "--action", "create", "--path", "/repo"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            serverEnv: { FAKE_MODE: "manage_initial_error" },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 1);
        assert.equal(stderr.includes("E_TOOL_ERROR"), true);
        assert.equal(stdout.includes("create failed immediately"), true);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("runCli exits on initial manage_index blocked envelope without polling status", async () => {
    const scriptPath = writeTempScript("fake-mcp-manage-create-blocked", WELL_BEHAVED_SERVER);
    const io = captureIo();

    try {
        const exitCode = await runCli(["manage_index", "--action", "create", "--path", "/repo"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: [scriptPath],
            serverEnv: { FAKE_MODE: "manage_initial_blocked" },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 1);
        assert.equal(stderr.includes("E_TOOL_ERROR"), true);
        assert.equal(stderr.includes("status=not_ready"), true);
        assert.equal(stdout.includes("POLLED_STATUS_SHOULD_NOT_HAPPEN"), false);
    } finally {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    }
});

test("protocol smoke: real server in cli mode with default guard serves tools/list", { timeout: 60_000 }, async () => {
    const io = captureIo();

    const exitCode = await runCli(["tools", "list"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        serverCommand: process.execPath,
        serverArgs: ["--import", "tsx", SOURCE_SERVER_ENTRY],
        serverEnv: {
            EMBEDDING_PROVIDER: "Ollama",
            EMBEDDING_MODEL: "nomic-embed-text",
            OLLAMA_HOST: "http://127.0.0.1:11434",
            MILVUS_ADDRESS: "localhost:19530",
            MCP_ENABLE_WATCHER: "false",
            // Force default guard behavior in test regardless of parent env.
            SATORI_CLI_STDOUT_GUARD: "",
        },
        cwd: PACKAGE_ROOT,
        startupTimeoutMs: 30_000,
        callTimeoutMs: 30_000,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 0);
    assert.equal(stderr.includes("E_PROTOCOL_FAILURE"), false);

    const parsed = JSON.parse(stdout) as { tools?: Array<{ name?: string }> };
    assert.equal(Array.isArray(parsed.tools), true);
    const toolNames = (parsed.tools || [])
        .map((tool) => tool?.name)
        .filter((name): name is string => typeof name === "string");
    assert.equal(toolNames.includes("manage_index"), true);
    assert.equal(toolNames.includes("search_codebase"), true);
});

test("isExecutedDirectlyForPaths treats symlinked bin path as direct execution", () => {
    const tempDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-cli-symlink-"));
    const realFilePath = path.join(tempDir, "real-entry.js");
    const symlinkPath = path.join(tempDir, "symlink-entry.js");
    fs.writeFileSync(realFilePath, "console.log('noop');", "utf8");
    fs.symlinkSync(realFilePath, symlinkPath);

    try {
        const moduleUrl = pathToFileURL(realFilePath).href;
        assert.equal(isExecutedDirectlyForPaths(moduleUrl, symlinkPath), true);
        assert.equal(isExecutedDirectlyForPaths(moduleUrl, path.join(tempDir, "different.js")), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
