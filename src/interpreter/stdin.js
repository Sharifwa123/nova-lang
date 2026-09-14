// Zero-dependency synchronous line reader for ASK (ADR-008). Reads exactly
// one line from fd 0 on demand — never eagerly, so a program that never
// calls ASK never touches stdin at all (see the ADR for why that matters).
import { readSync } from "node:fs";

const ONE_BYTE = Buffer.alloc(1);

// Returns the next line (without a trailing \n/\r\n), or null at true EOF
// with nothing left to read.
export function readLineSync() {
  let line = "";
  let sawAnyByte = false;
  while (true) {
    let bytesRead;
    try {
      bytesRead = readSync(0, ONE_BYTE, 0, 1, null);
    } catch (e) {
      if (e.code === "EAGAIN") continue; // stdin not ready yet - retry
      if (e.code === "EOF") break;
      throw e;
    }
    if (bytesRead === 0) break; // EOF
    sawAnyByte = true;
    const ch = ONE_BYTE.toString("utf8");
    if (ch === "\n") break;
    line += ch;
  }
  if (!sawAnyByte) return null; // genuine EOF, nothing left at all
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
