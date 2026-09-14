#!/usr/bin/env node
// NOVA CLI — `nova run <file>.nova` / `nova build <file>.nova` (ADR-011)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runSource, compile } from "./nova.js";
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

// ADR-011 — `nova build`: compiles PAGE declarations only. The file's
// ordinary imperative statements (if any) are never executed by `build`,
// the same way `run` never touches PAGE content.
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

  const outputs = compileProgram(program);
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
