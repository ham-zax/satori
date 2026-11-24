/**
 * Zero-dependency Oxlint JS plugin enforcing Satori's security and concurrency
 * architecture boundaries at lint time.
 *
 * Rules:
 * - `satori-guardrails/no-raw-git-exec`: route production Git calls through
 *   `packages/mcp/src/core/read-only-git.ts`.
 * - `satori-guardrails/no-shell-true`: forbid `shell: true` in production code.
 * - `satori-guardrails/no-json-stringify-shell-hook`: forbid `JSON.stringify`
 *   interpolation inside shell hook `command:` template literals.
 * - `satori-guardrails/no-raw-lock-unlink`: route lock-file deletion through
 *   `packages/core/src/utils/file-lock.ts` (or a designated CLI lock owner).
 */

function normalizeFilename(context) {
  const raw = typeof context.filename === "string"
    ? context.filename
    : typeof context.getFilename === "function"
      ? context.getFilename()
      : "";
  return raw.replace(/\\/g, "/");
}

function isTestFile(filename) {
  return /(?:^|\/)[^/]+\.test\.[cm]?[jt]sx?$/.test(filename)
    || filename.includes("/test-fixtures/")
    || filename.includes("/__fixtures__/");
}

function isDevScriptFile(filename) {
  return /(?:^|\/)(?:scripts|evals)\//.test(filename);
}

function isStaticString(node, expected) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "string") {
    return expected === undefined ? true : node.value === expected;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    const raw = node.quasis[0]?.value?.cooked;
    return expected === undefined ? typeof raw === "string" : raw === expected;
  }
  return false;
}

function getCalleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression"
    && !callee.computed
    && callee.property?.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

function isLockTargetExpression(node) {
  if (!node) return false;
  if (node.type === "Identifier") {
    return /lockPath|LockPath|lockFile|LockFile/.test(node.name);
  }
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    return /lockPath|LockPath|lockFile|LockFile/.test(node.property.name);
  }
  if (node.type === "CallExpression") {
    const name = getCalleeName(node.callee);
    return typeof name === "string" && /LockPath|lockPath/.test(name);
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value.endsWith(".lock");
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.some((q) => typeof q.value?.cooked === "string" && q.value.cooked.includes(".lock"));
  }
  return false;
}

const RAW_GIT_RUNNERS = new Set([
  "execFile",
  "execFileSync",
  "execFileAsync",
  "spawn",
  "spawnSync",
]);

const ALLOWED_LOCK_OWNERS = [
  "/packages/core/src/utils/file-lock.ts",
  "/packages/cli/src/managed-runtime-store.ts",
  "/packages/cli/src/managed-launcher-script.mjs",
  "/packages/cli/src/model-store.ts",
  "/packages/cli/src/local-diagnostics.ts",
];

function containsJsonStringifyCall(node) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "CallExpression"
    && node.callee?.type === "MemberExpression"
    && !node.callee.computed
    && node.callee.object?.type === "Identifier"
    && node.callee.object.name === "JSON"
    && node.callee.property?.type === "Identifier"
    && node.callee.property.name === "stringify"
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      if (value.some((item) => containsJsonStringifyCall(item))) return true;
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      if (containsJsonStringifyCall(value)) return true;
    }
  }
  return false;
}

const plugin = {
  meta: {
    name: "satori-guardrails",
  },
  rules: {
    "no-raw-git-exec": {
      meta: {
        type: "problem",
        docs: {
          description: "Require production Git subprocesses to use packages/mcp/src/core/read-only-git.ts.",
        },
        schema: [],
      },
      create(context) {
        const filename = normalizeFilename(context);
        if (
          isTestFile(filename)
          || isDevScriptFile(filename)
          || filename.endsWith("/packages/mcp/src/core/read-only-git.ts")
        ) {
          return {};
        }
        return {
          CallExpression(node) {
            const calleeName = getCalleeName(node.callee);
            if (!calleeName || !RAW_GIT_RUNNERS.has(calleeName)) return;
            if (isStaticString(node.arguments?.[0], "git")) {
              context.report({
                node,
                message:
                  "Do not invoke raw `git` directly in production code; route read-only Git queries through `packages/mcp/src/core/read-only-git.ts` so `--no-optional-locks` and `-c core.fsmonitor=false` are always enforced.",
              });
            }
          },
        };
      },
    },

    "no-shell-true": {
      meta: {
        type: "problem",
        docs: {
          description: "Forbid `shell: true` in production child_process options.",
        },
        schema: [],
      },
      create(context) {
        const filename = normalizeFilename(context);
        if (isTestFile(filename)) return {};
        return {
          Property(node) {
            const isShellKey =
              (!node.computed && node.key?.type === "Identifier" && node.key.name === "shell")
              || (node.key?.type === "Literal" && node.key.value === "shell");
            if (isShellKey && node.value?.type === "Literal" && node.value.value === true) {
              context.report({
                node,
                message:
                  "Do not pass `shell: true` in production code; pass an explicit executable and argument array to `execFile`/`spawn`.",
              });
            }
          },
        };
      },
    },

    "no-json-stringify-shell-hook": {
      meta: {
        type: "problem",
        docs: {
          description: "Forbid interpolating `JSON.stringify(...)` into shell hook `command:` template literals.",
        },
        schema: [],
      },
      create(context) {
        const filename = normalizeFilename(context);
        if (isTestFile(filename)) return {};
        return {
          Property(node) {
            const isCommandKey =
              (!node.computed && node.key?.type === "Identifier" && node.key.name === "command")
              || (node.key?.type === "Literal" && node.key.value === "command");
            if (
              isCommandKey
              && node.value?.type === "TemplateLiteral"
              && node.value.expressions.some((expr) => containsJsonStringifyCall(expr))
            ) {
              context.report({
                node,
                message:
                  "Do not use `JSON.stringify(...)` for POSIX shell command quoting; use `formatSessionHookCommand` (single-quote escaping) instead.",
              });
            }
          },
        };
      },
    },

    "no-raw-lock-unlink": {
      meta: {
        type: "problem",
        docs: {
          description: "Require lock-file deletion to go through inode-verified lock owners.",
        },
        schema: [],
      },
      create(context) {
        const filename = normalizeFilename(context);
        if (
          isTestFile(filename)
          || ALLOWED_LOCK_OWNERS.some((allowed) => filename.endsWith(allowed))
        ) {
          return {};
        }
        return {
          CallExpression(node) {
            const calleeName = getCalleeName(node.callee);
            if (calleeName !== "unlinkSync" && calleeName !== "rmSync") return;
            if (isLockTargetExpression(node.arguments?.[0])) {
              context.report({
                node,
                message:
                  "Do not unlink/remove lock files by path outside a lock owner; use `removeOwnedFileLockIfUnchanged` or `claimAndUnlinkStaleFileLock` from `@satori-code/core/integration`.",
              });
            }
          },
        };
      },
    },
  },
};

export default plugin;
