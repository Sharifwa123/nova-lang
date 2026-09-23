# ADR-018: Durable persistence for `nova serve`

## Problem

`SAVE`/`GET`/`DELETE` (ADR-006) are in-memory only, explicitly deferred at
the time: "durable (file-backed) storage ... intentionally deferred to a
later milestone, not an oversight." For a one-shot `nova run`/`nova build`
process that was never a real gap — the store never needed to outlive the
process. `nova serve` (ADR-014) changed that: it's a long-running process
now, and every record a visitor creates through a live `FORM`/`CALL API`
(ADR-017) currently vanishes the moment the server restarts — for updating
the code, a crash, a redeploy, anything. A real full-stack app can't lose
its data every time the process comes back up.

## Decision

### Scope: `nova serve` only, this milestone

DECISION: durability applies only to `nova serve`. `nova run` and `nova
build` remain in-memory-only and exit-and-done, unchanged — a one-shot
script re-running its own `SAVE`s each invocation is already its existing,
well-understood behavior, and extending durability there is a separate
question (does a plain script *want* its `SAVE`s to survive the next `nova
run`, or is that surprising?) that doesn't need answering to fix the actual
problem: a live server losing its data on restart.

### One JSON file per source file, next to it

DECISION: `nova serve path/to/app.nova [port]` reads and writes
`path/to/app.nova.data.json` — the full source path with `.data.json`
appended, never a name derived by stripping `.nova`, so two different
source files can never collide on the same data file by construction.
`.data.json` files are generated, not source, so `.gitignore` gains
`*.nova.data.json`, the same treatment `dist/` already gets (ADR-011).

Rejected: a config-file or CLI-flag-specified path. Nothing about this
project has needed a config file yet, and the derived path is
unambiguous and discoverable — revisit only if real use ever asks for it.

Rejected: SQLite or another embedded database. This project's own
"zero npm dependencies" discipline rules out anything not in Node's
standard library outright, and `node:sqlite` is newer than this repo's
`engines.node` floor (`>=18`) — a plain JSON file, using the exact same
`{ type, value }` tagged shape (`src/interpreter/values.js`) the
interpreter already works in, needs no new dependency and no new
serialization concept at all (see below).

### The store already IS the file format — no new serialization scheme

DECISION: a NOVA runtime value is already a plain, cycle-free, JSON-safe
`{ type, value }` object (`values.js`) — `value` is a primitive, an array
of values (`list`), or a plain object of values (`record`), recursively.
`JSON.stringify`/`JSON.parse` round-trip it exactly as-is. So the on-disk
format is just the store's own shape, wrapped in a small versioned
envelope:

```json
{
  "novaDataFormat": 1,
  "store": {
    "Room": {
      "nextId": 3,
      "records": {
        "1": { "type": "record", "value": { "number": { "type": "integer", "value": 101 }, "available": { "type": "boolean", "value": true } } }
      }
    }
  }
}
```

Rejected: reconstructing values from each `DATA` type's declared field
shape (as `REQUEST AS <DataType>` does) instead of storing the type tags.
That only works for flat, scalar-only shapes (`REQUEST_SCALAR_TYPES`) —
`SAVE` itself has no such restriction (a `DATA` field can be a `list` of
mixed-type elements, ADR-003/005), so reconstruction-from-schema can't
round-trip everything `SAVE` actually accepts. Storing the tagged value
directly sidesteps the question entirely: zero new serialization code,
and it can never fall behind what the interpreter itself can hold.

`novaDataFormat` is forward-compatibility bookkeeping bought for free —
consistent with this project's diagnostic-code stability discipline
(codes.js), a future format change has a version number to branch on
instead of guessing from shape.

### No new grammar, no new keyword, no new diagnostic

DECISION: this milestone adds no NOVA-language surface at all — no new
keyword, no new AST node, no new diagnostic code. It is a `nova serve`
CLI/runtime concern only: load the file into `interpreter.store` before
the boot run, write it back out after every request that could have
mutated it. A malformed or unreadable existing data file is a CLI-level
error (`console.error` + `process.exit(2)`), the same treatment an
unreadable source file already gets (`readSourceOrExit`) — not a NOVA
diagnostic, since it isn't a problem with the `.nova` program at all.

### Re-seeding on restart is the program's problem to guard, not the
### interpreter's problem to solve

