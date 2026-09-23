# ADR-009: List Indexing and Mutation

## Problem
Lists have existed since v0.2 (literals, `FOR EACH`, `LENGTH`) but there is
still no way to read or change a single element by position — the only way
to "get the third item" is to iterate the whole list, and there is no way
to change one item at all.

## Decision

**Read access** — a new postfix form, generalizing the same postfix
mechanism ADR-003 already uses for `.field`:
```
postfix ::= primary ( "." identifier | "[" expression "]" )*
```
```nova
SET products = ["Widget", "Gadget", "Gizmo"]
SHOW products[0]        # "Widget"
SHOW products[1]         # "Gadget"
```

**Mutation reuses `CHANGE`, not `SET`, and not a new keyword**:
```
change-statement ::= "CHANGE" identifier ( "[" expression "]" )* "=" expression
```
```nova
SET products = ["Widget", "Gadget", "Gizmo"]
CHANGE products[0] = "Widget Pro"
SHOW products[0]          # "Widget Pro"
```

DECISION, and the actual reasoning worth stating explicitly: mutating one
element of an existing list is, by NOVA's own established distinction
(ADR-002), **always** a mutation of something that already exists — never
a declaration. `SET`'s entire meaning is "create-or-shadow in the current
scope" (§4.1/§8.6); that has no sensible reading for "change element 0 of
a list that already exists." `CHANGE`'s entire meaning is "mutate an
existing binding, found by the same scope-chain walk as a read" — indexed
assignment is exactly that, just reaching one level deeper (into the
list's contents) once the binding itself is found. Reusing `CHANGE` here
isn't a stretch; it's the same rule already applying to a new case, not a
new rule. Introducing a third keyword (`UPDATE`, `SET AT`, etc.) for
"mutate an element" would be exactly the "multiple ways to express the
same kind of thing" ADR-001 rejected for block delimiters.

Chains are permitted for nested lists: `CHANGE matrix[i][j] = value`.

### Lists are reference types (a deliberate, explicit choice)
DECISION: a `list` value's underlying storage is shared, not copied, when
assigned to another variable, passed as an argument, or returned. `CHANGE
products[0] = ...` mutates the *one* underlying list — any other variable,
parameter, or `DATA` field currently holding "the same list" (from a prior
`SET other = products`, or a procedure call that received `products` as an
argument) observes the change too. This is the ordinary, minimal-effort
choice (no copy-on-write machinery exists or is needed) and is consistent
with how the interpreter already represented lists internally since v0.2
(a `list` runtime value's `value` is a plain, mutable JS array) — this ADR
makes that existing internal fact an observable, *documented* language
property for the first time, rather than changing it.

### No static element-type tracking (still)
DECISION: `list[i]`'s static type is `'unknown'`, exactly like a `FOR
EACH` loop variable (ADR-003's deferral of typed lists still applies
unchanged). What *is* checked statically: the indexed target must be
`'list'` or `'unknown'` (`E-SEM-026` if it's definitely something else,
e.g. `text[0]`), and the index expression must be `'integer'` or
`'unknown'` (`E-SEM-027` otherwise). Values whose exact shape isn't
statically known (an `'unknown'`-typed value being indexed, or an index
whose type isn't known until runtime) fall through to a runtime check
instead — the same "static where possible, honest runtime check where
not" pattern already used for `FOR EACH`'s list-value check (§13) and
`REPEAT`'s integer-count check.

### Out-of-bounds is a runtime error; no negative indexing
DECISION: index `0` is the first element; an index `< 0` or `>= LENGTH` is
a runtime error (`E-RUN-005`), not `NONE`, not a silently-clamped value.
Python-style negative indexing (`list[-1]` for the last element) is
DEFERRED — it's a real convenience, but it's also a second meaning for the
same syntax that isn't needed to make indexing/mutation useful, and adding
it later is purely additive (widening the accepted index range costs
nothing later; narrowing it after the fact would be a breaking change).

### Record field mutation stays out of scope
DEFERRED, explicitly: this ADR is list indexing/mutation only, matching
the roadmap line's own wording. `CHANGE someRecord.field = value` is a
natural sibling capability and a reasonable next small ADR, but isn't
included here to keep this milestone's surface exactly what it says.

## Consequences
- New AST node: `IndexAccess(target, index)` (read).
- `ChangeStatement` gains an `indexPath: Expression[]` field (empty for a
  plain `CHANGE x = ...`, non-empty for indexed mutation).
- Four new diagnostics: `E-SEM-026` (indexing a definitely-non-list
  value), `E-SEM-027` (a definitely-non-integer index), `E-RUN-005`
  (index out of bounds), and `E-RUN-006`/`E-RUN-007` (the runtime-only
  fallback versions of the two static checks, for values whose type
  wasn't statically known to be wrong).
- Indexed `CHANGE` skips the ordinary "same type as before" reassignment
  check (§4.1/§4.3) that a plain `CHANGE x = ...` performs — there is no
  single tracked type for "element of a list" to check against, since
  list elements may be mixed types (ADR-003).
