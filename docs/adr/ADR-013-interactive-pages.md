# ADR-013: Interactive PAGE — BUTTON / WHEN CLICKED

This design reuses established NOVA mechanisms (`SET`/`CHANGE`) wherever
they already fit, rather than growing parallel new ones — the same
restraint every prior ADR in this series has applied. Two footguns are
deliberately avoided by construction, not just fixed after the fact: a
missing newline-skip between `WHEN`'s closing `END` and `BUTTON`'s own
`END` (§ Grammar, below), and reusing the wrong scope for "page-local
state" during semantic analysis.

## Problem
This is one of the hardest problems in the whole spec: how does a `PAGE` safely call into
backend logic without creating a client/server RPC bug class? v0.12
answers the narrowest honest version of that question — no server exists
yet (that's still a later milestone), so "interactivity" here means
**purely client-side state**, compiled to real, sandboxed JavaScript that
runs in the browser with no path back to NOVA's `SAVE`/`GET`/`ASK`/
procedure-call surface at all.

## Decision

### Page-local state reuses SET and CHANGE, not new keywords
```nova
PAGE "/counter"
    SET count = 0

    HEADING count

    BUTTON "+1"
        WHEN CLICKED
            CHANGE count = count + 1
        END
    END
    BUTTON "Reset"
        WHEN CLICKED
            CHANGE count = 0
        END
    END
END
```
DECISION: a `SET` at a `PAGE`'s top level declares **page-local state** —
initialized from a literal (same "must be static" rule as every other
`PAGE` element, ADR-011), rendered into the page, and mutable only from
inside a `WHEN CLICKED` block via `CHANGE`. This is the exact same
`SET`-declares/`CHANGE`-mutates split ADR-002 established for ordinary
variables and ADR-009 reused for list elements — applied a third time to
a third kind of storage, not a new rule invented for this case.

### Grammar
```
page-element  ::= ... (ADR-011/012, unchanged)
                | "SET" identifier "=" literal
                | "BUTTON" expression NEWLINE "WHEN" "CLICKED" block "END" NEWLINE "END"
```
New keywords: `BUTTON`, `CLICKED`; `WHEN` graduates from forward-reserved
into real grammar. A `WHEN CLICKED` block is parsed as an **ordinary**
statement block (reusing the existing generic block parser) — anything
syntactically valid NOVA can appear there. Restricting *what's actually
allowed* is deliberately a semantic check, not a parser restriction (see
below): a builtin call parses fine syntactically, but the *analyzer* is
what draws the line and rejects it with a semantic error.

### What a click handler may actually do — enforced, narrowly
DECISION: inside `WHEN CLICKED`, every statement must be `CHANGE
<pageLocalState> = <safe expression>` — nothing else (`E-SEM-034` for any
other statement kind, `E-SEM-035` if the target isn't page-local state,
`E-SEM-036` for an indexed target, since page-local state is scalar-only
for v0.12). A "safe expression" is a literal, a *reference to page-local
state*, or `+ - * / == != < > <= >= AND OR NOT` combining safe
expressions — never a procedure/built-in call, never `SAVE`/`GET`/`ASK`,
never field/index access, never a list/record literal (`E-SEM-037` for
any of these). This is checked two ways, deliberately kept separate
because they're different concerns:
1. **Type/name correctness** reuses the ordinary `infer()` pass, evaluated
   against a scope containing *only* page-local state bindings — an
   identifier that isn't page-local state fails as an ordinary undefined
   name (`E-SEM-001`), for free, with zero new logic.
2. **Sandboxing** (no calls, no `SAVE`/`GET`/`ASK`, no field/index/
   composite-literal access) is a separate, narrow structural walk
   (`assertNoUnsafeConstructs`) — `infer()` alone would happily accept a
   call to any ordinary, safe-looking procedure, which is exactly the
   RPC-shaped hole this whole ADR exists to close. Splitting these two
   checks apart, rather than trying to make one pass do both jobs, avoids
   a real failure mode: using the wrong scope could produce false
   negatives *and* false positives at once — separating "is this
   well-typed" from "is this allowed here" removes that by construction.

### BUTTON is top-level only, for now
DECISION: `BUTTON` is valid only at a `PAGE`'s top level, not inside a
`FOR EACH` (`E-SEM-038`). A "delete this row" button per rendered record
is real and useful, but it needs an answer for *which* record a click
came from — a genuinely separate design question, left for a later
milestone rather than folded in here.

### Compiled output
DECISION: `nova build` emits one `<script>` block per page containing any
state/buttons: a `state` object (one field per `SET`-declared page-local
variable), a `render()` function that updates every state-bound
element's `textContent` (never `innerHTML` — `.textContent` cannot be
interpreted as markup, so no HTML-escaping is needed for these updates
the way static content needs it at build time), and one named function
per `BUTTON` applying its `CHANGE`s to `state` and then calling
`render()`. `render()` runs once immediately (so the initial DOM state
already matches `state`, even though the server-rendered HTML was also
correct at build time — belt and suspenders, and it's what makes the
button functions independently testable, which is exactly how this ADR
verifies them).

### Verification: execute the generated JavaScript, not just diff it
DECISION: passing tests must **execute** the compiled `<script>` in Node against a minimal
DOM stub and call the generated button functions programmatically,
asserting on the resulting `state`/DOM text — not merely assert the HTML
string contains expected substrings. A string match cannot catch a
generated-code bug (wrong variable name, wrong operator translation,
`render()` never called); actually running it can and does.

## Consequences
- New keywords `BUTTON`, `CLICKED`; `WHEN` graduates from reserved.
- `PageDeclaration`'s `elements` gains two new kinds: `{ kind: 'SET',
  name, value }` (page-local state) and `{ kind: 'BUTTON', label,
  actions: Statement[] }` (`actions` reuses ordinary `ChangeStatement`
  nodes, ADR-002/009 — no new action-statement AST at all).
- `src/pagecompiler/compile.js` gains a JS code generator for the safe
  expression subset, and now emits a `<script>` block when a page has any
  state/buttons.
- Six new diagnostics: `E-SEM-033` (duplicate page-local state name),
  `E-SEM-034` (a non-`CHANGE` statement inside `WHEN CLICKED`), `E-SEM-035`
  (a `CHANGE` target that isn't page-local state), `E-SEM-036` (an
  indexed `CHANGE` target inside a click handler), `E-SEM-037` (an unsafe
  construct — call, `SAVE`/`GET`/`ASK`, field/index access, or a list/
  record literal — inside a click-handler expression), `E-SEM-038`
  (`BUTTON` used inside a `FOR EACH`, not yet supported).
