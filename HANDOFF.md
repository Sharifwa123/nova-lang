# HANDOFF — read this first

## Briefing for the next developer

Read this section first; the rest of the file is the detailed history and
rationale behind it.

**State**: v0.1 through v0.12 (the entire originally-planned roadmap) plus
v0.13/v0.14 — the first milestones past it: `SERVICE`/`API`, a real, live
HTTP server, with `GET` (v0.13) and `POST` + `REQUEST AS <DataType>`
(v0.14, reading/validating the real JSON request body) both implemented.
265 unit tests, 52 examples verified through the *real* CLI (not just
in-process calls), 15 ADRs, zero npm dependencies, MIT licensed. Verify it
yourself before doing anything else:
```bash
git clone https://github.com/Sharifwa123/nova-lang.git && cd nova-lang
node test/run.js && node test/run-examples.js
```
If that's not 265/265 and 52/52, something's wrong with *your*
environment, not the code — stop and figure out why before writing
anything new.

**The process discipline that got this here, non-negotiable:**
1. **ADR before code**, for any real design decision — not after. Look at
   `docs/adr/` for the pattern: problem, options considered, decision with
   *reasoning* (not just what), consequences.
2. **Smallest correct version per milestone.** Every ADR in this repo
   explicitly defers things — read the "DEFERRED" callouts before
   assuming a feature doesn't exist by accident. Don't bundle three
   milestones into one PR because they're adjacent.
3. **Verify through the real CLI, not just unit tests**, for anything with
   genuine I/O or generated output. ADR-013 is the clearest example: it
   doesn't assert the generated HTML contains a substring, it *executes*
   the generated JavaScript in a real JS context and calls the button
   functions programmatically. A passing unit test can still hide a bug a
   live run catches immediately — this codebase has already found two
   real bugs that way.
4. **Reuse existing mechanisms before inventing new syntax.** `CHANGE` for
   mutation was reused three separate times (variables, list elements,
   page-local state) instead of growing new keywords. `FOR EACH`/`GET`
   were reused for data-bound `PAGE` instead of a parallel loop construct.
   If you're about to add a new keyword, check whether an existing one
   already means what you need first.

**What's actually next**, per this file's own roadmap section below —
genuinely new ground (v0.13's `SERVICE`/`API` and v0.14's `POST`/`REQUEST
AS` were the first two pieces of this list; see ADR-014/ADR-015):
1. `PUT`/`DELETE` on `API` — v0.14 added `POST` (with `REQUEST AS
   <DataType>` validating the JSON body against a flat, primitive-only
   `DATA` shape); `PUT` implies "update this existing id" and `DELETE`
   needs no body at all, each a distinct enough question that ADR-015
   deliberately left them for later. Also still deferred: nested
   `DATA`/`list`/`record` fields in a `REQUEST AS` shape, and path
   parameters/query-string parsing in routing.
