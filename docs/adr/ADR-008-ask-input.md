# ADR-008: ASK — Real Synchronous Input

## Problem
NOVA can compute and persist, but a program can't ask its user anything —
every example so far has all its data baked in at `SET` time or supplied
by a host embedding. `ASK` closes that gap with real, blocking,
synchronous input, matching NOVA's plain imperative reading style (no
callbacks, no async/await — `SET name = ASK "..."` reads exactly like the
line before and after it).

## Decision

```
ask-expression ::= "ASK" expression
```

```nova
SET name = ASK "What is your name? "
SHOW "Hello, {name}"
```

New keyword `ASK`. Like `SAVE`/`GET` (ADR-006), it's expression-level, not
a statement — usable anywhere an expression is valid.

### Semantics
`ASK <expr>` evaluates `expr` (any type; `display()`-ed the same way `SHOW`
displays a value) and writes it to stdout as a **prompt with no trailing
newline** — so the user's typed answer appears on the same line, standard
terminal UX. It then **blocks**, reading one line of real input, and
returns it as `text`. `ASK`'s static type is always `text`.

### Lazy — stdin is never touched by a program that never calls ASK
DECISION: input is read **on demand**, one line at a time, exactly when an
`ASK` expression actually executes — never eagerly at program start. This
matters a great deal in practice: every example and test written before
this milestone never calls `ASK`, and eagerly pre-reading stdin at startup
(a tempting simplification) would make the CLI hang waiting for EOF on
every one of them the moment stdin isn't explicitly closed or redirected.
A zero-dependency synchronous line reader (`src/interpreter/stdin.js`,
built on `fs.readSync` against fd 0) is used instead of any "read
everything up front" shortcut.

### No text-to-number conversion (yet)
DEFERRED, explicitly: `ASK` always returns `text`, even when the prompt is
obviously asking for a number. NOVA has no `text`→`integer`/`decimal`
parsing builtin yet (ADR-007's stdlib didn't include one), so `SET age =
ASK "Age: "` gives `age` a `text` value that can't be used in arithmetic
without a future parsing builtin. This is a real, honest gap, not a
silent trap — attempting `age + 1` today correctly fails with the
existing operator-type diagnostic (`E-SEM-004`), the same as any other
text-plus-number mistake.

### Exhausted input is a runtime error, not silent NONE/empty text
DECISION: if `ASK` is called after all available input is gone (stdin
closed / EOF reached), that's a runtime error (`E-RUN-004`), not an empty
string or a `NONE` value standing in. Returning an empty string
indistinguishable from "the user pressed Enter with nothing typed" would
be exactly the kind of silent, ambiguous behavior NOVA has avoided
everywhere else (see `NO_SUCH_FIELD`, `DIVIDE_BY_ZERO` — runtime
conditions that can't be caught statically still get a clear, loud
diagnostic rather than a quiet fallback value).

### Dual verification: canned input and real piped stdin
DECISION: the interpreter accepts an optional canned `input: string[]`
list (consumed in order, exhaustion triggers the same `E-RUN-004`) for
fast, deterministic automated tests — see `test/v0.7-ask.test.js`. The
real CLI instead uses the actual synchronous stdin reader. Both paths
share the same `AskExpression` evaluation code; only where the next line
comes from differs. `test/run-examples.js` additionally pipes real stdin
into the CLI for at least one example (`printf ... | nova run ...`) —
canned-queue tests alone would not have caught a bug in the real
`fs.readSync`-based reader.

## Consequences
- New keyword `ASK`; new AST node `AskExpression(prompt)`.
- New diagnostic `E-RUN-004` (ASK called with no input left).
- `Interpreter` gains an `input`/`nextLine` construction option (mirrors
  `hostGlobals` and `write`'s existing "swap the real thing for a test
  double" pattern) and a `writePrompt` option (prompts must not get `SHOW`'s
  automatic trailing newline).
