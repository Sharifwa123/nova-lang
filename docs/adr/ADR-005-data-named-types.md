# ADR-005: DATA Named Types

## Problem
v0.2 gave NOVA anonymous record literals (`{ name: "x", price: 9.99 }`) and
v0.3 gave procedures optional type annotations — but there's still no way
to give a record *shape* a name. Every `Product`-shaped value in a real
program is just "a record" to the analyzer; a typo'd or missing field on a
record literal passed into a procedure is invisible until (if ever) a
runtime field-access error fires somewhere unrelated. `DATA` closes that
gap: a named, reusable shape that plugs into the type-annotation vocabulary
`INPUT`/`RETURNS` already established in v0.3.

## Decision

```
data-declaration ::= "DATA" identifier NEWLINE field-decl* "END"
field-decl        ::= identifier ":" type-name
type-name          ::= identifier   # a primitive, OR a DATA name (this or any other)
```

```nova
DATA Product
    name: text
    price: decimal
END

DO describe RETURNS text
    INPUT p: Product

    RETURN "{p.name}: {p.price}"
END
```

`DATA` moves from v0.1's forward-reserved (grammar-less) keyword list into
real grammar — the first of the six words reserved back in §2.6 to
actually get one.

### Zero new runtime concept
DECISION: a `DATA`-declared type has **no representation in the
interpreter distinct from the anonymous record it names** — this was the
original design's own stated goal for this milestone, and it's preserved
here exactly. `DATA` is purely a compile-time (analysis-time) naming layer
over the `record` runtime type that already existed since v0.1. A `Product`
value at runtime is, bit-for-bit, the same `{ type: "record", value: {...}
}` a plain untyped record literal produces.

### Structural, not nominal — but literal-checked
NOVA stays structurally typed: any record-*shaped* value can flow through
generic `'record'`-typed positions freely, same as before. What `DATA`
adds is that **at the point a record literal is directly used where a
specific `DATA` type is expected** (a typed parameter's argument, a typed
`RETURN`'s value), the analyzer can see the literal's exact fields and
check them against the declared shape — extra fields, missing fields, and
wrong field types are all caught right there, at the point of construction,
which is exactly where a developer (or an AI generating code) benefits
most from a precise error. This mirrors a well-established pattern
(TypeScript calls it "excess property checking" — object literals get
extra scrutiny exactly because, unlike a value flowing through a variable,
the literal's shape is fully visible to the checker at that point).

DECISION: an object literal checked against a `DATA` type must match
**exactly** — no missing fields (`E-SEM-018`), no extra fields
(`E-SEM-020`), and no field-type mismatches (`E-SEM-019`). "At least these
fields" duck typing was considered and rejected: `DATA`'s entire purpose is
to name one exact, meaningful shape (`Product` *is* `{ name, price }`, not
"anything with at least a name and a price") — permitting silent extras is
the same class of hidden-behavior risk NOVA has rejected everywhere else
(duplicate record fields, ELSE-after-ELSE, chained comparisons).

DECISION: once a value's static type is known to be a specific `DATA`
name (a typed parameter, or the result of a procedure whose `RETURNS` names
that type), `.field` access — and the equivalent `{value.field}` string
interpolation path — is checked **statically** against the declared shape,
returning the field's own declared type instead of `'unknown'`. A field
that doesn't exist on that type is now a compile-time error
(`E-SEM-021`), not a wait-until-runtime surprise. This is the actual payoff
of doing `DATA` at all — everywhere a `DATA` type's shape is not statically
visible (a value that only ever passed through generic `'record'`-typed
positions, or arrived via `FOR EACH` over a list — element types are still
untracked per ADR-003's explicit deferral), field access stays exactly as
permissive as it always was.

### Recursive and forward references
DECISION: `DATA` names are pre-registered (name only) in one pass over the
top level before any field types are resolved, then every field's type
name is resolved in a second pass — exactly the same two-phase shape
already used for procedure names (v0.1) so recursion/self-reference works.
This makes both self-referencing (`DATA Node ... next: Node ... END`, e.g.
for a linked structure) and forward-referencing types (`DATA Order ...
product: Product ... END` written *before* `Product` itself) work with no
special-casing, and lets `DATA` types and typed procedures freely forward-
reference each other regardless of which appears first in the file.

### Separate namespace from procedures
DECISION: `DATA` type names and procedure names are two separate
namespaces — a `DATA Product` and a `DO Product` can coexist. This matches
the type/value namespace separation nearly every mainstream typed language
uses (C, Java, TypeScript) and avoids inventing a reason they'd need to
collide.

### What's still out of scope
DEFERRED, explicitly:
- Typed lists ("a list of `Product`") — `FOR EACH` loop variables and list
  elements remain `'unknown'`, per ADR-003. `DATA` types can be used as
  `INPUT`/`RETURNS` annotations but not (yet) to describe a list's element
  type.
- A named constructor syntax (e.g. `Product { name: "x", price: 9.99 }`) —
  a bare record literal `{ ... }` is still the only construction syntax;
  `DATA` only gives the analyzer a shape to check literals against, it
  doesn't change literal syntax itself.
- Field defaults, optional fields, or any validation beyond a field's
  declared primitive/`DATA` type.

## Consequences
- `DATA` removed from the forward-reserved keyword list (§2.6) — it now
  has real grammar.
- New AST node: `DataDeclaration(name, fields: [{name, type}])`.
- Five new diagnostics: `E-SEM-017` (duplicate `DATA` type name),
  `E-SEM-018` (missing field), `E-SEM-019` (field type mismatch),
  `E-SEM-020` (unexpected/extra field), `E-SEM-021` (accessing a field that
  doesn't exist on a statically-known `DATA` type).
- The type-compatibility check shared by `SET`/`CHANGE` reassignment, call
  arguments, and `RETURN` values (ADR-004) gains two permissive rules:
  a generic `'record'` value may flow into a `DATA`-typed slot, and a
  `DATA`-typed value may flow into a generic `'record'`-typed slot — but
  two *different* `DATA` type names remain incompatible with each other,
  same as any other real type mismatch.
