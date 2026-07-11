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

test("bridge manage_index schema includes repair", () => {
	assert.match(JSON.stringify(__testInternals.manageIndexSchema), /"const":"repair"/);
});

test("bridge npm fallback matches the current CLI package version", () => {
	assert.equal(__testInternals.defaultNpmPackage, "@zokizuan/satori-cli@0.4.15");
});

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

test("bridge no longer applies a manage_index create/reindex poll timeout floor", () => {
	// Kickoff responses return immediately; the special 180s floor was removed with the poll contract.
	assert.equal("resolveEffectiveCallTimeoutMs" in __testInternals, false);
	assert.equal(fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8").includes("MANAGE_INDEX_POLL"), false);
});

test("parseCliJson parses a strict JSON stdout blob", () => {
	const payload = { tools: [{ name: "search_codebase" }] };
	const parsed = __testInternals.parseCliJson(JSON.stringify(payload), "");
	assert.deepEqual(parsed, payload);
});

test("parseCliJson falls back to the last non-empty line when stdout has preface noise", () => {
	const payload = { content: [] };
	const stdout = [
		"[bridge-debug] spawned child",
		JSON.stringify(payload),
		"",
	].join("\n");

	const parsed = __testInternals.parseCliJson(stdout, "");
	assert.deepEqual(parsed, payload);
});

test("parseCliJson reports both parse failures when full stdout and fallback fail", () => {
	const stdout = ["{broken", "{also-broken"].join("\n");
	assert.throws(
		() => __testInternals.parseCliJson(stdout, "stderr payload"),
		/full_stdout=.*last_non_empty_line=.*stderr payload/s,
	);
});

test("normalizeContent truncates long plain text blocks", () => {
	const longText = new Array(2000).fill("plain text payload").join("\n");
	const normalized = __testInternals.normalizeContent([{ type: "text", text: longText }]);
	assert.equal(normalized.length, 1);
	assert.equal(normalized[0]?.type, "text");
	assert.equal((normalized[0] as { text: string }).text, __testInternals.truncateText(longText));
});

test("normalizeContent preserves long structured envelope JSON text blocks", () => {
	const envelopeText = JSON.stringify({
		status: "ok",
		warnings: [],
		hints: { status: { args: { action: "status" } } },
		payload: "x".repeat(200_000),
	});
	const normalized = __testInternals.normalizeContent([{ type: "text", text: envelopeText }]);
	assert.equal(normalized.length, 1);
	assert.equal(normalized[0]?.type, "text");
	assert.equal((normalized[0] as { text: string }).text, envelopeText);
	assert.equal(__testInternals.isStructuredEnvelopeText(envelopeText), true);
});
