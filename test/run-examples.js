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

function runCli(file, stdinInput, command = "run") {
  const opts = { encoding: "utf8" };
  if (stdinInput !== undefined) opts.input = stdinInput;
  return spawnSync(process.execPath, [cli, command, file], opts);
}

console.log("== Valid examples (expect exit 0) ==");
const validFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".nova"));
for (const f of validFiles) {
  const full = path.join(examplesDir, f);
  // ADR-008 — a companion `<name>.stdin` file, if present, is piped in as
  // real stdin (not the in-process canned-input path test/v0.7-ask.test.js
  // exercises) — matching the original chat's own dual verification.
  const stdinPath = full.replace(/\.nova$/, ".stdin");
  let stdinInput;
  try {
    stdinInput = readFileSync(stdinPath, "utf8");
  } catch {
    stdinInput = undefined;
  }
  const result = runCli(full, stdinInput);
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
  let stdinInput;
  try {
    stdinInput = readFileSync(full.replace(/\.nova$/, ".stdin"), "utf8");
  } catch {
    stdinInput = undefined;
  }
  const result = runCli(full, stdinInput);
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

// ADR-011 — `nova run` never exercises the PAGE compiler at all (PAGE is
// inert there), so examples/website.nova is separately verified through
// `nova build`, checking the real files it writes to dist/ - the same
// "actual CLI output, not just in-process" standard as everything else.
console.log("\n== PAGE compiler (nova build, expect exit 0 + real output files) ==");
{
  const source = path.join(examplesDir, "website.nova");
  const distDir = path.join(examplesDir, "dist");
  const result = runCli(source, undefined, "build");
  const indexPath = path.join(distDir, "index.html");
  const aboutPath = path.join(distDir, "about.html");
  let indexHtml = "", aboutHtml = "";
  try {
    indexHtml = readFileSync(indexPath, "utf8");
    aboutHtml = readFileSync(aboutPath, "utf8");
  } catch {
    // leave blank; checked below
  }
  const ok =
    result.status === 0 &&
    indexHtml.includes("<title>NOVA</title>") &&
    indexHtml.includes("<h1>Welcome to NOVA</h1>") &&
    aboutHtml.includes("<title>About</title>");
  if (ok) {
    console.log(`  OK   website.nova -> dist/index.html, dist/about.html`);
    passed++;
  } else {
    console.log(`  FAIL website.nova build (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

function indent(s) {
  return (s ?? "").split("\n").map((l) => "    " + l).join("\n");
}

console.log(`\n${passed}/${passed + failed} examples behaved as expected.`);
process.exit(failed === 0 ? 0 : 1);
