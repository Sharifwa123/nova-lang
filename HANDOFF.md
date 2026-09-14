# HANDOFF — read this first

## What this project is

NOVA is a programming language meant to eventually unify core logic, data
modeling, UI, and APIs into one language — see
[docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the binding v0.1 spec and
[docs/adr/](docs/adr/) for the two architectural decisions frozen so far.

## How this repository came to exist (important context)

A separate Claude Code session (**not** this one) designed and built NOVA
through 13 iterations (v0.1 through v0.12: core language, lists/records,
typed procedures, `DATA` named types, persistence, a stdlib, interactive
input, error handling, list indexing, a static-HTML `PAGE` compiler,
data-bound UI, and finally client-side `BUTTON`/`WHEN clicked` interactivity
compiled to real JavaScript — 382 tests, 19 examples, all reportedly
passing) entirely inside that session's own temporary code-execution
sandbox on claude.ai.

**None of that source code survived.** The sandbox was never connected to
any persistent disk or repository the user could reach — it existed only
for the lifetime of that chat session. When the user asked how to hand it
to Claude Code, the honest answer that session gave was that there was no
mechanism to transfer the files out; only the chat's own text survived.

This repository is the result of a **second** Claude Code session (this
one) reading that shared chat transcript
(`https://claude.ai/share/858e0f98-dfc3-4025-ac58-8b8c26a92a90`) end to
end, extracting the parts that *did* survive as verbatim text — the full
v0.1 specification (§0–17) and two ADRs (block delimiters; the `CHANGE`
keyword) — and **re-implementing v0.1 from scratch** against that spec,
for real, on the user's actual machine. A partial raw transcript is kept at
[docs/reference/raw-chat-transcript-partial.txt](docs/reference/raw-chat-transcript-partial.txt)
for provenance and to mine for detail while rebuilding later versions.

One deliberate deviation from the original: that session used TypeScript
with a hand-rolled test harness because its sandbox had no npm registry
access. This repository is plain, modern JavaScript (Node 18+, ES modules)
with a zero-dependency test harness (`test/harness.js`) — not because
TypeScript is undesirable, but because it removes any dependency on npm
registry access being available in whatever environment continues this
work. If real npm access is confirmed available, adding TypeScript (or at
minimum a JSDoc + `tsc --checkJs` type-checking pass) is a reasonable first
improvement — the module boundaries (`lexer/`, `parser/`, `ast/`,
`analyzer/`, `interpreter/`, `diagnostics/`) were kept small and
dependency-light specifically to make that migration mechanical later.

## Current state (this repo)

- **v0.1 core, fully implemented and passing**: lexer, recursive-descent
  parser, semantic analyzer, tree-walking interpreter.
- **`CHANGE` (ADR-002) implemented as part of v0.1**, not deferred — it was
  adopted before any code was written in the original design process, so
  treating it as core rather than a later add-on is faithful to that
  history.
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
  `DELETE`, one collection per `DATA` type, integer ids. **Note**: unlike
  v0.1–v0.4, the original chat's exact syntax for this milestone didn't
  survive verbatim — this is this repo's own design (same ADR-first
  discipline, the same three reserved keywords) — see
  `examples/persistence.nova`.
- **v0.6 (ADR-007) implemented**: a small standard library — `UPPER`,
  `LOWER`, `TRIM`, `LENGTH`, `ROUND`, `ABS` — called with exactly the same
  syntax as a user `DO` procedure, sharing its namespace (redefining one is
  a duplicate-procedure error, not silent shadowing). See
  `examples/stdlib.nova`.
- **v0.7 (ADR-008) implemented**: `ASK "prompt"` for real, synchronous,
  lazily-read stdin input (`SET name = ASK "Name? "`). A program that
  never calls `ASK` never touches stdin — see
  `src/interpreter/stdin.js`. Verified two ways, matching the original's
  own approach: canned input queues in unit tests, and real piped stdin
  through the CLI (`test/run-examples.js` now supports an optional
  `<example>.stdin` companion file; see `examples/ask.nova` +
  `examples/ask.stdin`).
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
- **210/210 unit tests passing** (`node test/run.js`) — lexer, parser,
  analyzer, interpreter, and diagnostic formatting.
- **41/41 examples verified through the real CLI** (`node
  test/run-examples.js`) — 17 valid programs that must run cleanly, 22
  invalid programs that must fail with the exact diagnostic code the spec
  promises, plus two dedicated `nova build` checks (static and
  data-bound) that write and inspect real HTML output files. This is
  deliberately the "actual CLI output" level of verification, not just
  in-process test calls, matching the discipline described in the
  original chat.
- Every diagnostic in SPECIFICATION.md §11's table is implemented and has
  at least one test or example exercising it.

Verify it yourself:
```bash
node test/run.js
node test/run-examples.js
node src/cli.js build examples/data_bound_website.nova && cat examples/dist/catalog.html
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
  data source (`FOR EACH...IN GET`, no `WHERE` filtering, no nested
  `DATA` fields beyond one level deep in practice, though the grammar
  doesn't forbid it). No interactivity (`BUTTON`/`WHEN`) or server
  (`API`/`SECURITY`) yet — interactivity is the next, final planned
  milestone (see below).
- Numbers use JS's native `number` type, not true arbitrary precision
  (flagged as an explicit open question in SPECIFICATION.md §16).

## What's next

The original chat's own roadmap, in order (each deserves its own ADR
before implementation, per the process that's held so far):

1. **Interactive `PAGE`** — `BUTTON`/`WHEN clicked` compiled to
   restricted, sandboxed client-side JavaScript. This is the last item
   with any concrete detail surviving from the original chat (its very
   first message flagged "how does a PAGE safely call into backend logic
   without creating a client/server RPC bug class" as the central open
   question) — specifically restrict `SAVE`/`GET`/`ASK`/arbitrary calls
   out of click handlers, and verify the restriction by actually trying to
   sneak one past the real CLI, not just by reading the generated code.
   This is the **last originally-planned milestone** (v0.12 in the
   original's own numbering) — completing it finishes the entire roadmap
   this repository set out to recover and continue.
2. From there: a minimal server/API pillar, durable storage, security
   basics, mobile/desktop targets, native compilation/self-hosting — all
   explicitly multi-month-plus territory, not a next milestone, and with
   no surviving detail from the original chat at all — genuinely new
   ground past this point.

The process discipline that held for 13 milestones in the original and is
worth continuing: **ADR before implementation** for any real design
decision, smallest-correct-version per milestone (resist doing three
milestones' worth of surface in one pass), and **verify through the real
CLI** — not just unit tests — before calling a milestone done, especially
for anything with genuine I/O or generated-code output (client-side JS,
piped stdin) where a passing unit test can still hide a real bug a live run
would catch immediately.

## Files worth reading, in order

1. This file.
2. [docs/SPECIFICATION.md](docs/SPECIFICATION.md) — the binding spec.
3. The ADRs in [docs/adr/](docs/adr/), in order: block delimiters (001),
   the `CHANGE` keyword (002), list/record literals (003), typed
   procedures (004), `DATA` named types (005), persistence (006), the
   standard library (007), `ASK` input (008), list indexing/mutation
   (009), error handling (010), the static PAGE compiler (011),
   data-bound PAGE (012) — read the last two in particular before
   touching PAGE further.
4. `src/nova.js` — the four-stage pipeline in ~20 lines; the best map of
   how the pieces fit together.
5. `examples/` and `examples/errors/` — read these before the source; they
   show the intended surface and error quality more concretely than prose.
