import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testInternals } from "./index.js";

const SATORI_CLI_ENV_KEYS = [
	"SATORI_CLI_CONFIG",
	"SATORI_CLI_COMMAND",
	"SATORI_CLI_ARGS_JSON",
	"SATORI_CLI_CWD",
	"SATORI_CLI_LOCAL_PATH",
	"SATORI_CLI_FORCE_NPX",
	"SATORI_CLI_NPM_PACKAGE",
	"SATORI_CLI_STARTUP_TIMEOUT_MS",
	"SATORI_CLI_CALL_TIMEOUT_MS",
	"SATORI_CLI_DEBUG",
	"SATORI_CLI_STDOUT_GUARD",
	"SATORI_CLI_GUARD_RECOVERY",
];

function withCleanSatoriEnv(run: () => void): void {
	const snapshot = new Map<string, string | undefined>();
	for (const key of SATORI_CLI_ENV_KEYS) {
		snapshot.set(key, process.env[key]);
		delete process.env[key];
	}
	try {
		run();
	} finally {
		for (const key of SATORI_CLI_ENV_KEYS) {
			const value = snapshot.get(key);
			if (typeof value === "string") {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}
	}
}

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveCliInvocationConfig prefers project-local config over global fallback", () => {
	withCleanSatoriEnv(() => {
		const root = mkdtemp("satori-bridge-local-first-");
		try {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			const localCwd = path.join(root, "local-cwd");
			const localConfigPath = path.join(cwd, ".pi", "satori-bridge.json");
			fs.writeFileSync(localConfigPath, JSON.stringify({
				cwd: localCwd,
				forceNpx: true,
			}), "utf8");

			const invocation = __testInternals.resolveCliInvocationConfig(cwd);
			assert.equal(invocation.cwd, localCwd);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("resolveCliInvocationConfig honors explicit SATORI_CLI_CONFIG override", () => {
	withCleanSatoriEnv(() => {
		const root = mkdtemp("satori-bridge-explicit-config-");
		try {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "satori-bridge.json"), JSON.stringify({
				cwd: path.join(root, "local-cwd"),
				forceNpx: true,
			}), "utf8");

			const explicitPath = path.join(root, "explicit.json");
			const explicitCwd = path.join(root, "explicit-cwd");
			fs.writeFileSync(explicitPath, JSON.stringify({
				cwd: explicitCwd,
				forceNpx: true,
			}), "utf8");
			process.env.SATORI_CLI_CONFIG = explicitPath;

			const invocation = __testInternals.resolveCliInvocationConfig(cwd);
			assert.equal(invocation.cwd, explicitCwd);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("resolveCliInvocationConfig does not throw when envFile is missing", () => {
	withCleanSatoriEnv(() => {
		const root = mkdtemp("satori-bridge-missing-envfile-");
		try {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(cwd, { recursive: true });
			const explicitPath = path.join(root, "explicit.json");
			fs.writeFileSync(explicitPath, JSON.stringify({
				envFile: "./does-not-exist.env",
				forceNpx: true,
			}), "utf8");
			process.env.SATORI_CLI_CONFIG = explicitPath;

			assert.doesNotThrow(() => __testInternals.resolveCliInvocationConfig(cwd));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("resolveEffectiveCallTimeoutMs enforces minimum for manage_index create/reindex", () => {
	const baseConfig = {
		command: "node",
		args: [],
		cwd: "/tmp",
		env: {},
		label: "test",
		startupTimeoutMs: 60_000,
		callTimeoutMs: 30_000,
		debug: false,
		guardMode: "drop" as const,
		guardRecovery: "auto" as const,
	};

	const createTimeout = __testInternals.resolveEffectiveCallTimeoutMs(baseConfig, {
		commandType: "tool-call",
		toolName: "manage_index",
		toolParams: { action: "create" },
		commandArgs: [],
	});
	const reindexTimeout = __testInternals.resolveEffectiveCallTimeoutMs(baseConfig, {
		commandType: "tool-call",
		toolName: "manage_index",
		toolParams: { action: "reindex" },
		commandArgs: [],
	});

	assert.equal(createTimeout, 180_000);
	assert.equal(reindexTimeout, 180_000);
});

test("resolveEffectiveCallTimeoutMs keeps configured timeout for non-long-running requests", () => {
	const baseConfig = {
		command: "node",
		args: [],
		cwd: "/tmp",
		env: {},
		label: "test",
		startupTimeoutMs: 60_000,
		callTimeoutMs: 45_000,
		debug: false,
		guardMode: "drop" as const,
		guardRecovery: "auto" as const,
	};

	const manageStatusTimeout = __testInternals.resolveEffectiveCallTimeoutMs(baseConfig, {
		commandType: "tool-call",
		toolName: "manage_index",
		toolParams: { action: "status" },
		commandArgs: [],
	});
	const searchTimeout = __testInternals.resolveEffectiveCallTimeoutMs(baseConfig, {
		commandType: "tool-call",
		toolName: "search_codebase",
		toolParams: { query: "x" },
		commandArgs: [],
	});

	assert.equal(manageStatusTimeout, 45_000);
	assert.equal(searchTimeout, 45_000);
});
