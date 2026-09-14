#!/usr/bin/env node
// NOVA CLI — `nova run <file>.nova` / `nova build <file>.nova` (ADR-011)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runSource, compile } from "./nova.js";
import { Interpreter } from "./interpreter/interpreter.js";
import { compileProgram } from "./pagecompiler/compile.js";
import { formatDiagnostic, NovaError } from "./diagnostics/diagnostic.js";

function usage() {
  console.error("Usage: nova run <file>.nova");
  console.error("       nova build <file>.nova   (compiles PAGE declarations to dist/*.html)");
  process.exit(2);
}

function readSourceOrExit(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (e) {
    console.error(`Cannot read ${filePath}: ${e.message}`);
    process.exit(2);
  }
}

function runCommand(filePath) {
  const source = readSourceOrExit(filePath);
  try {
    runSource(source, filePath, {});
  } catch (e) {
    if (e instanceof NovaError) {
      console.error(formatDiagnostic(e.diagnostic, source, filePath));
      process.exit(1);
    }
    throw e;
  }
}

// ADR-011/ADR-012 — `nova build`: runs the file's ordinary statements once,
// silently (SHOW/ASK-prompt output suppressed - see the ADR for why this
// isn't a special case, just a quiet run), so any SAVE calls populate the
// store that data-bound PAGE content (FOR EACH...IN GET) reads from. Then
// compiles PAGE declarations against that store. This is a static-site-
// generator model: the HTML reflects data as of build time, nothing more.
function buildCommand(filePath) {
  const source = readSourceOrExit(filePath);
  let program;
  try {
    program = compile(source, filePath, {});
  } catch (e) {
    if (e instanceof NovaError) {
      console.error(formatDiagnostic(e.diagnostic, source, filePath));
      process.exit(1);
    }
    throw e;
  }

  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  try {
    interpreter.run();
  } catch (e) {
    if (e instanceof NovaError) {
      console.error(formatDiagnostic(e.diagnostic, source, filePath));
      process.exit(1);
    }
    throw e;
  }

  const outputs = compileProgram(program, interpreter.store);
  if (outputs.length === 0) {
    console.log("No PAGE declarations found - nothing to build.");
    return;
  }

  const distDir = path.join(path.dirname(filePath), "dist");
  for (const { path: relPath, html } of outputs) {
    const outPath = path.join(distDir, relPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
    console.log(`Wrote ${outPath}`);
  }
}

function main() {
  const [, , command, filePath] = process.argv;
  if (!filePath || (command !== "run" && command !== "build")) usage();

  if (command === "run") runCommand(filePath);
  else buildCommand(filePath);
}

main();
