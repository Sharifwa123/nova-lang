#!/usr/bin/env node
// NOVA CLI — `nova run <file>.nova` / `nova build <file>.nova` (ADR-011) /
// `nova serve <file>.nova [port]` (ADR-014)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runSource, compile } from "./nova.js";
import { Interpreter } from "./interpreter/interpreter.js";
import { compileProgram } from "./pagecompiler/compile.js";
import { startServer } from "./apiserver/serve.js";
import { formatDiagnostic, NovaError } from "./diagnostics/diagnostic.js";
import { loadStoreFile, saveStoreFile } from "./persistence/store.js";

function usage() {
  console.error("Usage: nova run <file>.nova");
  console.error("       nova build <file>.nova   (compiles PAGE declarations to dist/*.html)");
  console.error("       nova serve <file>.nova [port]   (starts a live HTTP server for SERVICE/API, default port 3000)");
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

// ADR-014 — `nova serve`: like buildCommand, compiles and runs the file's
// top-level statements once, silently, so SAVE calls populate the store -
// but then, instead of writing files and exiting, starts a real HTTP
// server and keeps this SAME interpreter (and its store) alive across
// every request, so SAVE/GET inside an API handler are genuinely live.
// ADR-018 — before that boot run, an existing `<filePath>.data.json` (a
// prior run's durable store) is loaded into the interpreter first, so the
// boot run's own top-level statements execute against already-persisted
// data, not an empty store; a program that seeds data unconditionally is
// expected to guard it (`IF LENGTH(GET X) == 0`), not the interpreter.
function serveCommand(filePath, portArg) {
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

  const dataFilePath = `${filePath}.data.json`;
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  try {
    const loadedStore = loadStoreFile(dataFilePath);
    if (loadedStore) interpreter.store = loadedStore;
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  try {
    interpreter.run();
  } catch (e) {
    if (e instanceof NovaError) {
      console.error(formatDiagnostic(e.diagnostic, source, filePath));
      process.exit(1);
    }
    throw e;
  }
  const persist = () => saveStoreFile(dataFilePath, interpreter.store);
  persist(); // ADR-018 — write immediately after the boot run, so a fresh
  // data file exists (with nextId captured) even before the first request.

  const port = portArg !== undefined ? Number(portArg) : 3000;
  startServer(interpreter, program, { port, persist });
}

function main() {
  const [, , command, filePath, extra] = process.argv;
  if (!filePath || !["run", "build", "serve"].includes(command)) usage();

  if (command === "run") runCommand(filePath);
  else if (command === "build") buildCommand(filePath);
  else serveCommand(filePath, extra);
}

main();
