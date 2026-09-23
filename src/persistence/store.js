// ADR-018 — durable persistence for `nova serve`. A NOVA runtime value is
// already a plain, cycle-free, JSON-safe `{ type, value }` object
// (interpreter/values.js), so the on-disk format is just the interpreter's
// own store shape (Map<typeName, { nextId, records: Map<id, value> }>),
// wrapped in a small versioned envelope - no new serialization concept.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";

const FORMAT_VERSION = 1;

// Interpreter's store Map -> a plain, JSON-safe object.
export function serializeStore(store) {
  const out = {};
  for (const [typeName, collection] of store) {
    out[typeName] = {
      nextId: collection.nextId,
      records: Object.fromEntries(collection.records),
    };
  }
  return { novaDataFormat: FORMAT_VERSION, store: out };
}

// The inverse of serializeStore - throws a plain Error (not a NovaError;
// this is a CLI/file-level problem, not a problem with a .nova program) if
// `envelope` isn't shaped the way serializeStore produces it.
export function deserializeStore(envelope) {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.novaDataFormat !== FORMAT_VERSION ||
    typeof envelope.store !== "object" ||
    envelope.store === null
  ) {
    throw new Error(
      `Unrecognized data file format (expected novaDataFormat: ${FORMAT_VERSION}).`
    );
  }
  const store = new Map();
  for (const [typeName, collection] of Object.entries(envelope.store)) {
    if (
      typeof collection !== "object" ||
      collection === null ||
      typeof collection.nextId !== "number" ||
      typeof collection.records !== "object" ||
      collection.records === null
    ) {
      throw new Error(`Data file is corrupt: malformed collection for "${typeName}".`);
    }
    const records = new Map();
    for (const [idStr, value] of Object.entries(collection.records)) {
      records.set(Number(idStr), value);
    }
    store.set(typeName, { nextId: collection.nextId, records });
  }
  return store;
}

// Reads and parses a durable data file. Returns null if it doesn't exist
// yet (a brand-new server, nothing to load) - throws if it exists but
// can't be read or parsed, so a corrupt file is never silently discarded.
export function loadStoreFile(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read data file "${path}": ${e.message}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Data file "${path}" is not valid JSON: ${e.message}`);
  }
  try {
    return deserializeStore(envelope);
  } catch (e) {
    throw new Error(`Data file "${path}": ${e.message}`);
  }
}

// Atomic write (temp file + rename) so a process killed mid-write can
// never leave a half-written, corrupt data file behind - the previous
// good version survives untouched either way.
export function saveStoreFile(path, store) {
  const json = JSON.stringify(serializeStore(store));
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, json, "utf8");
  renameSync(tmpPath, path);
}

// Test-only convenience - not used by the CLI (a durable file is meant to
// outlive its process), but real end-to-end tests need to clean up after
// themselves without leaving stray .data.json files in the repo.
export function deleteStoreFileIfExists(path) {
  if (existsSync(path)) unlinkSync(path);
}
