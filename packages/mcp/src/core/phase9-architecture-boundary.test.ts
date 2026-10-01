import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

export interface BoundaryViolation {
    filePath: string;
    lineNumber: number;
    rule: string;
    match: string;
}

const EXEMPT_RELATIVE_PATHS = new Set([
    "packages/core/src/core/persisted-index-authority.ts",
    "packages/mcp/src/server/lateon-reranker-protocol.ts",
    "packages/mcp/src/core/search-rerank-request-contract.ts",
    "packages/cli/src/runtime-upgrade.ts",
    "packages/cli/src/runtime-selection.ts",
    "packages/cli/src/managed-runtime-closure.ts",
    "packages/cli/src/lateon-model-store.ts",
]);

export function isExemptBoundaryFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.endsWith(".test.ts")) {
        return true;
    }
    return Array.from(EXEMPT_RELATIVE_PATHS).some((exempt) => normalized.endsWith(exempt));
}

export function scanSourceContentForBoundaryViolations(
    filePath: string,
    content: string,
    isExempt: boolean,
): BoundaryViolation[] {
    if (isExempt) return [];

    const violations: BoundaryViolation[] = [];
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const lineNumber = index + 1;
        const trimmed = line.trim();

        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
            continue;
        }

        const forbiddenImportMatch = line.match(
            /(?:from\s+|import\s*\(|require\s*\()\s*["'].*?(search-rerank-contract-evidence|runtime-profile-v1|runtime-profile-v2|runtime-profile-v3|search-rerank-document-v[123]|search-rerank-query-v1).*?["']/,
        );
        if (forbiddenImportMatch) {
            violations.push({
                filePath,
                lineNumber,
                rule: "forbidden_retired_module_import",
                match: forbiddenImportMatch[0],
            });
        }

        const forbiddenPolicyBranch = line.match(/["']satori_index_policy_v[34]["']/);
        if (forbiddenPolicyBranch) {
            violations.push({
                filePath,
                lineNumber,
                rule: "forbidden_retired_policy_branch",
                match: forbiddenPolicyBranch[0],
            });
        }

        const forbiddenLateOnBranch = line.match(/["']satori_lateon_runtime_profile_v[123]["']/);
        if (forbiddenLateOnBranch) {
            violations.push({
                filePath,
                lineNumber,
                rule: "forbidden_retired_lateon_branch",
                match: forbiddenLateOnBranch[0],
            });
        }
    }

    return violations;
}

function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectSourceFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            files.push(fullPath);
        }
    }

    return files;
}

test("Phase 9 architecture boundary: production source tree has zero retired execution violations", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const coreSourceDir = path.join(repoRoot, "packages/core/src");
    const mcpSourceDir = path.join(repoRoot, "packages/mcp/src");
    const cliSourceDir = path.join(repoRoot, "packages/cli/src");

    const allSourceFiles = [
        ...collectSourceFiles(coreSourceDir),
        ...collectSourceFiles(mcpSourceDir),
        ...collectSourceFiles(cliSourceDir),
    ];

    const violations: BoundaryViolation[] = [];

    for (const filePath of allSourceFiles) {
        const isExempt = isExemptBoundaryFile(filePath);
        const content = fs.readFileSync(filePath, "utf8");
        violations.push(...scanSourceContentForBoundaryViolations(filePath, content, isExempt));
    }

    assert.deepEqual(violations, []);
});

test("Phase 9 architecture boundary: synthetic retired module import fails scanner", () => {
    const syntheticCode1 = `import { legacy } from "../core/search-rerank-contract-evidence.js";`;
    const violations1 = scanSourceContentForBoundaryViolations(
        "packages/mcp/src/core/search-request-coordinator.ts",
        syntheticCode1,
        false,
    );

    assert.equal(violations1.length, 1);
    assert.equal(violations1[0].rule, "forbidden_retired_module_import");

    const syntheticCode2 = `const retired = await import("./search-rerank-document-v3.js");`;
    const violations2 = scanSourceContentForBoundaryViolations(
        "packages/mcp/src/core/search-execution.ts",
        syntheticCode2,
        false,
    );

    assert.equal(violations2.length, 1);
    assert.equal(violations2[0].rule, "forbidden_retired_module_import");
});

test("Phase 9 architecture boundary: synthetic retired policy branch fails scanner", () => {
    const syntheticCode = `if (doc.schemaVersion === "satori_index_policy_v3") { return true; }`;
    const violations = scanSourceContentForBoundaryViolations(
        "packages/core/src/generation/index-generation-workflow.ts",
        syntheticCode,
        false,
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "forbidden_retired_policy_branch");
});

test("Phase 9 architecture boundary: synthetic retired LateOn profile branch fails scanner", () => {
    const syntheticCode = `if (profile.schemaVersion === "satori_lateon_runtime_profile_v1") { return true; }`;
    const violations = scanSourceContentForBoundaryViolations(
        "packages/mcp/src/server/lateon-reranker.ts",
        syntheticCode,
        false,
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "forbidden_retired_lateon_branch");
});

test("Phase 9 architecture boundary: current versioned identities are accepted without violations", () => {
    const currentCode = `
        import type { SearchGroupedResultV2 } from "./search-types.js";
        const docProjection = "search_rerank_document_v5";
        const queryProjection = "search_rerank_query_v2";
        const sourceSelection = "bounded_source_selection_v2";
        const indexPolicy = "satori_index_policy_v5";
        const lateonProfile = "satori_lateon_runtime_profile_v5";
        const manifestKind = "relationship_manifest_v2";
        const markerKind = "satori_index_completion_v3";
        const canonicalJson = "lexicographic_recursive_canonical_json_v1";
    `;

    const violations = scanSourceContentForBoundaryViolations(
        "packages/mcp/src/core/search-execution.ts",
        currentCode,
        false,
    );

    assert.deepEqual(violations, []);
});
