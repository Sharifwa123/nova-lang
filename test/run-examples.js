// Runs every example through the REAL CLI (a child process, exactly what a
// user would type), not the in-process pipeline test/interpreter.test.js
// exercises. This is the "actual nova run output" level of verification the
// original design discipline insisted on (see HANDOFF.md).
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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

// ADR-012 — data-bound PAGE: `nova build` must actually run the script
// (silently) to populate SAVE'd data before compiling FOR EACH...IN GET.
{
  const source = path.join(examplesDir, "data_bound_website.nova");
  const distDir = path.join(examplesDir, "dist");
  const result = runCli(source, undefined, "build");
  let html = "";
  try {
    html = readFileSync(path.join(distDir, "catalog.html"), "utf8");
  } catch {
    // leave blank; checked below
  }
  const ok =
    result.status === 0 &&
    result.stdout.trim() !== "" && // "Wrote ..." lines only - no SHOW output leaked through
    !result.stdout.includes("This only prints with") &&
    html.includes("<h1>Widget</h1>") &&
    html.includes("<p>9.99</p>") &&
    html.includes("<h1>Gizmo</h1>");
  if (ok) {
    console.log(`  OK   data_bound_website.nova -> dist/catalog.html (data-bound, build-time SAVE populated it)`);
    passed++;
  } else {
    console.log(`  FAIL data_bound_website.nova build (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

// ADR-013 — interactive PAGE: real CLI build, then EXECUTE the generated
// <script> against a DOM stub and call the button functions
// programmatically, exactly the original chat's own verification
// approach - a string match on the HTML cannot catch a codegen bug
// (wrong operator, render() never called); actually running it can.
{
  const source = path.join(examplesDir, "interactive_counter.nova");
  const distDir = path.join(examplesDir, "dist");
  const result = runCli(source, undefined, "build");
  let html = "";
  try {
    html = readFileSync(path.join(distDir, "counter.html"), "utf8");
  } catch {
    // leave blank; checked below
  }
  let chainOk = false;
  try {
    const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    for (const m of html.matchAll(/id="(nova-el-\d+)"/g)) {
      if (!elements.has(m[1])) {
        elements.set(m[1], {
          _text: "",
          set textContent(v) { this._text = v; },
          get textContent() { return this._text; },
        });
      }
    }
    const sandbox = { document: { getElementById: (id) => elements.get(id) } };
    vm.createContext(sandbox);
    vm.runInContext(scriptSrc, sandbox);
    const el = elements.get("nova-el-0");
    sandbox.novaClick_0(); // +1
    sandbox.novaClick_0(); // +1
    sandbox.novaClick_1(); // -1
    chainOk = sandbox.state.count === 1 && el.textContent === "1";
    sandbox.novaClick_2(); // Reset
    chainOk = chainOk && sandbox.state.count === 0 && el.textContent === "0";
  } catch {
    chainOk = false;
  }
  const ok = result.status === 0 && chainOk;
  if (ok) {
    console.log(`  OK   interactive_counter.nova -> dist/counter.html (generated JS executed, click chain verified)`);
    passed++;
  } else {
    console.log(`  FAIL interactive_counter.nova build/execute (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

function indent(s) {
  return (s ?? "").split("\n").map((l) => "    " + l).join("\n");
}

console.log(`\n${passed}/${passed + failed} examples behaved as expected.`);
process.exit(failed === 0 ? 0 : 1);
