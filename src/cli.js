#!/usr/bin/env node
// NOVA CLI — `nova run <file>.nova`
import { readFileSync } from "node:fs";
import { runSource } from "./nova.js";
import { formatDiagnostic, NovaError } from "./diagnostics/diagnostic.js";

function usage() {
  console.error("Usage: nova run <file>.nova");
  process.exit(2);
}

function main() {
  const [, , command, filePath] = process.argv;
  if (command !== "run" || !filePath) usage();

  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (e) {
    console.error(`Cannot read ${filePath}: ${e.message}`);
    process.exit(2);
  }

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

main();
