#!/usr/bin/env node
/**
 * Run package typechecks without fail-fast so every workspace package reports
 * errors, then exit non-zero if any package failed.
 */
import { spawnSync } from "node:child_process";

const packages = [
  "@satori-code/core",
  "@satori-code/mcp",
  "@satori-code/cli",
];

let exitCode = 0;
const failed = [];
const isTTY = Boolean(process.stdout.isTTY && !process.env.CI);

console.log("\x1b[36m◆\x1b[0m Typechecking workspace packages...");

for (const name of packages) {
  const result = spawnSync("pnpm", ["--filter", name, "run", "typecheck"], {
    encoding: "utf8",
    shell: false,
  });
  const status = result.status ?? 1;
  if (status === 0) {
    console.log(`  \x1b[32m✔\x1b[0m \x1b[1m${name}\x1b[0m`);
  } else {
    exitCode = status;
    failed.push({ name, output: (result.stdout || "") + (result.stderr || "") });
    console.log(`  \x1b[31m✖\x1b[0m \x1b[1m${name}\x1b[0m`);
  }
}

if (failed.length > 0) {
  console.error(`\n\x1b[31m✖ Typecheck failed in ${failed.length} package(s):\x1b[0m\n`);
  for (const f of failed) {
    console.error(`\x1b[31m--- ${f.name} ---\x1b[0m\n${f.output.trim()}\n`);
  }
} else {
  console.log(`\x1b[32m✔ All ${packages.length} packages passed typecheck.\x1b[0m\n`);
}

process.exit(exitCode);