This is the one genuinely tricky design question here. `nova serve`'s
boot run has always executed the file's top-level statements in full,
including any `SAVE`s a demo/seed program has at the top level (ADR-014).
If the durable file is loaded first and the boot run still executes
unconditionally, a restart re-runs those top-level `SAVE`s on top of
already-persisted data — duplicate seed rows, forever, one more batch per
restart.

REJECTED: teaching the interpreter a "only run top-level statements on
first-ever boot" mode. This needs a new, fuzzy concept (what counts as
"first boot" — no data file yet? an empty store?) that doesn't generalize
past the seed-data case, and it's exactly the kind of interpreter-level
special-casing this project avoids when the existing language can already
express the same thing.

DECISION: NOVA already has everything needed to express "seed only if
empty" as ordinary program logic — `IF`, `GET`, and `LENGTH` (ADR-007) —
so this is left entirely to the program, unchanged:

```nova
IF LENGTH(GET Room) == 0
    SAVE { number: 101, available: TRUE }
    SAVE { number: 102, available: TRUE }
END
```

A demo file that doesn't guard its seed data will keep re-seeding on every
restart, exactly as it does today with no data file at all — that's a
pre-existing property of writing unconditional top-level `SAVE`s, not a
new footgun this milestone introduces. `examples/api_service.nova` and
`examples/booking_page.nova` are both updated to guard their seed data
this way, since they're now genuinely restart-durable for the first time.

### Write-through timing: after the boot run, and after every request

DECISION: the store is written to disk (a) once, right after the boot run
completes — so a fresh `.data.json` exists (with `nextId` correctly
captured) even before the first request arrives — and (b) once after
every request that reaches a declared API handler, whether it succeeds or
is caught as a NovaError (ADR-014's existing "one bad request doesn't
take the server down" handling; either way, whatever `SAVE`/`DELETE`
calls already ran before the error stay applied, exactly as they do
in-memory today — persisting just makes that pre-existing behavior
durable too). Requests that never reach a handler (404, or an ADR-016
`PAGE` fallback) never touch the store, so they never trigger a write.

Rejected: debouncing or batching writes. `nova serve`'s own request
handling is already fully synchronous per request (ADR-014 — no `await`
inside `execStatements`), and this project's target is a small demo/dev
server, not a high-throughput production one; a synchronous
write-after-every-mutating-request keeps the "what you'd `GET` right now
is exactly what's on disk right now" guarantee simple and easy to reason
about. Performance work here is explicitly future work if real use ever
asks for it.

Rejected: an in-process write queue or lock for concurrent `nova serve`
processes pointed at the same file. Out of scope, matching the rest of
this project's single-process assumption — no new problem, `SAVE`/`GET`
were never safe across processes to begin with.

DECISION: writes are atomic (write to `<path>.tmp`, then rename over the
real path) so a process killed mid-write can never leave a half-written,
corrupt JSON file behind — the previous good version survives untouched
either way. This is the one piece of real engineering care this milestone
needs, since "durable" that can corrupt itself on a crash isn't actually
durable.

## Consequences

- New module `src/persistence/store.js`: `serializeStore`/
  `deserializeStore` (the store Map ⇄ the JSON envelope above),
  `loadStoreFile(path)` (returns `null` if the file doesn't exist, throws
  a plain `Error` with a clear message if it exists but is malformed —
  never silently discards an unreadable file), `saveStoreFile(path,
  store)` (atomic write via temp file + rename).
- `src/cli.js`'s `serveCommand`: derives the `.data.json` path, loads it
  into `interpreter.store` before `interpreter.run()`, writes it back
  right after, and exits with a clear CLI-level error (matching
  `readSourceOrExit`) if the existing file can't be loaded.
- `src/apiserver/serve.js`: `startServer`/`createRequestListener` take an
  optional `persist` callback, invoked after every request that reached a
  handler (success or caught `NovaError`) — `null`/omitted for every
  existing test and any future caller that doesn't want durability (e.g.
  the in-process test harness, which still runs an ephemeral, in-memory-
  only server, deliberately unchanged).
- `.gitignore` gains `*.nova.data.json`.
- `examples/api_service.nova` and `examples/booking_page.nova` gain an
  `IF LENGTH(GET ...) == 0` guard around their seed `SAVE`s, since restart
  durability makes unconditional re-seeding an observable problem for the
  first time.
- `nova run`/`nova build` are completely unchanged — still in-memory-only,
  by design (see Scope above).
- Still deferred, unchanged from ADR-006: `GET ... WHERE` filtering, and
  now also: durability for `nova run`/`nova build`, concurrent-writer
  safety, and any format migration story past `novaDataFormat: 1`.
