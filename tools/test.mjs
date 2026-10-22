#!/usr/bin/env node
// Regression runner: runs unit tests of every workspace and compares failures
// with tools/test-baseline.json (failures already known before a change).
//
//   node tools/test.mjs                 full suite, fail only on NEW failures
//   node tools/test.mjs --changed       only tests affected by uncommitted changes
//   node tools/test.mjs --changed=main  only tests affected since a git ref
//   node tools/test.mjs --update-baseline   record current failures as known
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "tools", "test-baseline.json");
const args = process.argv.slice(2);
const update = args.includes("--update-baseline");
const changedArg = args.find((a) => a === "--changed" || a.startsWith("--changed="));
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const workspaces = ["engine", "server", "admin"].filter((w) => !only || only.split(",").includes(w));

const known = existsSync(baselinePath)
  ? new Set(JSON.parse(readFileSync(baselinePath, "utf8")).knownFailures)
  : new Set();
const outDir = join(tmpdir(), `sb-test-${process.pid}`);
mkdirSync(outDir, { recursive: true });

const failures = [];
let total = 0;
let passed = 0;
for (const workspace of workspaces) {
  const outputFile = join(outDir, `${workspace}.json`);
  const vitestArgs = ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${outputFile}`];
  if (workspace === "engine") vitestArgs.push("test");
  if (changedArg) vitestArgs.push("--changed", ...(changedArg.includes("=") ? [changedArg.split("=")[1]] : []), "--passWithNoTests");
  console.log(`\n=== ${workspace} ===`);
  const result = spawnSync("npx", vitestArgs, {
    cwd: join(root, "apps", workspace),
    stdio: "inherit",
    shell: true,
    // Node >=25 ships a global localStorage that shadows jsdom's.
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage`.trim() },
  });
  if (!existsSync(outputFile)) {
    failures.push(`${workspace} :: runner crashed (exit ${result.status})`);
    continue;
  }
  const report = JSON.parse(readFileSync(outputFile, "utf8"));
  for (const file of report.testResults) {
    const rel = file.name.split(String.fromCharCode(92)).join("/").split(`/apps/${workspace}/`)[1] ?? file.name;
    for (const t of file.assertionResults) {
      total += 1;
      if (t.status === "passed") passed += 1;
      else if (t.status === "failed") failures.push(`${workspace} :: ${rel} :: ${t.fullName}`);
    }
    if (file.status === "failed" && file.assertionResults.length === 0) failures.push(`${workspace} :: ${rel} :: <suite failed to load>`);
  }
}
rmSync(outDir, { recursive: true, force: true });

if (update) {
  writeFileSync(baselinePath, JSON.stringify({ knownFailures: [...failures].sort() }, null, 2) + "\n");
  console.log(`\nBaseline updated: ${failures.length} known failure(s).`);
  process.exit(0);
}
const fresh = failures.filter((f) => !known.has(f));
const fixed = [...known].filter((k) => !failures.includes(k) && !changedArg);
console.log(`\n${passed}/${total} tests passed; ${failures.length - fresh.length} known failure(s); ${fresh.length} NEW failure(s).`);
if (fixed.length) console.log(`Known failures now passing (run --update-baseline):\n  ${fixed.join("\n  ")}`);
if (fresh.length) {
  console.log(`\nNEW failures:\n  ${fresh.join("\n  ")}`);
  process.exit(1);
}
