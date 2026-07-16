/**
 * Single source of truth for the installer-managed Satori MCP launcher body.
 * Used by packages/cli install and scripts/install-local-mcp-runtime.mjs.
 */

export const DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS = 5_000;
const EOF_SHUTDOWN_GRACE_MS = 1_500;
const MANAGED_ENV_PREFIX = "const managedEnv = ";

/**
 * Read the non-secret runtime selection persisted by buildLauncherScript().
 * Launchers generated before runtime profiles existed intentionally resolve to
 * an empty environment so existing connected installations remain valid.
 *
 * @param {string} content
 * @returns {Readonly<Record<string, string>>}
 */
export function parseManagedLauncherEnvironment(content) {
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith(MANAGED_ENV_PREFIX));
  if (line === undefined) {
    return Object.freeze({});
  }
  if (!line.endsWith(";")) {
    throw new Error("Managed launcher runtime environment is malformed.");
  }
  let parsed;
  try {
    parsed = JSON.parse(line.slice(MANAGED_ENV_PREFIX.length, -1));
  } catch {
    throw new Error("Managed launcher runtime environment is malformed.");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || Object.values(parsed).some((value) => typeof value !== "string")
  ) {
    throw new Error("Managed launcher runtime environment must contain only string values.");
  }
  return Object.freeze({ ...parsed });
}

/**
 * @param {{ command: string, args: readonly string[], managedEnv?: Readonly<Record<string, string>>, shutdownGraceMs?: number }} options
 * @returns {string}
 */
export function buildLauncherScript(options) {
  const command = options.command;
  const args = options.args;
  const managedEnv = options.managedEnv ?? {};
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
    `const managedEnv = ${JSON.stringify(managedEnv)};`,
    `const shutdownGraceMs = ${JSON.stringify(shutdownGraceMs)};`,
    "const child = spawn(command, [...baseArgs, ...process.argv.slice(2)], {",
    '  stdio: ["pipe", "inherit", "inherit"],',
    "  env: { ...process.env, ...managedEnv },",
    "});",
    "",
    'let shutdownReason = null;',
    "let forceKillTimer = null;",
    "",
    "function clearForceKillTimer() {",
    "  if (forceKillTimer) {",
    "    clearTimeout(forceKillTimer);",
    "    forceKillTimer = null;",
    "  }",
    "}",
    "",
    "function scheduleForceKill(graceMs) {",
    "  forceKillTimer = setTimeout(() => {",
    "    forceKillTimer = null;",
    "    if (child.exitCode === null && child.signalCode === null) {",
    "      try {",
    '        child.kill("SIGKILL");',
    "      } catch {",
    "        // Ignore races where the child exits before forced kill.",
    "      }",
    "    }",
    "  }, graceMs);",
    '  if (typeof forceKillTimer.unref === "function") {',
    "    forceKillTimer.unref();",
    "  }",
    "}",
    "",
    "function forwardShutdown(signal) {",
    "  if (shutdownReason) {",
    "    return;",
    "  }",
    "  shutdownReason = signal;",
    "  if (child.exitCode === null && child.signalCode === null) {",
    "    try {",
    "      child.kill(signal);",
    "    } catch {",
    "      // Child may already be gone between the liveness check and kill.",
    "    }",
    "    scheduleForceKill(shutdownGraceMs);",
    "  }",
    "}",
    "",
    "function handleStdinEnd() {",
    "  if (shutdownReason) {",
    "    return;",
    "  }",
    '  shutdownReason = "EOF";',
    "  if (child.exitCode === null && child.signalCode === null) {",
    `    scheduleForceKill(Math.min(shutdownGraceMs, ${EOF_SHUTDOWN_GRACE_MS}));`,
    "  }",
    "}",
    "",
    "if (child.stdin) {",
    "  process.stdin.pipe(child.stdin);",
    '  child.stdin.on("error", () => {',
    "    // The runtime may close stdin while the launcher is still draining input.",
    "  });",
    "}",
    'process.stdin.once("end", handleStdinEnd);',
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
    '  if (shutdownReason === "SIGINT" || shutdownReason === "SIGTERM") {',
    "    process.removeAllListeners(shutdownReason);",
    "    process.kill(process.pid, shutdownReason);",
    "    return;",
    "  }",
    '  if (shutdownReason === "EOF") {',
    "    process.exit(0);",
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
