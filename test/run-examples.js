// Runs every example through the REAL CLI (a child process, exactly what a
// user would type), not the in-process pipeline test/interpreter.test.js
// exercises. This is the "actual nova run output" level of verification the
// original design discipline insisted on (see HANDOFF.md).
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const examplesDir = path.join(root, "examples");
const cli = path.join(root, "src", "cli.js");

let passed = 0;
let failed = 0;

function runCli(file) {
  return spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
}

console.log("== Valid examples (expect exit 0) ==");
const validFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".nova"));
for (const f of validFiles) {
  const full = path.join(examplesDir, f);
  const result = runCli(full);
  if (result.status === 0) {
    console.log(`  OK   ${f}`);
    passed++;
  } else {
    console.log(`  FAIL ${f} (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

console.log("\n== Error examples (expect the annotated diagnostic code) ==");
const errorsDir = path.join(examplesDir, "errors");
const errorFiles = readdirSync(errorsDir).filter((f) => f.endsWith(".nova"));
for (const f of errorFiles) {
  const full = path.join(errorsDir, f);
  const source = readFileSync(full, "utf8");
  const expectedMatch = source.match(/# expect:\s*(\S+)/);
  const expectedCode = expectedMatch ? expectedMatch[1] : null;
  const result = runCli(full);
  const gotCode = (result.stderr.match(/\[([A-Z0-9-]+)\]/) || [])[1];
  if (result.status === 1 && gotCode === expectedCode) {
    console.log(`  OK   ${f} -> ${gotCode}`);
    passed++;
  } else {
    console.log(`  FAIL ${f} (expected ${expectedCode}, got ${gotCode ?? "no diagnostic"}, exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

function indent(s) {
  return (s ?? "").split("\n").map((l) => "    " + l).join("\n");
}

console.log(`\n${passed}/${passed + failed} examples behaved as expected.`);
process.exit(failed === 0 ? 0 : 1);
