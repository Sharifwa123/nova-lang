# ADR-006: Persistence (SAVE / GET / DELETE)

## Problem
NOVA has named record shapes (`DATA`) but no way to keep any value alive
past a single `nova run` process. `SAVE`/`GET`/`DELETE` were reserved as
the persistence verbs from early on; v0.5 gives them real, minimal,
in-memory semantics — durable (file-backed) storage and `GET ... WHERE`
filtering are both intentionally deferred to a later milestone, not
oversights.

## Decision

```
save-expression  ::= "SAVE" expression
get-expression    ::= "GET" identifier
delete-statement  ::= "DELETE" identifier expression
```

```nova
DATA Product
    name: text
    price: decimal
END

SET id = SAVE { name: "Widget", price: 9.99 }   # see note below on why this needs a typed source
SET products = GET Product
DELETE Product id
```

### One collection per DATA type, integer ids
DECISION: every `DATA` type implicitly owns one in-memory collection,
named after the type. `SAVE <expr>` requires `expr`'s **static type to be
a specific, known `DATA` type name** — not generic `'record'`, and (a
deliberate, necessary exception to NOVA's usual rule) not `'unknown'`
either, because the collection to save into is derived entirely from the
static type; there is no runtime fallback to fall back on. A value whose
exact `DATA` type isn't statically known cannot be `SAVE`d (`E-SEM-022`).

`SAVE` assigns the record a fresh `integer` id (per-type, starting at 1,
never reused) and returns that id — `SAVE` is an **expression**, not a
bare statement, specifically so the id is available for later `DELETE`
(and future lookup-by-id) without inventing a second mechanism to obtain
it.

### Zero new runtime concept, again
DECISION, consistent with ADR-005: the id is bookkeeping the **store**
keeps *about* a record, not a field injected into the record's own shape.
A saved `Product` is stored exactly as it was given — `DATA Product`'s
declared shape (`name`, `price`) is not silently widened to include an
`id` field. This preserves ADR-005's exact-shape guarantee for record
literals rather than quietly breaking it the moment persistence exists.

Practically, this means `GET Product` returns a `list` of bare `Product`
records with **no id attached** — DEFERRED, explicitly: a future indexed
fetch (`GET Product WHERE id == x`, or a form that returns id+record
pairs) is the natural next step once there's real demand for it — `WHERE`
filtering is intentionally deferred past this milestone. For v0.5, the
realistic pattern is "keep the id `SAVE` handed you, use it later" —
which is exactly how a "delete this row" button (the concrete next step
after basic persistence) actually works: the id came from
rendering a list that was itself built right after saving, not from
re-deriving it out of thin air.

### `SAVE` needs a typed *source*, not a bare literal
Because `SAVE`'s operand must have a **specific** `DATA` type statically —
and a bare `{ name: ..., price: ... }` record literal only has that
precise a type when it's checked *against* an expected type (ADR-005) —
`SAVE { ... }` directly on an untyped literal doesn't work; the literal
must first pass through a typed position (an `INPUT p: Product` parameter,
or a `RETURNS Product` procedure) to acquire a specific static type:

```nova
DO makeProduct RETURNS Product
    INPUT n: text
    INPUT pr: decimal
    RETURN { name: n, price: pr }
END

SET id = SAVE makeProduct("Widget", 9.99)
```

This is not an oversight; it's the direct, foreseeable consequence of
ADR-005's own explicitly-deferred item ("no named-constructor syntax for
`DATA` types") meeting persistence's need for a precise, unambiguous
target collection. A named-constructor syntax (`Product { ... }`) would
remove this friction; it stays on the deferred list.

### DELETE is idempotent, not an error on a missing id
DECISION: `DELETE TypeName idExpr` silently does nothing if no record with
that id exists in that type's collection. Rejected alternative: erroring
on an already-deleted (or never-existed) id. A delete that's already true
("this id isn't in the collection") being an error is a common source of
real-world race-condition noise (two requests deleting the same row) with
no corresponding safety benefit — idempotent deletion is the more robust
default and matches how most real deletion APIs behave.

### GET returns everything, in insertion order
DECISION: `GET TypeName` returns *every* currently-saved record of that
type, oldest first. No filtering yet (`WHERE`, intentionally deferred) —
this is the smallest useful slice: list rendering (`FOR EACH
product IN GET Product ... END`) already works today with zero further
grammar.

## Consequences
- `SAVE`, `GET`, `DELETE` move from the forward-reserved keyword list
  (§2.6) into real grammar.
- New AST nodes: `SaveExpression(value)`, `GetExpression(typeName)`,
  `DeleteStatement(typeName, idExpression)`.
- The analyzer **annotates** `SaveExpression` nodes with the resolved
  `DATA` type name (`expr.dataTypeName`) during analysis — the interpreter
  reads that annotation rather than re-deriving the target collection at
  run time (the interpreter has no static-type information of its own;
  this is the standard checker → codegen/runtime handoff pattern, applied
  here instead of inventing a parallel runtime type-tag).
- Interpreter gains an in-memory store: one `{ nextId, records: Map<id,
  value> }` per `DATA` type name, alive only for the current process
  (explicitly not durable — file-backed storage is a later milestone).
- New diagnostics: `E-SEM-022` (`SAVE` operand isn't a specific known
  `DATA` type), `E-SEM-023` (`GET` names an unknown `DATA` type),
  `E-SEM-024` (`DELETE` names an unknown `DATA` type), `E-SEM-025`
  (`DELETE`'s id expression isn't an integer).
