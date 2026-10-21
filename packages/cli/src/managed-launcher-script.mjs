/**
 * Single source of truth for the installer-managed Satori MCP launcher body.
 * Used by packages/cli install and scripts/install-local-mcp-runtime.mjs.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS = 5_000;
export const MANAGED_LAUNCHER_SCOPE_HEX_LENGTH = 24;
export const MANAGED_LAUNCHER_TITLE_TOKEN_HEX_LENGTH = 48;
const EOF_SHUTDOWN_GRACE_MS = 1_500;
const COMMAND_PREFIX = "const command = ";
const ARGS_PREFIX = "const baseArgs = ";
const MANAGED_ENV_PREFIX = "const managedEnv = ";
const COHORT_TOKEN_PREFIX = "const managedCohortToken = ";

function parseJsonAssignment(content, prefix, malformedMessage) {
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (line === undefined || !line.endsWith(";")) {
    throw new Error(malformedMessage);
  }
  try {
    return JSON.parse(line.slice(prefix.length, -1));
  } catch {
    throw new Error(malformedMessage);
  }
}

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
  const parsed = parseJsonAssignment(
    content,
    MANAGED_ENV_PREFIX,
    "Managed launcher runtime environment is malformed.",
  );
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
 * Read the exact runtime command and managed environment from an
 * installer-generated launcher.
 *
 * @param {string} content
 * @returns {{ command: string, args: readonly string[], managedEnv: Readonly<Record<string, string>> }}
 */
export function parseManagedLauncherCohortToken(content) {
  const token = parseJsonAssignment(
    content,
    COHORT_TOKEN_PREFIX,
    "Managed launcher cohort identity is malformed.",
  );
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Managed launcher cohort identity is malformed.");
  }
  return token;
}

export function parseManagedLauncherDescriptor(content) {
  const command = parseJsonAssignment(content, COMMAND_PREFIX, "Managed launcher command is malformed.");
  const args = parseJsonAssignment(content, ARGS_PREFIX, "Managed launcher arguments are malformed.");
  if (typeof command !== "string" || !Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("Managed launcher command is malformed.");
  }
  return Object.freeze({
    command,
    args: Object.freeze([...args]),
    managedEnv: parseManagedLauncherEnvironment(content),
  });
}

/**
 * @param {{ command: string, args: readonly string[], managedEnv?: Readonly<Record<string, string>>, managedRuntimeRoot?: string, managedLauncherPath?: string, shutdownGraceMs?: number }} options
 * @returns {string}
 */
function runtimeEntryGenerationIdentity(args) {
  if (args.length !== 1 || typeof args[0] !== "string") return null;
  try {
    const stat = fs.statSync(args[0], { bigint: true });
    if (!stat.isFile()) return null;
    return {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    };
  } catch {
    return null;
  }
}