2. Connecting `PAGE` to the live server `SERVICE`/`API` now provides —
   today they're two independent pillars; data-bound `PAGE` (ADR-012) is
   still a build-time-only snapshot, on purpose (see ADR-014's Problem
   section for why the two weren't merged in one pass).
3. Security basics (`SECURITY`, still reserved).
4. Durable persistence (currently in-memory only).

**One specific warning**: the `PAGE` compiler (ADR-011/012/013) is the
most structurally novel part of this codebase — first compilation target
other than the interpreter, `nova run` vs `nova build` executing
genuinely different halves of the same file. Read those three ADRs before
touching it; the reasoning for *why* click handlers are restricted the
way they are (two separate checks — type correctness via ordinary
`infer()`, sandboxing via a dedicated structural walk — kept apart on
purpose) isn't obvious from the code alone.

## What this project is

NOVA is a programming language meant to eventually unify core logic, data
modeling, UI, and APIs into one language — see
[docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the binding spec (now
covering v0.1 through v0.14) and [docs/adr/](docs/adr/) for the fifteen
architectural decisions frozen so far.

## Project conventions worth knowing

This repository has no npm dependencies at all — see `package.json` and
`test/harness.js` (a zero-dependency test harness). That's a deliberate
choice, not an oversight: nothing needs installing to build, test, or run
this project, which removes any dependency on npm registry access being
available in whatever environment continues this work. If TypeScript is
wanted later (or at minimum a JSDoc + `tsc --checkJs` type-checking pass),
that's a reasonable improvement — the module boundaries (`lexer/`,
`parser/`, `ast/`, `analyzer/`, `interpreter/`, `diagnostics/`) were kept
small and dependency-light specifically to make that migration mechanical.

`editors/vscode/nova-lang/` is a small VS Code extension (syntax
highlighting + Run/Build/Serve commands) — pure tooling, not a language
change, so it doesn't get an ADR or a version bump. See its own README
for install instructions.

`package.json` is set up to publish this whole package to npm as
`nova-lang` (`"bin"` for the `nova` CLI, `"main"`/`"exports"` for using it
as a library via `import { runSource } from "nova-lang"`, a `"files"`
allowlist plus `.npmignore` to keep `examples/dist/` build artifacts out).
Verified end-to-end before ever publishing: packed with `npm pack`,
installed globally from that tarball, and both the CLI (`run`/`build`/
`serve`, including real HTTP requests against the resulting server) and
the library import worked from a completely separate directory. Actually
publishing (`npm publish`, once logged in) is a one-time step for whoever
holds the `nova-lang` npm name — not run as part of this repo's own
tests/CI.

## Current state (this repo)

- **v0.1 core, fully implemented and passing**: lexer, recursive-descent
  parser, semantic analyzer, tree-walking interpreter.
- **`CHANGE` (ADR-002) implemented as part of v0.1**, not deferred — it was
  adopted as core language surface before any later feature work began.
- **v0.2 (ADR-003) implemented**: real `[1, 2, 3]` list and `{ x: 1, y: 2 }`
  record literal syntax. `FOR EACH` and `.field` access no longer need any
  host-injected data — see `examples/catalog.nova` for the first fully
  self-contained list-of-records example in this repo.
- **v0.3 (ADR-004) implemented**: optional parameter/return type
  annotations on `DO`/`INPUT`/`RETURN` (`INPUT price: decimal`, `DO f
  RETURNS text`), fully backward compatible with untyped v0.1/v0.2
  procedures. Call-site argument checking, return-value checking, and a
  conservative "does every path return" check — see
  `examples/typed_procedures.nova`.
- **v0.4 (ADR-005) implemented**: `DATA Name / field: type / END` named
  types — zero new runtime concept, purely an analysis-time naming layer
  over v0.2's record type. Record literals used directly against a `DATA`
  type get exact field checking; `.field` access on a known `DATA`-typed
  value is checked statically and precisely typed instead of staying
  `'unknown'` — see `examples/data_types.nova`.
- **v0.5 (ADR-006) implemented**: in-memory persistence — `SAVE`/`GET`/
  `DELETE`, one collection per `DATA` type, integer ids — see
  `examples/persistence.nova`.
- **v0.6 (ADR-007) implemented**: a small standard library — `UPPER`,
  `LOWER`, `TRIM`, `LENGTH`, `ROUND`, `ABS` — called with exactly the same
  syntax as a user `DO` procedure, sharing its namespace (redefining one is
  a duplicate-procedure error, not silent shadowing). See
  `examples/stdlib.nova`.
- **v0.7 (ADR-008) implemented**: `ASK "prompt"` for real, synchronous,
  lazily-read stdin input (`SET name = ASK "Name? "`). A program that
  never calls `ASK` never touches stdin — see
  `src/interpreter/stdin.js`. Verified two ways: canned input queues in
  unit tests, and real piped stdin through the CLI (`test/run-examples.js`
  supports an optional `<example>.stdin` companion file; see
  `examples/ask.nova` + `examples/ask.stdin`).
- **v0.8 (ADR-009) implemented**: list indexing (`products[0]`) and
  mutation (`CHANGE products[0] = ...`, reusing `CHANGE` rather than a new
  keyword — see the ADR for why). Lists are now explicitly reference
  types: mutating through one alias is visible through another. See
  `examples/list_indexing.nova`.
- **v0.9 (ADR-010) implemented**: `TRY ... CATCH error ... END` for
  runtime-only error recovery (semantic/parse errors structurally can
  never reach a `TRY` block, per §13's fail-fast design). The caught
  `error` is the diagnostic's message, as `text`. See
  `examples/error_handling.nova`.
- **v0.10 (ADR-011) implemented**: `PAGE` compiles to static HTML via a
  new `nova build <file>.nova` command — `PAGE` is inert during `nova
  run`, and vice versa, so one file can hold a runnable script and page
  content side by side. Content must be a literal (no variables yet —
  that's next). This is NOVA's first compilation target other than the
  interpreter itself. Also fixed a real lexer gap found along the way: a
  `{` not shaped like real interpolation (e.g. raw CSS) now lexes as
  literal text instead of erroring, in any string, not just `PAGE`'s. See
  `examples/website.nova`.
- **v0.11 (ADR-012) implemented**: data-bound `PAGE` — `FOR EACH product
  IN GET Product ... END` inside a `PAGE`, rendered from real saved data.
  `nova build` now actually runs the file once (silently) to populate the
  store before compiling pages — a static-site-generator model, since no
  server exists to make "live" data honest yet. Field access
  (`product.name`) is checked against the real `DATA` shape. See
  `examples/data_bound_website.nova`.
- **v0.12 (ADR-013) implemented**: interactive `PAGE` — page-local state
  (`SET`/`CHANGE`, reused) and `BUTTON`/`WHEN CLICKED` compiled to real
  client-side JavaScript. Click handlers may only `CHANGE` page-local
  state with a literal/state/arithmetic expression — no calls, no
  `SAVE`/`GET`/`ASK` (`E-SEM-037`), checked by the analyzer, not just
  documented. **This completes every milestone in the v0.1–v0.12
  roadmap.** Verified by executing the generated `<script>` against a DOM
  stub and calling the button functions programmatically — a real onclick
  → state mutation → `render()` → DOM-text-update chain, not a string
  match. See `examples/interactive_counter.nova`.
- **v0.13 (ADR-014) implemented** — the first milestone past the
  v0.1–v0.12 roadmap. `SERVICE`/`API` compile to a real, live HTTP server:
  `nova serve <file>.nova [port]` runs the file once (silently, populating
  any `SAVE`'d data, exactly like `nova build`'s existing model) and then
  keeps that same interpreter — and its persistence store — alive across
  every subsequent request, so `SAVE`/`GET`/`DELETE` inside a handler are
  genuinely live (a `SAVE` in one request is visible to a `GET` in the
  next), unlike `PAGE`'s build-time-only snapshot, which this milestone
  leaves completely untouched. Only `GET` endpoints are supported so far;
  a handler body is ordinary, **unrestricted** server-side NOVA code
  (deliberately *not* sandboxed the way `WHEN CLICKED` is — see the ADR
  for why those are different problems), with one narrow exception: `ASK`
  is rejected directly inside a handler (`E-SEM-041`) since it would block
  the server on real stdin per request. Verified the same way ADR-013's
  own generated-JS check was: real end-to-end tests actually start the
  server (both in-process and as a real spawned `nova serve` child
  process) and issue real HTTP requests against it, asserting on the real
  JSON responses — not just on the parsed AST. See `examples/api_service.nova`.
  **Two bugs found in code review, fixed before the PR merged**: a
  `SERVICE` nested inside `IF`/`DO`/etc. compiled cleanly but silently
  registered no route at all (every request just 404'd, no compile-time
  signal why) — now rejected at compile time (`E-SEM-044`); and route
  matching didn't decode percent-encoding, so a route literal with
  non-ASCII/reserved characters could never actually be reached by a real
  client. See ADR-014's "Post-launch fixes" section.
- **v0.14 (ADR-015) implemented** — `API` now accepts `POST` alongside
  `GET`, and a new `REQUEST AS <DataType>` expression reads the POST
  request's real JSON body, validated against `<DataType>`'s declared
  fields (must be present, JS-type-matching, `integer`/`decimal`/`text`/
  `boolean` only — nested `DATA`/`list`/`record` fields are statically
  rejected, `E-SEM-043`). `REQUEST` is restricted to a `POST` handler's own
  body (`E-SEM-042`) — checked soundly, not just per-call, since procedure
  bodies are analyzed once at their own declaration. A malformed/
  mismatched body is a real `400` (`E-RUN-008`/`E-RUN-009`); every other
  runtime error inside a handler stays `500`, unchanged from ADR-014.
  Verified by actually POSTing real JSON to a real running server (both
  in-process and via the real spawned `nova serve` CLI) and checking the
  real response — including that a record created by one POST is visible
  to a later, separate GET request. See `examples/api_service.nova`.
- **265/265 unit tests passing** (`node test/run.js`) — lexer, parser,
  analyzer, interpreter, and diagnostic formatting.
- **52/52 examples verified through the real CLI** (`node
  test/run-examples.js`) — 19 valid programs that must run cleanly, 28
  invalid programs that must fail with the exact diagnostic code the spec
  promises, three dedicated `nova build` checks (static, data-bound, and
  interactive — the last one executing real generated JavaScript) that
  inspect real output files, and one dedicated `nova serve` check that
  spawns the real CLI as a live server and issues real HTTP requests
  (GET and POST both) against it. This is deliberately the "actual CLI
  output" level of verification, not just in-process test calls.
- Every diagnostic in SPECIFICATION.md §11's table is implemented and has
  at least one test or example exercising it.

Verify it yourself:
```bash
node test/run.js
node test/run-examples.js
node src/cli.js build examples/interactive_counter.nova && cat examples/dist/counter.html
node src/cli.js serve examples/api_service.nova 3000 &
sleep 1 && curl http://localhost:3000/products && kill %1
```

## Known, deliberate limitations (not bugs)

These are all named as DEFERRED in docs/SPECIFICATION.md, not oversights:

- List elements may be mixed types, and there's no way to type a list's
  element type ("a list of `Product`") — no typed-lists feature yet
  (ADR-003/ADR-005; `DATA` types can annotate `INPUT`/`RETURNS` but not a
  list's contents).
- List indexing/mutation exists (`a[0]`, `CHANGE a[0] = ...`) but no
  negative/from-the-end indexing, and no record field mutation
  (`CHANGE someRecord.field = x`) yet — indexing was scoped to lists only.
- No string concatenation operator (`+` is numeric-only); only
  `{identifier}`/`{identifier.field}` interpolation — still no arbitrary
  expressions, and notably still no `[index]` inside `{}` either.
- No named-constructor syntax for `DATA` types (`Product { ... }`) — a bare
  `{ ... }` record literal, checked against the expected type, is still the
  only construction syntax.
- Persistence is in-memory only (no file/durable backing yet) and has no
  `WHERE`-style filtering — `GET` always returns everything of a type.
- Stdlib is six procedures (ADR-007). `ASK` has no text-to-number parsing
  builtin yet (its result is always `text`).
- `TRY`/`CATCH` catches runtime errors only, gives `text`-only error
  detail (no code/kind to match on), and has no re-throw yet.
- `PAGE` has only four leaf elements (`TITLE`/`STYLE`/`HEADING`/`TEXT` —
  no heading levels, layout containers, links, images, or lists) and one
  data source (`FOR EACH...IN GET`, no `WHERE` filtering).
- `BUTTON` is top-level only (not inside `FOR EACH` — no per-record
  buttons yet, `E-SEM-038`); page-local state is scalar-only (no
  list/record state); no `TRY`/`CATCH` inside a click handler either
  (only `CHANGE` is allowed there at all).
- `API` supports only `GET` and `POST` (ADR-014/ADR-015) — no `PUT`/
  `DELETE` yet. Routing is exact-match only: no path parameters
  (`/products/:id`), no query-string parsing. The `ASK`-inside-a-handler
  check (`E-SEM-041`) is shallow by design: it only inspects a handler's
  own statements, not procedures it calls — a real, bounded,
  explicitly-named gap, not a soundness guarantee (the newer
  `REQUEST`-outside-`POST` check, `E-SEM-042`, is checked at each
  procedure's own declaration instead, so it doesn't share this gap).
  `PAGE`/`SERVICE` are still two independent pillars; data-bound `PAGE`
  (ADR-012) is still a build-time-only snapshot, deliberately not wired up
  to the live server ADR-014/015 add.
- `REQUEST AS <DataType>` (ADR-015) only supports flat, primitive-typed
  (`integer`/`decimal`/`text`/`boolean`) `DATA` shapes — a field typed as
  another `DATA` type, `list`, or `record` is a static error (`E-SEM-043`),
  not yet supported. Extra fields in a POST body are silently ignored, not
  validated against anything.
- `SECURITY` is still forward-reserved with no grammar at all.
- Numbers use JS's native `number` type, not true arbitrary precision
  (flagged as an explicit open question in SPECIFICATION.md §16).

## What's next

**Every milestone in the v0.1–v0.12 roadmap is implemented, plus
v0.13/v0.14 (`SERVICE`/`API`, ADR-014/ADR-015) — the first milestones past
that roadmap.** What's left is, like v0.13/v0.14 were, genuinely new
ground:

1. `PUT`/`DELETE` on `API` — v0.14 added `POST` + `REQUEST AS <DataType>`
   (validated against a flat, primitive-only `DATA` shape); `PUT` implies
   "update this existing id" and `DELETE` needs no body at all, each its
   own real design question ADR-015 deliberately left open. Also still
   open: nested `DATA`/`list`/`record` fields in a `REQUEST AS` shape, and
   path parameters/query-string parsing in routing.
2. Connecting `PAGE` to the live server `SERVICE`/`API` now provides, so
   data-bound `PAGE` (ADR-012) could stop being a build-time-only
   snapshot — today the two pillars are deliberately independent (see
   ADR-014's Problem section for why they weren't merged in one pass).
3. Security basics (`SECURITY`, still forward-reserved).
4. Durable (file-backed, not in-memory-only) persistence.
5. Mobile/desktop targets, native compilation/self-hosting — explicitly
   multi-month-plus territory.

The process discipline that held for 15 milestones and is worth
continuing for anything past this point: **ADR before implementation**
for any real design decision, smallest-correct-version per milestone
(resist doing three milestones' worth of surface in one pass), and
**verify through the real CLI** — not just unit tests — before calling a
milestone done, especially for anything with genuine I/O or generated-code
output (client-side JS, piped stdin) where a passing unit test can still
hide a real bug a live run would catch immediately. ADR-013's own
verification is the clearest example in this repo: it doesn't just assert
the generated HTML contains expected substrings, it actually executes the
generated `<script>` against a DOM stub and calls the button functions
programmatically.

## Files worth reading, in order

1. This file.
2. [docs/SPECIFICATION.md](docs/SPECIFICATION.md) — the binding spec.
3. The ADRs in [docs/adr/](docs/adr/), in order: block delimiters (001),
   the `CHANGE` keyword (002), list/record literals (003), typed
   procedures (004), `DATA` named types (005), persistence (006), the
   standard library (007), `ASK` input (008), list indexing/mutation
   (009), error handling (010), the static PAGE compiler (011),
   data-bound PAGE (012), interactive PAGE (013) — read the last three in
   particular before touching PAGE further — and the live SERVICE/API
   HTTP server (014) plus API POST/REQUEST AS (015), the first two
   milestones past the v0.1–v0.12 roadmap.
4. `src/nova.js` — the four-stage pipeline in ~20 lines; the best map of
   how the pieces fit together.
5. `examples/` and `examples/errors/` — read these before the source; they
   show the intended surface and error quality more concretely than prose.
