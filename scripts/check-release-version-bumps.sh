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
    echo "No suitable base commit found; skipping release version-bump guard."
    exit 0
  fi
fi

CHANGED_FILES="$(git diff --name-only "${BASE_SHA}" HEAD)"
if [[ -z "${CHANGED_FILES}" ]]; then
  echo "No changed files detected for release version-bump guard."
  exit 0
fi

declare -A PACKAGE_DIRS=(
  [core]="packages/core"
  [mcp]="packages/mcp"
  [cli]="packages/cli"
)

declare -A PACKAGE_RELEVANT_FILES
for key in core mcp cli; do
  directory="${PACKAGE_DIRS[${key}]}"
  relevant="$(printf '%s\n' "${CHANGED_FILES}" \
    | grep -E "^${directory}/(src/|scripts/|assets/|README\.md$|LICENSE$|package\.json$|tsconfig(\..*)?\.json$)" \
    || true)"
  if [[ -n "${relevant}" ]]; then
    PACKAGE_RELEVANT_FILES[${key}]="${relevant}"
  fi
done

if [[ ${#PACKAGE_RELEVANT_FILES[@]} -eq 0 ]]; then
  echo "No package artifact-relevant changes detected; release version bump not required."
  exit 0
fi

declare -A REQUIRED_KEYS
if [[ -n "${PACKAGE_RELEVANT_FILES[core]:-}" ]]; then
  REQUIRED_KEYS[core]=1
  REQUIRED_KEYS[mcp]=1
  REQUIRED_KEYS[cli]=1
fi
if [[ -n "${PACKAGE_RELEVANT_FILES[mcp]:-}" ]]; then
  REQUIRED_KEYS[mcp]=1
  REQUIRED_KEYS[cli]=1
fi
if [[ -n "${PACKAGE_RELEVANT_FILES[cli]:-}" ]]; then
  REQUIRED_KEYS[cli]=1
fi

failed=0
for key in core mcp cli; do
  [[ -n "${REQUIRED_KEYS[${key}]:-}" ]] || continue
  package_path="${PACKAGE_DIRS[${key}]}/package.json"
  if ! git cat-file -e "${BASE_SHA}:${package_path}" 2>/dev/null; then
    echo "Base commit does not contain ${package_path}; skipping ${key} version check."
    continue
  fi

  base_version="$(git show "${BASE_SHA}:${package_path}" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => process.stdout.write(String(JSON.parse(raw).version || "")));
')"
  head_version="$(node -e '
const fs = require("fs");
process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version || ""));
' "${package_path}")"

  if [[ "${base_version}" == "${head_version}" ]]; then
    echo "${key} package-relevant changes detected but its release version was not bumped."
    echo "Base version: ${base_version}"
    echo "Head version: ${head_version}"
    echo "Changed files requiring the release closure:"
    for changed_key in core mcp cli; do
      [[ -n "${PACKAGE_RELEVANT_FILES[${changed_key}]:-}" ]] || continue
      printf ' - %s:\n%s\n' "${changed_key}" "${PACKAGE_RELEVANT_FILES[${changed_key}]}"
    done
    failed=1
  fi
done

if [[ ${failed} -ne 0 ]]; then
  echo "Run: pnpm release:bump -- <core|mcp|cli> <major|minor|patch> --apply"
  exit 1
fi

echo "Release version-bump guard passed."
