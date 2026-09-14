# ADR-007: A Small Standard Library

**Provenance note**, same as ADR-006: the original chat's exact stdlib
surface didn't survive verbatim. One concrete data point did survive,
though — the original's own bug-fix narrative twice mentions a built-in
called `UPPER` (`{UPPER(favorite)}` in a string interpolation example, and
`UPPER(label)` used as the probe in ADR-013's restriction testing), so
`UPPER` is deliberately included here for continuity rather than invented
fresh. The rest of this small set (`LOWER`, `TRIM`, `LENGTH`, `ROUND`,
`ABS`) is this repository's own choice of "smallest useful set," in the
same spirit.

## Problem
NOVA has no way to transform a `text` or `number` value except through
`DO`-declared procedures — there's no way to uppercase a string, trim
whitespace, or measure a list's length from NOVA source itself. A minimal
standard library closes the most obviously missing gaps without opening
any large new design surface.

## Decision
Six built-in procedures, called with the **exact same syntax** as a
user-declared `DO` procedure — `UPPER(name)`, `LENGTH(items)` — because
NOVA already has one call syntax (§9.3) and inventing a second, special
one for "built-in" calls would be exactly the "multiple ways to do the
same thing" ADR-001 already rejected.

| Name | Signature | Behavior |
|---|---|---|
| `UPPER` | `(text) RETURNS text` | Uppercase |
| `LOWER` | `(text) RETURNS text` | Lowercase |
| `TRIM` | `(text) RETURNS text` | Strip leading/trailing whitespace |
| `LENGTH` | `(unknown) RETURNS integer` | Length of a `text` or `list`; runtime error on anything else |
| `ROUND` | `(unknown) RETURNS integer` | Nearest integer to an `integer`/`decimal`; runtime error otherwise |
| `ABS` | `(unknown) RETURNS decimal` | Absolute value of an `integer`/`decimal`; runtime error otherwise |

### Built-ins live in the same procedure namespace as DO
DECISION: built-ins are pre-registered in the exact same procedure table a
user's `DO` declarations populate — not a separate "module" or namespace,
and not a reserved-keyword form of call. This means: a `DO UPPER ... END`
collides with the built-in exactly like it would collide with another
user procedure of the same name, and is rejected (still `E-SEM-002`, with
a built-in-specific message since there's no source location to point at
for "previous definition"). No shadowing, silently or otherwise — matching
every other "same name declared twice" rule in the language so far.

### Three of the six have no fixed parameter type
DECISION: `UPPER`/`LOWER`/`TRIM` declare `text` as their real, checked
parameter type — a call site passing anything else is caught statically,
exactly like a user-typed procedure (`E-SEM-015`). `LENGTH`/`ROUND`/`ABS`
are **not** given a single fixed parameter type, because their actual
useful domain isn't one NOVA type: `LENGTH` is meaningful for `text` *and*
`list`; `ROUND`/`ABS` are meaningful for `integer` *and* `decimal`. NOVA's
type-annotation system (ADR-004) has no union/polymorphic type syntax, and
inventing one to cover three built-ins is exactly the kind of "adds real
complexity for a narrow, not-yet-demonstrated need" trade the project has
consistently declined elsewhere (see ADR-003's rationale for rejecting
full string-interpolation expressions, for the same reason). Instead,
these three parameters are typed `'unknown'` (statically permissive, same
as any other untyped position) and validated **at the call**, with a clear
runtime diagnostic (`E-RUN-003`) if the actual value isn't in the
supported set. This is a deliberate, narrow, and honestly-documented
exception to "NOVA prefers static checking" — not a general escape hatch.

### ABS always returns decimal
DECISION: `ABS`'s declared return type is `decimal` unconditionally, even
for an `integer` input — not "whatever type the input was." A
per-argument return type would need the same union/polymorphic machinery
just rejected above. Since `integer` already widens freely into `decimal`
contexts everywhere else in the language (§3, and symmetrically since the
v0.4 amendment), this costs nothing in practice: `ABS(-5)` displays as
`5`, not `5.0` (§14's minimal decimal display), and the result composes
normally with any further arithmetic.

## Consequences
- New module `src/stdlib/builtins.js` — the single source of truth for
  built-in signatures, consumed by both the analyzer (for static
  registration and checking) and the interpreter (for the actual native
  implementation).
- The analyzer's procedure table gains a `node: null` marker for built-ins
  (there's no `DO` AST node backing them) — every place that previously
  assumed `proc.node` exists for diagnostics (arity/argument-mismatch
  "declared here" spans) now guards for a built-in and omits that related
  span rather than crashing.
- New diagnostic: `E-RUN-003` (a built-in's runtime-checked argument isn't
  one of its supported types).
