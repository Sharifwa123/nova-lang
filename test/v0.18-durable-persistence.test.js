// v0.18 (ADR-018) - durable persistence for `nova serve`. The real
// end-to-end payoff (data surviving an actual separate process restart) is
// covered by test/run-examples.js against the real spawned CLI; this file
// covers the persistence module's own correctness (round-tripping,
// malformed-file handling, atomic writes) and serve.js's `persist` wiring,
// both at the unit level.
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { test, assertEqual, assertTrue, assertThrows } from "./harness.js";
import { makeInt, makeText, makeBool, makeList, makeRecord } from "../src/interpreter/values.js";
import {
  serializeStore,
  deserializeStore,
  loadStoreFile,
  saveStoreFile,
  deleteStoreFileIfExists,
} from "../src/persistence/store.js";
import { compile } from "../src/nova.js";
import { Interpreter } from "../src/interpreter/interpreter.js";
import { collectApiRoutes, createRequestListener } from "../src/apiserver/serve.js";

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "nova-persistence-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sampleStore() {
  const store = new Map();
  store.set("Room", {
    nextId: 3,
    records: new Map([
      [1, makeRecord({ number: makeInt(101), tags: makeList([makeText("quiet"), makeText("corner")]), available: makeBool(true) })],
      [2, makeRecord({ number: makeInt(102), tags: makeList([]), available: makeBool(false) })],
    ]),
  });
  return store;
}

// ---- serialize/deserialize round-trip ----

test("v0.18: serializeStore/deserializeStore round-trips nested list/record values exactly", () => {
  const store = sampleStore();
  const envelope = serializeStore(store);
  const restored = deserializeStore(envelope);
  assertEqual(restored.get("Room").nextId, 3);
  assertEqual(restored.get("Room").records.get(1), store.get("Room").records.get(1));
  assertEqual(restored.get("Room").records.get(2), store.get("Room").records.get(2));
});

test("v0.18: serializeStore's envelope carries a novaDataFormat version", () => {
  const envelope = serializeStore(sampleStore());
  assertEqual(envelope.novaDataFormat, 1);
});

test("v0.18: deserializeStore rejects an envelope with the wrong/missing format version", () => {
  assertThrows(
    () => deserializeStore({ novaDataFormat: 999, store: {} }),
    (e) => assertTrue(e.message.includes("format"))
  );
  assertThrows(() => deserializeStore({}), (e) => assertTrue(e.message.includes("format")));
});

test("v0.18: deserializeStore rejects a malformed collection", () => {
  assertThrows(
    () => deserializeStore({ novaDataFormat: 1, store: { Room: { nextId: "not a number", records: {} } } }),
    (e) => assertTrue(e.message.includes("corrupt"))
  );
});

// ---- file I/O ----

test("v0.18: loadStoreFile returns null for a file that doesn't exist yet", () => {
  withTmpDir((dir) => {
    const result = loadStoreFile(path.join(dir, "nope.nova.data.json"));
    assertEqual(result, null);
  });
});

test("v0.18: saveStoreFile then loadStoreFile round-trips a real store through real disk", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "app.nova.data.json");
    const store = sampleStore();
    saveStoreFile(file, store);
    const loaded = loadStoreFile(file);
    assertEqual(loaded.get("Room").nextId, 3);
    assertEqual(loaded.get("Room").records.get(1), store.get("Room").records.get(1));
  });
});

test("v0.18: saveStoreFile writes atomically - no leftover .tmp file afterward", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "app.nova.data.json");
    saveStoreFile(file, sampleStore());
    assertTrue(existsSync(file));
    assertTrue(!existsSync(`${file}.tmp`));
  });
});

test("v0.18: loadStoreFile throws a clear error for a file that exists but isn't valid JSON", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "app.nova.data.json");
    writeFileSync(file, "{ not valid json", "utf8");
    assertThrows(
      () => loadStoreFile(file),
      (e) => assertTrue(e.message.includes(file) && e.message.toLowerCase().includes("json"))
    );
  });
});

test("v0.18: loadStoreFile throws a clear error for valid JSON in the wrong shape", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "app.nova.data.json");
    writeFileSync(file, JSON.stringify({ hello: "world" }), "utf8");
    assertThrows(() => loadStoreFile(file), (e) => assertTrue(e.message.includes(file)));
  });
});

test("v0.18: deleteStoreFileIfExists is a safe no-op when the file doesn't exist", () => {
  withTmpDir((dir) => {
    deleteStoreFileIfExists(path.join(dir, "nope.nova.data.json")); // must not throw
  });
});

test("v0.18: deleteStoreFileIfExists removes an existing file", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "app.nova.data.json");
    saveStoreFile(file, sampleStore());
    deleteStoreFileIfExists(file);
    assertTrue(!existsSync(file));
  });
});

// ---- serve.js's `persist` wiring ----

const COUNTER_SERVICE = `DATA Click
    n: integer
END

SERVICE
    API POST "/clicks"
        SET c = REQUEST AS Click
        SAVE c
        RETURN c
    END
END`;

function bootServer(source) {
  const program = compile(source, "<test>", {});
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  interpreter.run();
  const routes = collectApiRoutes(program);
  return { interpreter, routes };
}

test("v0.18: createRequestListener's persist callback fires once per request that reaches a handler", async () => {
  const { interpreter, routes } = bootServer(COUNTER_SERVICE);
  let persistCalls = 0;
  const server = http.createServer(createRequestListener(interpreter, routes, new Map(), () => persistCalls++));
  const { port } = await new Promise((resolve) => server.listen(0, () => resolve({ port: server.address().port })));
  try {
    await fetch(`http://localhost:${port}/clicks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    assertEqual(persistCalls, 1);

    // A 404 (never reaches a handler) must not trigger a write - nothing
    // could have mutated the store.
    await fetch(`http://localhost:${port}/nope`);
    assertEqual(persistCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("v0.18: persist still fires when a handler errors (partial mutations before the error stay applied and durable)", async () => {
  const { interpreter, routes } = bootServer(COUNTER_SERVICE);
  let persistCalls = 0;
  const server = http.createServer(createRequestListener(interpreter, routes, new Map(), () => persistCalls++));
  const { port } = await new Promise((resolve) => server.listen(0, () => resolve({ port: server.address().port })));
  try {
    // A body that doesn't match Click's shape is a real 400 (E-RUN-008/009,
    // ADR-015) - the handler errors before SAVE ever runs, but persist
    // should still fire (an earlier SAVE in the same handler, before a
    // later failure, must not go unpersisted just because the request as a
    // whole failed).
    const res = await fetch(`http://localhost:${port}/clicks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n: "not an integer" }),
    });
    assertEqual(res.status, 400);
    assertEqual(persistCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("v0.18: omitting persist entirely (every pre-v0.18 caller) still works, no crash", async () => {
  const { interpreter, routes } = bootServer(COUNTER_SERVICE);
  const server = http.createServer(createRequestListener(interpreter, routes));
  const { port } = await new Promise((resolve) => server.listen(0, () => resolve({ port: server.address().port })));
  try {
    const res = await fetch(`http://localhost:${port}/clicks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    assertEqual(res.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
