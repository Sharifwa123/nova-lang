# ADR-004: Typed Procedures

## Problem
v0.1/v0.2 procedures have no parameter or return type annotations —
`INPUT price` and a procedure's `RETURN` value are both statically
`'unknown'` to the analyzer (§9, §13). That's fine for small examples, but
it means the single most useful place for NOVA to catch a mistake early —
"you called `calculateTotal` with a text value where it expects a number"
— currently isn't caught until (if ever) a runtime type error fires deep
inside the procedure body, far from the actual mistake at the call site.

## Options considered
1. **Mandatory type annotations on every parameter and return value.**
   **Rejected**: breaks every v0.1/v0.2 example and every test written so
   far, for a benefit (better call-site checking) that doesn't require
   forcing it everywhere. NOVA's own `SET`/`CHANGE` types are already
   inferred, not declared — procedures should follow the same "annotate
   when it helps, infer otherwise" spirit rather than introducing the only
   mandatory-annotation corner of the language.
2. **Optional annotations**, defaulting to today's `'unknown'` behavior
   when omitted. **Adopted.**

## Decision

```
input-declaration ::= "INPUT" identifier ( ":" type-name )?
type-name          ::= identifier   # one of: integer, decimal, text, boolean, list, record
do-declaration     ::= "DO" identifier ( "RETURNS" type-name )? input-declaration* block "END"
```

New keyword: `RETURNS` (placed right after the procedure name, before its
`INPUT` lines, so the full signature reads in one place: `DO calculateTotal
RETURNS decimal`). Type names are **not** new keywords — `integer`,
`decimal`, `text`, `boolean`, `list`, `record` are ordinary identifiers
used in type-annotation position; the analyzer validates them against a
fixed set (unrecognized name -> `E-SEM-016`). `DATA`-defined names aren't
valid here yet (`DATA` doesn't exist until v0.4) — that's the next natural
extension point.

```nova
DO calculateTotal RETURNS decimal
    INPUT price: decimal
    INPUT quantity: integer

    RETURN price * quantity
END
```

### Parameter types
When `INPUT name: type` is given, `name`'s static type inside the body is
`type` (not `'unknown'`) — this makes the analyzer strictly more useful
inside a typed procedure's own body, for free, since every existing check
(`+`/`-`/`*`/`/`, comparisons, `SET` reassignment, etc.) already consults
static types. At each **call site**, an argument's inferred type must be
compatible with the declared parameter type (same widening rule as `SET`:
integer -> decimal is fine, nothing else is) — mismatch is `E-SEM-015`.
Omitted annotations keep today's fully-permissive `'unknown'` behavior,
both inside the body and at call sites.

### Return types
When `RETURNS type` is declared:
- Every `RETURN <value>` in the body must have a value whose inferred type
  is compatible with `type` (same widening rule) — mismatch is
  `E-SEM-013`.
- A **bare** `RETURN` (no value) is itself a mismatch under `E-SEM-013`,
  since it yields `NONE`, which is never compatible with a declared type.
- The body must **definitely return** on every path — see below. Failing
  to is `E-SEM-014`.

### "Definitely returns" — a deliberately conservative, sound check
DECISION: a statement list "definitely returns" iff *any* statement in it
definitely returns (a `RETURN` makes everything after it unreachable, so
one is enough). A single statement definitely returns iff:
- it is a `RETURN` statement, or
- it is an `IF` **with an `ELSE`** where *every* branch (all `ELSE IF`s
  and the final `ELSE`) definitely returns.
- Nothing else does — in particular, `FOR EACH` and `REPEAT` bodies are
  **never** treated as guaranteeing a return, no matter what they contain,
  because a loop can run zero times (`REPEAT 0 TIMES`, an empty list) and
  still fall through.

This is intentionally conservative: it will reject some procedures a
smarter whole-program analysis could prove always return (false
positives), but it will never *accept* one that can actually fall off the
end and silently produce `NONE` where a typed value was promised (no false
negatives). That asymmetry is the right one for a language whose stated
priority is catching real bugs over accepting every technically-safe
program — and it's simple enough to explain in one paragraph, which matters
for a language that wants its own error messages to be teachable, not just
correct. A more precise checker (accounting for infinite loops, `REPEAT`
with a provably-positive literal count, etc.) is a reasonable future
refinement, not a v0.3 requirement.

### What's deliberately NOT enforced at runtime
DECISION: none of this is re-checked by the interpreter at call/return
time. Per §13's existing "semantic analysis is exhaustive before any
statement executes" design, a program that passed analysis is trusted by
the interpreter completely — adding redundant runtime checks here would
contradict that design rather than extend it.

## Consequences
- New keyword `RETURNS`.
- `ProcedureDeclaration.parameters` becomes `[{ name: Identifier, type:
  string|null }]` instead of `[Identifier]`; new field `returnType:
  string|null` (§12 amended).
- Four new diagnostics: `E-SEM-013` (return type mismatch / bare return),
  `E-SEM-014` (not all paths return), `E-SEM-015` (argument type
  mismatch), `E-SEM-016` (unknown type name in an annotation).
- Fully backward compatible: every v0.1/v0.2 program (no annotations
  anywhere) type-checks and runs identically to before.
