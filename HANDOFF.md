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
- **83/83 unit tests passing** (`node test/run.js`) — lexer, parser,
  analyzer, interpreter, and diagnostic formatting.
- **19/19 examples verified through the real CLI** (`node
  test/run-examples.js`) — 8 valid programs that must run cleanly, 11
  invalid programs that must fail with the exact diagnostic code the spec
  promises. This is deliberately the "actual `nova run` output" level of
  verification, not just in-process test calls, matching the discipline
  described in the original chat.
- Every diagnostic in SPECIFICATION.md §11's table is implemented and has
  at least one test or example exercising it.

Verify it yourself:
```bash
node test/run.js
node test/run-examples.js
node src/cli.js run examples/catalog.nova
```

## Known, deliberate limitations (not bugs)

These are all named as DEFERRED in docs/SPECIFICATION.md, not oversights:

- List elements may be mixed types — no type system exists yet capable of
  expressing (or checking) "a list of integers" (ADR-003; will tighten once
  typed lists exist, alongside typed procedures/`DATA`).
- No list **indexing** (`list[0]`) or mutation yet — literals and `FOR EACH`
  only. That's its own later milestone (see roadmap).
- No string concatenation operator (`+` is numeric-only); only
  `{identifier}`/`{identifier.field}` interpolation (still no arbitrary
  expressions inside `{}`).
- No typed procedures, no `DATA`, no persistence, no stdlib, no `PAGE`/
  `API`/`SECURITY` — all of §15's extension points are reserved at the
  keyword/token level but carry no grammar yet.
- Numbers use JS's native `number` type, not true arbitrary precision
  (flagged as an explicit open question in SPECIFICATION.md §16).

## What's next

The original chat's own roadmap, in order (each deserves its own ADR
before implementation, per the process that's held so far):

1. **Typed procedures** (v0.3) — parameter/return type annotations, checked
   by the analyzer (which already has an `infer()` pass to extend).
2. **`DATA Name / field: type / END`** named types (v0.4 in the original,
   its ADR-005) — explicitly designed as a pure naming layer over the
   existing structural record/list machinery, zero new runtime concept.
3. Persistence (`SAVE`/`GET`/`DELETE`, in-memory first) and a small stdlib.
4. `ASK "prompt"` for real synchronous stdin input (the original's ADR-008)
   — verify with real piped stdin through the CLI, not just canned test
   input, since it's genuinely new I/O code.
5. Error handling, list indexing/mutation.
6. A `PAGE` compiler target (static HTML first, then data-bound, then
   `BUTTON`/`WHEN clicked` compiled to restricted, sandboxed client-side
   JavaScript — the original's ADR-013 is worth re-deriving carefully: it
   specifically restricted `SAVE`/`GET`/`ASK`/arbitrary calls out of click
   handlers, and verified the restriction by trying to sneak one past the
   real CLI, not just by reading the code).
7. From there: a minimal server/API pillar, durable storage, security
   basics, mobile/desktop targets, native compilation/self-hosting — all
   explicitly multi-month-plus territory, not a next milestone.

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
3. [docs/adr/ADR-001-block-delimiters.md](docs/adr/ADR-001-block-delimiters.md),
   [docs/adr/ADR-002-change-keyword.md](docs/adr/ADR-002-change-keyword.md),
   and [docs/adr/ADR-003-list-record-literals.md](docs/adr/ADR-003-list-record-literals.md).
4. `src/nova.js` — the four-stage pipeline in ~20 lines; the best map of
   how the pieces fit together.
5. `examples/` and `examples/errors/` — read these before the source; they
   show the intended surface and error quality more concretely than prose.
