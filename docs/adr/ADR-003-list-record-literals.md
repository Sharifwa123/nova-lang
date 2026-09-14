# ADR-003: List and Record Literals

## Problem
v0.1 already has `list` and `record` **runtime** types (§3), and `FOR EACH`
and `.field` access already work on them — but v0.1 provides **no source
syntax** to construct either one. A list or record can only ever arrive
from a host embedding injecting one before the program runs. That blocks
writing any interesting, genuinely self-contained NOVA program: every
worked `FOR EACH product IN products` example depends on something outside
the language handing it a `products` value. v0.2's job is to close that gap
with real literal syntax.

## Options considered
1. **Reuse existing punctuation** (e.g. a `LIST(1, 2, 3)` builtin-style call
   instead of new brackets). **Rejected**: fights NOVA's own "natural,
   readable" philosophy for something this common, and doesn't generalize
   cleanly to records (a `RECORD(x, 1, y, 2)` positional call is much worse
   than reading `{ x: 1, y: 2 }`).
2. **`[ ... ]` for lists, `{ ... }` for records**, reusing the `:` token
   for `field: value` pairs. **Adopted.**

`{ }` was never rejected as a general token by ADR-001 — ADR-001 rejected
`{ }` specifically as a **block delimiter** (in favor of `END`). Using `{ }`
for a record *literal* is a different grammatical position entirely
(an expression, not a block), so there's no conflict: NOVA blocks are still
delimited solely by `END`, everywhere, always. `:` was already reserved in
§2.8 specifically for "the future `DATA` field-type syntax `name : text`" —
`field: value` in a record literal is the same token doing the same
conceptual job (naming a field), so this is the reservation being used for
exactly what it was set aside for, not repurposed.

## Decision

```
list-literal   ::= "[" ( expression ( "," expression )* ","? )? "]"
record-literal ::= "{" ( field-init ( "," field-init )* ","? )? "}"
field-init     ::= identifier ":" expression
```

A trailing comma is permitted (not required) before the closing bracket —
this is a small, deliberate concession to how often list/record literals
get reformatted or AI-generated with one line per element; forbidding a
trailing comma buys nothing and is a common paper-cut in other languages.

**List elements may be of mixed types.** v0.1/v0.2 has no way to express
"a list of integers" as a type — enforcing homogeneity now would be an
arbitrary restriction with nothing yet able to check it meaningfully
against, and the right hook for that (typed lists, once `DATA`/typed
procedures exist) doesn't exist yet. DEFERRED, with the extension point
being that list element checking is additive once list types exist.

**A repeated field name within one record literal is a semantic error**
(new diagnostic `E-SEM-012`), not "last one wins." Silently keeping only
the last `x:` in `{ x: 1, x: 2 }` is exactly the kind of hidden behavior
NOVA's philosophy rejects — a typo that repeats a field name by accident
would silently and quietly discard data instead of being caught.

**Postfix `.field` access is generalized to follow any primary expression**
— not only identifiers. v0.1's grammar for `FieldAccess` was already
`identifier ("." identifier)*` in principle, but the parser only ever
implemented that chain starting from an identifier, because every v0.1
worked example only ever chained off one. Now that record literals and
procedure calls can *directly* produce a record, `{ x: 1 }.x` and
`makePoint().x` need to work too, so the postfix loop moves to wrap
whatever primary was just parsed (literal, call, list, record, or a
parenthesized expression), not just identifiers.

**Equality (`==`/`!=`) is extended to structural equality for records**,
matching what v0.1 already does for lists (`valuesEqual`, §5.5) — two
records are equal iff they have the same field names and every field's
value is (recursively) equal. This is a small, contained extension of an
existing rule, not a new one.

## Consequences
- New tokens: `[ ] { }` (§2.8 amended).
- New AST nodes: `ListLiteral(elements)`, `RecordLiteral(fields: [{name,
  value}])` (§12 amended).
- New diagnostic `E-SEM-012` (duplicate field name in a record literal).
- `infer()` in the analyzer gains `ListLiteral -> 'list'` and
  `RecordLiteral -> 'record'` cases; `FieldAccess`'s target type remains
  `'unknown'` for static field-existence checking — that still needs
  `DATA`, which is a later milestone (§15). Only the *duplicate-name*
  check happens now, at literal-construction time, because it's checkable
  without any type system at all.
- `FOR EACH x IN [1, 2, 3]` and `FOR EACH p IN [{name: "Widget"}]` now work
  with **zero host injection** — the first genuinely self-contained NOVA
  programs using `FOR EACH` are possible starting with this milestone.
