/**
 * Single source of truth for the installer-managed Satori MCP launcher body.
 * Used by packages/cli install and scripts/install-local-mcp-runtime.mjs.
 */

export const DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS = 5_000;

/**
 * @param {{ command: string, args: readonly string[], shutdownGraceMs?: number }} options
 * @returns {string}
 */
export function buildLauncherScript(options) {
  const command = options.command;
  const args = options.args;
  const shutdownGraceMs = Number.isFinite(options.shutdownGraceMs) && options.shutdownGraceMs >= 0
    ? Math.floor(options.shutdownGraceMs)
    : DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS;

  return [
    "#!/usr/bin/env node",
    "",
    'const { spawn } = require("node:child_process");',
    "",
    `const command = ${JSON.stringify(command)};`,
    `const baseArgs = ${JSON.stringify(args)};`,
    `const shutdownGraceMs = ${JSON.stringify(shutdownGraceMs)};`,
    "const child = spawn(command, [...baseArgs, ...process.argv.slice(2)], {",
    '  stdio: "inherit",',
    "  env: process.env,",
    "});",
    "",
    "let shutdownSignal = null;",
    "let forceKillTimer = null;",
    "",
    "function clearForceKillTimer() {",
    "  if (forceKillTimer) {",
    "    clearTimeout(forceKillTimer);",
    "    forceKillTimer = null;",
    "  }",
    "}",
    "",
    "function forwardShutdown(signal) {",
    "  if (shutdownSignal) {",
    "    return;",
    "  }",
    "  shutdownSignal = signal;",
    "  if (child.exitCode === null && child.signalCode === null) {",
    "    try {",
    "      child.kill(signal);",
    "    } catch {",
    "      // Child may already be gone between the liveness check and kill.",
    "    }",
    "    forceKillTimer = setTimeout(() => {",
    "      forceKillTimer = null;",
    "      if (child.exitCode === null && child.signalCode === null) {",
    "        try {",
    "          child.kill(\"SIGKILL\");",
    "        } catch {",
    "          // Ignore races where the child exits before forced kill.",
    "        }",
    "      }",
    "    }, shutdownGraceMs);",
    "    if (typeof forceKillTimer.unref === \"function\") {",
    "      forceKillTimer.unref();",
    "    }",
    "  }",
    "}",
    "",
    'for (const signal of ["SIGINT", "SIGTERM"]) {',
    "  process.on(signal, () => {",
    "    forwardShutdown(signal);",
    "  });",
    "}",
    "",
    'child.on("error", (error) => {',
    "  clearForceKillTimer();",
    "  console.error(`Failed to start Satori MCP runtime: ${error.message}`);",
    "  process.exit(1);",
    "});",
    "",
    'child.on("exit", (code, signal) => {',
    "  clearForceKillTimer();",
    "  if (shutdownSignal) {",
    "    process.removeAllListeners(shutdownSignal);",
    "    process.kill(process.pid, shutdownSignal);",
    "    return;",
    "  }",
    "  if (signal) {",
    "    console.error(`Satori MCP runtime exited from signal ${signal}`);",
    "    process.exit(1);",
    "  }",
    "  process.exit(code ?? 0);",
    "});",
    "",
  ].join("\n");
}