export function buildLauncherScript(options) {
  const command = options.command;
  const args = options.args;
  const managedEnv = options.managedEnv ?? {};
  const managedRuntimeRoot = options.managedRuntimeRoot ?? null;
  const managedLauncherPath = options.managedLauncherPath
    ?? (managedRuntimeRoot
      ? path.join(path.dirname(path.dirname(managedRuntimeRoot)), "bin", "satori-mcp.js")
      : null);
  const runtimeEntryGeneration = runtimeEntryGenerationIdentity(args);
  const cohortDigest = crypto.createHash("sha256")
    .update(JSON.stringify({
      command,
      args,
      managedEnv,
      managedRuntimeRoot,
      runtimeEntryGeneration,
    }))
    .digest("hex");
  const managedLauncherScope = managedLauncherPath
    ? crypto.createHash("sha256")
      .update(path.resolve(managedLauncherPath))
      .digest("hex")
      .slice(0, MANAGED_LAUNCHER_SCOPE_HEX_LENGTH)
    : null;
  const managedCohortToken = managedLauncherScope
    ? `${managedLauncherScope}${cohortDigest.slice(MANAGED_LAUNCHER_SCOPE_HEX_LENGTH)}`
    : cohortDigest;
  const shutdownGraceMs = Number.isFinite(options.shutdownGraceMs) && options.shutdownGraceMs >= 0
    ? Math.floor(options.shutdownGraceMs)
    : DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS;

  return [
    "#!/usr/bin/env node",
    "",
    'const crypto = require("node:crypto");',
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const path = require("node:path");',
    'const { pathToFileURL } = require("node:url");',
    "",
    `const command = ${JSON.stringify(command)};`,
    `const baseArgs = ${JSON.stringify(args)};`,
    `const managedEnv = ${JSON.stringify(managedEnv)};`,
    `const managedRuntimeRoot = ${JSON.stringify(managedRuntimeRoot)};`,
    `const managedLauncherPath = ${JSON.stringify(managedLauncherPath)};`,
    `const managedCohortToken = ${JSON.stringify(managedCohortToken)};`,
    `const shutdownGraceMs = ${JSON.stringify(shutdownGraceMs)};`,
    "const effectiveEnv = { ...process.env, ...managedEnv };",
    "const runtimeEntry = baseArgs[0];",
    'const identityModule = typeof runtimeEntry === "string"',
    '  ? path.join(path.dirname(runtimeEntry), "server", "shared-runtime-identity.js")',
    "  : null;",
    "",
    "let runtimeLeasePath = null;",
    "try {",
    "  assertCurrentManagedCohort();",
    "  if (managedLauncherPath) {",
    `    process.title = "satori-mcp:" + managedCohortToken.slice(0, ${MANAGED_LAUNCHER_TITLE_TOKEN_HEX_LENGTH});`,
    "  }",
    "  runtimeLeasePath = acquireManagedRuntimeLease();",
    "} catch (error) {",
    '  console.error(`Failed to acquire managed runtime lease: ${error instanceof Error ? error.message : String(error)}`);',
    "  process.exit(1);",
    "}",
    'process.once("exit", releaseManagedRuntimeLease);',
    "",
    'if (effectiveEnv.SATORI_RUNTIME_PROFILE !== "offline") {',
    "  startDirectRuntime();",
    "} else {",
    "if (!identityModule) {",
    '  console.error("Managed Satori launcher has an unsupported runtime command.");',
    "  process.exit(1);",
    "}",
    "",
    "import(pathToFileURL(identityModule).href).then(({ isSharedOfflineRuntimeEligible }) => {",
    "if (isSharedOfflineRuntimeEligible(effectiveEnv)) {",
    "  if (process.argv.length > 2) {",
    '    console.error("The managed shared Satori launcher does not accept runtime arguments.");',
    "    process.exit(1);",
    "  }",
    "  if (command !== process.execPath || baseArgs.length !== 1 || typeof runtimeEntry !== \"string\") {",
    '    console.error("Managed shared Satori launcher has an unsupported runtime command.");',
    "    process.exit(1);",
    "  }",
    '  const clientModule = path.join(path.dirname(runtimeEntry), "server", "shared-runtime-client.js");',
    "  import(pathToFileURL(clientModule).href)",
    "    .then(({ runSharedRuntimeClient }) => runSharedRuntimeClient({",
    "      runtimeEntry,",
    "      env: effectiveEnv,",
    "      stdin: process.stdin,",
    "      stdout: process.stdout,",
    "      stderr: process.stderr,",
    "    }))",
    "    .then(() => process.exit(0))",
    "    .catch((error) => {",
    '      console.error(`Failed to attach Satori shared runtime: ${error instanceof Error ? error.message : String(error)}`);',
    "      process.exit(1);",
    "    });",
    "} else {",
    "  startDirectRuntime();",
    "}",
    "}).catch((error) => {",
    '  console.error(`Failed to start Satori managed launcher: ${error instanceof Error ? error.message : String(error)}`);',
    "  process.exit(1);",
    "});",
    "}",
    "",
    "function startDirectRuntime() {",
    "const child = spawn(command, [...baseArgs, ...process.argv.slice(2)], {",
    '  stdio: ["pipe", "inherit", "inherit"],',
    "  env: effectiveEnv,",
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
    "    releaseManagedRuntimeLease();",
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
    "}",
    "",
    "function currentProcessIdentity() {",
    "  const identity = { pid: process.pid };",
    '  if (process.platform !== "linux") return identity;',
    "  try {",
    '    const raw = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");',
    '    const commandEnd = raw.lastIndexOf(")");',
    '    const fields = raw.slice(commandEnd + 2).trim().split(/\\s+/);',
    "    if (commandEnd >= 0 && fields[19]) identity.processStartTime = fields[19];",
    '    identity.bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();',
    "  } catch {",
    "    // PID liveness remains a conservative fallback outside Linux process identity support.",
    "  }",
    "  return identity;",
    "}",
    "",
    "function processIdentityIsLive(identity) {",
    "  try {",
    "    process.kill(identity.pid, 0);",
    "  } catch {",
    "    return false;",
    "  }",
    '  if (process.platform !== "linux" || !identity.processStartTime) return true;',
    "  try {",
    '    const raw = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");',
    '    const commandEnd = raw.lastIndexOf(")");',
    '    const fields = raw.slice(commandEnd + 2).trim().split(/\\s+/);',
    "    if (commandEnd < 0 || fields[19] !== identity.processStartTime) return false;",
    "    if (!identity.bootId) return true;",
    '    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === identity.bootId;',
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "function removeLockIfUnchanged(lockPath, expected) {",
    "  try {",
    "    const current = fs.lstatSync(lockPath);",
    "    if (current.dev === expected.dev && current.ino === expected.ino) {",
    "      fs.rmSync(lockPath, { force: true });",
    "    }",
    "  } catch (error) {",
    "    if (!error || error.code !== \"ENOENT\") throw error;",
    "  }",
    "}",
    "",
    "function acquireLeaseLock(storageRoot) {",
    "  const lockPath = path.join(storageRoot, \".leases.lock\");",
    "  const deadline = Date.now() + 2000;",
    "  while (Date.now() <= deadline) {",
    "    try {",
    "      const fd = fs.openSync(lockPath, \"wx\");",
    "      try {",
    "        fs.writeFileSync(fd, JSON.stringify({ formatVersion: 1, ...currentProcessIdentity() }));",
    "      } catch (error) {",
    "        try { removeLockIfUnchanged(lockPath, fs.fstatSync(fd)); } finally { fs.closeSync(fd); }",
    "        throw error;",
    "      }",
    "      return { fd, lockPath };",
    "    } catch (error) {",
    "      if (!error || error.code !== \"EEXIST\") throw error;",
    "      let existingFd;",
    "      try {",
    "        existingFd = fs.openSync(lockPath, \"r\");",
    "      } catch (error) {",
    "        if (error && error.code === \"ENOENT\") continue;",
    "        throw error;",
    "      }",
    "      try {",
    "        // Pin the observed inode until recovery has checked the current pathname.",
    "        const existingStat = fs.fstatSync(existingFd);",
    "        let owner = null;",
    "        try { owner = JSON.parse(fs.readFileSync(existingFd, \"utf8\")); } catch {}",
    "        const recoverable = owner && Number.isSafeInteger(owner.pid)",
    "          ? !processIdentityIsLive(owner)",
    "          : Date.now() - existingStat.mtimeMs >= 30000;",
    "        if (recoverable) {",
    "          removeLockIfUnchanged(lockPath, existingStat);",
    "          continue;",
    "        }",
    "      } finally {",
    "        fs.closeSync(existingFd);",
    "      }",
    "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);",
    "    }",
    "  }",
    "  throw new Error(\"Timed out waiting for managed runtime cleanup to finish.\");",
    "}",
    "",
    "function pruneDeadManagedRuntimeLeases(leasesRoot) {",
    "  let entries = [];",
    "  try { entries = fs.readdirSync(leasesRoot, { withFileTypes: true }); } catch { return; }",
    "  for (const entry of entries) {",
    '    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;',
    "    const leasePath = path.join(leasesRoot, entry.name);",
    '    let lease = null;',
    '    try { lease = JSON.parse(fs.readFileSync(leasePath, "utf8")); } catch {}',
    "    if (lease && Number.isSafeInteger(lease.pid) && lease.pid > 0) {",
    "      if (!processIdentityIsLive(lease)) {",
    "        try { fs.rmSync(leasePath, { force: true }); } catch {}",
    "      }",
    "      continue;",
    "    }",
    "    // Lease publication is atomic, so an old malformed final .json cannot be an in-flight write.",
    "    try {",
    "      if (Date.now() - fs.statSync(leasePath).mtimeMs >= 30000) {",
    "        fs.rmSync(leasePath, { force: true });",
    "      }",
    "    } catch {}",
    "  }",
    "}",
    "",
    "function assertCurrentManagedCohort() {",
    "  if (!managedLauncherPath || !fs.existsSync(managedLauncherPath)) return;",
    '  const activeContent = fs.readFileSync(managedLauncherPath, "utf8");',
    '  const activeTokenLine = activeContent.split(/\\r?\\n/).find((line) => line.startsWith("const managedCohortToken = "));',
    "  if (!activeTokenLine || !activeTokenLine.endsWith(\";\")) {",
    '    throw new Error("Active managed Satori launcher has no verifiable runtime cohort identity.");',
    "  }",
    "  let activeToken = null;",
    '  try { activeToken = JSON.parse(activeTokenLine.slice("const managedCohortToken = ".length, -1)); } catch {}',
    "  if (activeToken !== managedCohortToken) {",
    '    throw new Error("This Satori launcher belongs to a retired runtime cohort. Restart the MCP client so it uses the active launcher.");',
    "  }",
    "}",
    "",
    "function acquireManagedRuntimeLease() {",
    "  if (managedRuntimeRoot && !fs.existsSync(managedRuntimeRoot)) {",
    '    throw new Error(`Managed runtime no longer exists at ${managedRuntimeRoot}.`);',
    "  }",
    "  const storageRoot = managedRuntimeRoot",
    "    ? path.dirname(managedRuntimeRoot)",
    '    : managedLauncherPath ? path.join(path.dirname(path.dirname(managedLauncherPath)), "mcp-runtime") : null;',
    "  if (!storageRoot) return null;",
    "  fs.mkdirSync(storageRoot, { recursive: true });",
    "  const lock = acquireLeaseLock(storageRoot);",
    "  try {",
    "    assertCurrentManagedCohort();",
    "    if (!managedRuntimeRoot) return null;",
    '    const leasesRoot = path.join(storageRoot, ".leases");',
    "    fs.mkdirSync(leasesRoot, { recursive: true });",
    "    pruneDeadManagedRuntimeLeases(leasesRoot);",
    "    const leaseId = crypto.randomUUID();",
    '    const leasePath = path.join(leasesRoot, `${leaseId}.json`);',
    "    const identity = currentProcessIdentity();",
    "    const payload = {",
    "      formatVersion: 1,",
    "      leaseId,",
    "      ...identity,",
    "      runtimeRoot: managedRuntimeRoot,",
    "      acquiredAt: new Date().toISOString(),",
    "    };",
    '    const temporaryPath = `${leasePath}.${process.pid}.tmp`;',
    '    fs.writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });',
    "    fs.renameSync(temporaryPath, leasePath);",
    "    return leasePath;",
    "  } finally {",
    "    try { removeLockIfUnchanged(lock.lockPath, fs.fstatSync(lock.fd)); } finally { fs.closeSync(lock.fd); }",
    "  }",
    "}",
    "",
    "function releaseManagedRuntimeLease() {",
    "  if (!runtimeLeasePath) return;",
    "  const ownedLeasePath = runtimeLeasePath;",
    "  runtimeLeasePath = null;",
    "  try { fs.rmSync(ownedLeasePath, { force: true }); } catch {}",
    "}",
    "",
  ].join("\n");
}

