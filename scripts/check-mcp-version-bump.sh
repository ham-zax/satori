#!/usr/bin/env bash
set -euo pipefail

BASE_SHA=""
ZERO_SHA="0000000000000000000000000000000000000000"

if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && -n "${GITHUB_BASE_REF:-}" ]]; then
  git fetch --no-tags --depth=200 origin "${GITHUB_BASE_REF}" >/dev/null 2>&1 || true
  if git rev-parse --verify "origin/${GITHUB_BASE_REF}" >/dev/null 2>&1; then
    BASE_SHA="$(git merge-base HEAD "origin/${GITHUB_BASE_REF}")"
  fi
fi

if [[ -z "${BASE_SHA}" && -n "${GITHUB_EVENT_BEFORE:-}" && "${GITHUB_EVENT_BEFORE}" != "${ZERO_SHA}" ]]; then
  BASE_SHA="${GITHUB_EVENT_BEFORE}"
fi

if [[ -z "${BASE_SHA}" ]]; then
  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE_SHA="$(git rev-parse HEAD~1)"
  else
    echo "No suitable base commit found; skipping MCP version-bump guard."
    exit 0
  fi
fi

CHANGED_FILES="$(git diff --name-only "${BASE_SHA}" HEAD)"
if [[ -z "${CHANGED_FILES}" ]]; then
  echo "No changed files detected for MCP version-bump guard."
  exit 0
fi

RELEVANT_FILES="$(printf '%s\n' "${CHANGED_FILES}" \
  | grep -E '^packages/mcp/(src/.*\.(ts|tsx|js|jsx)|scripts/.*|package\.json|tsconfig(\..*)?\.json)$' \
  | grep -Ev '^packages/mcp/src/.*\.(test|spec)\.(ts|tsx|js|jsx)$' || true)"

if [[ -z "${RELEVANT_FILES}" ]]; then
  echo "No MCP package-relevant source changes detected; version bump not required."
  exit 0
fi

if ! git cat-file -e "${BASE_SHA}:packages/mcp/package.json" 2>/dev/null; then
  echo "Base commit does not contain packages/mcp/package.json; skipping MCP version-bump guard."
  exit 0
fi

BASE_VERSION="$(git show "${BASE_SHA}:packages/mcp/package.json" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  process.stdout.write(String(parsed.version || ""));
});
')"

HEAD_VERSION="$(node -e '
const fs = require("fs");
const parsed = JSON.parse(fs.readFileSync("packages/mcp/package.json", "utf8"));
process.stdout.write(String(parsed.version || ""));
')"

if [[ "${BASE_VERSION}" == "${HEAD_VERSION}" ]]; then
  echo "MCP package-relevant changes detected but version was not bumped."
  echo "Base version: ${BASE_VERSION}"
  echo "Head version: ${HEAD_VERSION}"
  echo "Changed files requiring version bump:"
  printf ' - %s\n' ${RELEVANT_FILES}
  exit 1
fi

echo "MCP version bump guard passed (${BASE_VERSION} -> ${HEAD_VERSION})."