export const MANAGED_SESSION_HOOK_FILE = "satori-hook.js";
export const MANAGED_SESSION_HOOK_MARKER = "satori-managed-session-hook";

/**
 * Static SessionStart hook shim written next to the managed launcher. It reads
 * the current runtime entry from the launcher's baseArgs line at run time, so
 * runtime upgrades need no hook rewrite. Fail-open: every error exits 0 silently.
 *
 * @returns {string}
 */
export function buildSessionHookShimScript() {
  return `#!/usr/bin/env node
// ${MANAGED_SESSION_HOOK_MARKER}: installed by satori-cli; edits are replaced on reinstall.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

try {
  const launcher = fs.readFileSync(path.join(__dirname, "satori-mcp.js"), "utf8");
  const line = launcher.split(/\\r?\\n/).find((candidate) => candidate.startsWith(${JSON.stringify(ARGS_PREFIX)}));
  const runtimeEntry = JSON.parse(line.slice(${ARGS_PREFIX.length}, -1))[0];
  const hookModule = path.join(path.dirname(runtimeEntry), "session-hook.js");
  import(pathToFileURL(hookModule).href)
    .then((hook) => hook.runSessionStartHook({ stdin: process.stdin, stdout: process.stdout, cwd: process.cwd() }))
    .catch(() => {})
    .finally(() => process.exit(0));
} catch {
  process.exit(0);
}
`;
}
