# Sharif NOVA v0.1 — Core Language Specification

This specification covers Sharif NOVA, an independent programming language
and toolchain developed by Sharif Technologies, unrelated to other
same-named "Nova"/"NovaLang" language projects, editors, or products
elsewhere in the industry. It is referred to as NOVA throughout this
document.

Status: Implemented (this repository)
Scope: Language core only — the lexer, parser, AST, semantic analyzer, and
tree-walking interpreter for the Milestone-1 surface, plus ADR-002's `CHANGE`
keyword, which was adopted as part of v0.1 before implementation began.

This document is the specification that was frozen before any code was
written. See the ADRs in [docs/adr/](adr/) for the full rationale behind
each decision. Everything marked `DECISION` below is binding on this
implementation.

## 0. Document Conventions

- **DECISION** — settled, binding on the implementation.
- **RATIONALE** — why.
- **DEFERRED** — intentionally out of scope for v0.1; the extension point is noted.
- **OPEN QUESTION** — genuinely unresolved; flagged rather than guessed.

## 1. Source File Structure

DECISION: A NOVA source file is a UTF-8 encoded text file, conventionally
`.nova`. A file is a sequence of top-level statements, executed in order.
No mandatory top-level wrapper. An optional leading BOM is stripped by the
lexer.

DEFERRED: Module/file-level declarations (`USE`, imports, namespacing).

## 2. Lexical Structure

### 2.1 Case sensitivity
DECISION: Identifiers and keywords are case-sensitive. Keywords are
canonically uppercase (`SHOW`, `IF`, `END`); `if`, `Show`, etc. are **not**
keywords — they lex as ordinary identifiers.

### 2.2 Whitespace
DECISION: Space and tab are insignificant to parsing (ADR-001). Whitespace
separates tokens and is otherwise discarded, except inside string literals.

### 2.3 Statement termination
DECISION: A statement ends at a newline unless syntactically incomplete
(e.g. trailing binary operator). No semicolons. The lexer emits a `NEWLINE`
token used by the parser as a statement separator; `NEWLINE` plays no role
in block-matching (blocks are delimited solely by `END`, per ADR-001).

### 2.4 Comments
DECISION: `#` begins a comment that runs to end of line. No block comments.
Comments produce no token.

### 2.5 Identifiers
```
identifier         ::= identifier-start identifier-continue*
identifier-start    ::= letter | "_"
identifier-continue ::= letter | digit | "_"
letter              ::= "A".."Z" | "a".."z"
```
Case-sensitive; no length limit. ASCII only in v0.1 (Unicode identifiers:
OPEN QUESTION, deferred).

### 2.6 Keywords

DECISION: Reserved, with grammar in v0.1:
```
SET   CHANGE   SHOW   IF   ELSE   END
FOR   EACH   IN
REPEAT   TIMES
DO   RETURN
INPUT
TRUE   FALSE
AND   OR   NOT
```
(`CHANGE` added by ADR-002.)

DECISION — forward keyword reservation: the following are reserved but carry
**no grammar** in v0.1. Using them as identifiers is a lexical/semantic error
today, protecting the extension points named in §15 below:
```
DATA   PAGE   SCREEN   API   SERVICE   SECURITY   WHEN
USE   GO   TO   CREATE   GET   SAVE   DELETE   STYLE
```

### 2.7 Literals

**Numbers**
```
number-literal  ::= integer-literal | decimal-literal
integer-literal ::= digit+
decimal-literal ::= digit+ "." digit+
```
No negative literals (`-5` is unary minus applied to `5`). No digit
separators, no scientific notation in v0.1.

**Strings**
```
string-literal  ::= '"' string-character* '"'
escape-sequence ::= "\" ( '"' | "\" | "n" | "t" )
interpolation   ::= "{" identifier ("." identifier)* "}"
```
Double-quoted only. Unrecognized escapes are a lexical error. Interpolation
supports a bare identifier or one level of dotted field access only — **not**
arbitrary expressions (`{price * quantity}` is not supported in v0.1).
An unterminated string is a lexical error pointing at the opening quote.

**Booleans**: `TRUE` / `FALSE`, keyword literals of type `boolean`.

### 2.8 Operators and punctuation
DECISION: tokens are `= == != < > <= >= + - * / ( ) . ,`.
No `{ } [ ] ;`. `:` is tokenized but reserved/unused (future `DATA` field
types) — using it produces a clear "not yet supported" parse error.

### 2.9 Token stream
`IDENTIFIER, KEYWORD, INTEGER, DECIMAL, STRING, OPERATOR, PUNCTUATION,
NEWLINE, EOF`. Comments produce no token.

### 2.10 Invalid characters
DECISION: any character not covered above is a lexical error
(`Unexpected character '%c' at line L, column C`). Never silently skipped.

## 3. Primitive Types

| Type | Description | Literal example |
|---|---|---|
| integer | whole number | `42` |
| decimal | decimal number | `3.14` |
| text | UTF-8 string | `"hello"` |
| boolean | `TRUE`/`FALSE` | `TRUE` |

Plus an internal `NONE` value (a procedure that falls off the end of `END`
without `RETURN`), and a `list` runtime type with **no literal syntax** in
v0.1 — lists can only be provided by the host embedding for `FOR EACH` to
iterate.

DECISION — coercion: integer is implicitly promotable to decimal in mixed
arithmetic (`5 + 2.5` → decimal `7.5`). **No** implicit coercion between
text/boolean and numeric types — `"5" + 5` is a type error, not concatenation.

## 4. Values and Variables

### 4.1 SET
```
set-statement ::= "SET" identifier "=" expression
```
DECISION: `SET` both declares (if unbound in the current scope) and assigns.
No declaration-without-initialization. Re-`SET`ing an already-bound name in
the *same* scope is a plain reassignment, but must be type-compatible
(integer and decimal interoperate freely in both directions — consistent
with §3's arithmetic coercion already mixing them — and the variable's
tracked type becomes `decimal` from that point on; any other type change on
reassignment is a semantic error). This resolves §16's original open
question about reassignment compatibility: symmetric, not one-directional.

### 4.2 Undefined names
DECISION: referencing an unbound identifier is a semantic error (E-SEM-001),
detected at semantic-analysis time.

### 4.3 CHANGE (ADR-002)
```
change-statement ::= "CHANGE" identifier "=" expression
```
DECISION: `CHANGE` mutates an *existing* binding found by walking the scope
chain outward (starting at, and including, the current scope) — the exact
same resolution algorithm as an ordinary read. It **never** creates a
binding; `CHANGE` on an undefined name is a semantic error (E-SEM-006).
Subject to the same type-compatibility rule as `SET` reassignment.

`SET` and `CHANGE` are total opposites with no overlap:
- `SET` always writes to the *current* scope (creating if needed; shadowing
  an outer same-named binding rather than mutating it).
- `CHANGE` always writes to *wherever the name actually lives* (never
  creating).

This is what makes loop accumulation expressible:
```nova
SET total = 0
FOR EACH price IN prices
    CHANGE total = total + price
END
SHOW total
```

A `DO` procedure's scope chain terminates at global scope (§8.3), so
`CHANGE` inside a procedure can reach global variables but can never reach
into whatever local scope happened to call it — this falls out of ordinary
scope resolution with no special-casing.

## 5. Expressions

```
expression       ::= logical-or
logical-or       ::= logical-and ( "OR" logical-and )*
logical-and      ::= equality ( "AND" equality )*
equality         ::= comparison ( ( "==" | "!=" ) comparison )*
comparison       ::= additive ( ( "<" | ">" | "<=" | ">=" ) additive )*
additive         ::= multiplicative ( ( "+" | "-" ) multiplicative )*
multiplicative   ::= unary ( ( "*" | "/" ) unary )*
unary            ::= ( "NOT" | "-" ) unary | primary
primary          ::= literal
                    | identifier ( "." identifier )*
                    | call-expression
                    | "(" expression ")"
literal          ::= integer-literal | decimal-literal | string-literal
                    | "TRUE" | "FALSE"
call-expression  ::= identifier "(" ( expression ( "," expression )* )? ")"
```

Precedence (high → low): field access `.` (1) ; unary `-`/`NOT` (2) ;
`* /` (3) ; `+ -` (4) ; `< > <= >=` (5, non-chaining) ; `== !=` (6) ;
`AND` (7) ; `OR` (8).

DECISION: comparisons do **not** chain — `a < b < c` is a parse error, not
sugar for `a < b AND b < c`.

DECISION: `AND`/`OR` are keywords (not `&&`/`||`), both short-circuit.

DECISION: `==`/`!=` require both operands to be the same type; comparing
across types is a semantic error, not `FALSE`.

DECISION: operands, and call arguments, evaluate strictly left-to-right.

## 6. Statements

```
program   ::= statement* EOF
statement ::= show-statement | set-statement | change-statement
            | if-statement | for-each-statement | repeat-statement
            | do-declaration | return-statement | expression-statement
block     ::= statement*
```
`block` has no delimiter tokens of its own — delimiters belong to the
enclosing construct. An empty block is legal.

- `SHOW expression` — evaluate and print `display()` form to stdout.
- `SET`/`CHANGE` — §4.
- `IF`/`ELSE`/`ELSE IF` — §7.
- `FOR EACH id IN expr block END` — iterates a list value; loop variable
  freshly bound per iteration (§8.4); iterable evaluated exactly once.
- `REPEAT expr TIMES block END` — `expr` must be an integer; negative/zero
  counts run the body zero times (not an error).
- `DO`/`RETURN`/`INPUT` — §9.
- Expression statements — permitted at the grammar level (currently only
  meaningful for procedure-call side effects).

## 7. IF / ELSE / ELSE IF

```
if-statement ::= "IF" expression block else-clause? "END"
else-clause  ::= "ELSE" "IF" expression block else-clause
               | "ELSE" block
```

DECISION: `ELSE IF` is a **first-class AST field** — a flat, ordered list of
`(condition, body)` branch pairs plus an optional final `elseBranch` — never
desugared into nested `IfStatement`s, so diagnostics and tooling see one
decision with N branches, matching the developer's actual mental model.

DECISION: arbitrarily many `ELSE IF` clauses; `ELSE` must be last (the
grammar makes any other order unrepresentable — not a semantic check);
a second bare `ELSE` is a parse error; empty branches are legal.

DECISION: zero dangling-else ambiguity by construction — every `ELSE`/`ELSE
IF` belongs to the nearest still-open `IF`, because `END` and the explicit
else-clause grammar make it structural, not inferred.

## 8. Scope

DECISION: exactly three scope kinds, strict lexical nesting: global/module,
procedure, block. Name resolution is lexical, not dynamic.

- **8.1 Global scope** — every top-level `SET` binds here, visible
  everywhere below it, including inside procedure bodies.
- **8.2 Block scope** — `IF`/`ELSE IF`/`ELSE`/`FOR EACH`/`REPEAT` bodies
  each introduce a nested scope; a `SET` inside dies at that block's `END`.
- **8.3 Procedure scope** — a `DO` body's parent is **global** scope, not
  the call site. Procedures are not closures over caller locals — this is
  lexical (define-site) scoping, deliberately not dynamic scoping.
- **8.4 Loop variable scope** — `FOR EACH`'s loop variable gets a **fresh
  binding per iteration**, not one mutable binding reused across
  iterations (avoids the classic loop-capture bug family ahead of any
  future closures).
- **8.5 Shadowing** — a nested `SET` may reuse an outer name; it shadows
  for the inner scope's lifetime; the outer binding is unaffected and
  restored once the inner scope ends.
- **8.6 SET vs CHANGE** — see §4.3 / ADR-002. `SET` never reaches outward.
  `CHANGE` never creates. Reused, not overridden or special-cased, is the
  same resolution algorithm as reads — so `CHANGE` composes with shadowing
  by mutating whichever binding a plain read would currently resolve to.
- **8.7 Undefined names** — reading an unbound identifier is a semantic
  error, detected during semantic analysis wherever statically determinable
  (always, in v0.1).

## 9. Procedures — DO / RETURN / INPUT

```
do-declaration    ::= "DO" identifier input-declaration* block "END"
input-declaration ::= "INPUT" identifier
return-statement  ::= "RETURN" expression?
call-expression   ::= identifier "(" ( expression ("," expression)* )? ")"
```

DECISION: `INPUT` declarations must appear consecutively at the very start
of the procedure body — a grammar-level restriction, not a style rule.

DECISION: arguments bind to `INPUT` parameters positionally, in declaration
order; an arity mismatch is a semantic error.

DECISION: `RETURN expr` exits immediately with `expr`'s value. Bare `RETURN`
exits with `NONE`. Falling off the procedure's `END` is equivalent to an
implicit bare `RETURN` — not an error. `RETURN` outside any procedure body
is a semantic error (E-SEM-005). Recursion is permitted; nothing restricts
a `DO` from calling itself.

DEFERRED: multiple return values, named/default/variadic parameters,
parameter type annotations.

## 10. Source Locations

Every token carries `SourceLocation(line, column, offset)` — 1-based
line/column, 0-based absolute offset. Every AST node carries a
`SourceSpan(start, end)` covering its full source text. Diagnostics carry at
least one primary span, and may carry related spans (e.g. "opening IF was
here").

## 11. Diagnostics

Every diagnostic has: `severity, code, message, primarySpan, relatedSpans,
explanation?, suggestion?` — the WHAT / WHERE / WHY / HOW structure.

Implemented codes (see [src/diagnostics/codes.js](../src/diagnostics/codes.js)):

| Code | Meaning |
|---|---|
| E-LEX-001 | Unexpected character |
| E-LEX-002 | Unterminated string literal |
| E-LEX-003 | Unrecognized escape sequence |
| E-LEX-004 | Reserved word used as identifier |
| E-PARSE-001 | Unclosed block (missing END) |
| E-PARSE-002 | Unexpected END (no open block) |
| E-PARSE-003 | ELSE after ELSE (IF already has one) |
| E-PARSE-004 | Malformed FOR EACH (missing IN) |
| E-PARSE-005 | Malformed REPEAT (missing TIMES) |
| E-PARSE-006 | Generic "expected X, found Y" |
| E-SEM-001 | Undefined name |
| E-SEM-002 | Duplicate procedure declaration |
| E-SEM-003 | Type mismatch on SET reassignment |
| E-SEM-004 | Type error in operator |
| E-SEM-005 | RETURN outside a procedure |
| E-SEM-006 | CHANGE on an undefined name |
| E-SEM-007 | FOR EACH over a non-list value |
| E-SEM-008 | REPEAT count not an integer |
| E-SEM-009 | Call-expression arity mismatch |
| E-SEM-010 | Call to an undefined procedure |
| E-SEM-011 | Equality between mismatched types |
| E-SEM-012 | Duplicate field name in a record literal (v0.2, ADR-003) |
| E-RUN-001 | Division by zero |
| E-RUN-002 | No such field on a record (dotted field access / interpolation) |

## 12. AST — Complete v0.1 Node Summary

```
Program(statements: [Statement])

Statement =
    ShowStatement(value)
  | SetStatement(name, value)
  | ChangeStatement(name, value)
  | IfStatement(branches: [(condition, body)], elseBranch: Block|null)
  | ForEachStatement(loopVariable, iterable, body)
  | RepeatStatement(count, body)
  | ProcedureDeclaration(name, parameters: [Identifier], body)
  | ReturnStatement(value: Expression|null)
  | ExpressionStatement(expression)

Block = Statement*

Expression =
    IntegerLiteral(value) | DecimalLiteral(value)
  | StringLiteral(parts)  | BooleanLiteral(value)
  | Identifier(name)      | FieldAccess(target, field)
  | UnaryOp(operator, operand) | BinaryOp(operator, left, right)
  | CallExpression(callee, arguments)

# every node also carries: location: SourceSpan
```

RATIONALE: every node is intent-bearing, not syntax-bearing — the AST never
needs to know how something was spelled, only what it means.

## 13. Semantic Analysis

DECISION: a single pass, after parsing and before interpretation, performing
exactly: scope resolution, duplicate-declaration checks, the type checks in
§3/§4, control-flow validity (`RETURN` placement), and arity checking.

DECISION: analysis covers the **whole** AST before any statement executes —
a program with a semantic error anywhere is rejected before anything runs,
even a late error in an otherwise-long program. Fail fast, fail predictably.

## 14. Runtime Semantics (Interpreter)

DECISION: v0.1 ships a tree-walking interpreter over the validated AST —
an explicit starting strategy, not a permanent architectural commitment.

`display()` per type: integer → digits; decimal → minimal representation;
text → unquoted, interpolations resolved; boolean → `TRUE`/`FALSE`.

DECISION: `IfStatement` evaluates branches in order, running the first
whose condition is `TRUE`, else `elseBranch` if present, else nothing.

DECISION: division by zero is a runtime error (`Cannot divide by zero.`),
never `Infinity`/`NaN`.

## 15. Extension Points (for post-v0.1 work)

| Future construct | Where it plugs in | Already in place |
|---|---|---|
| DATA | new top-level Statement | `:` token reserved; block rule generic |
| PAGE / SCREEN | new top-level Statement | keywords reserved |
| API / SERVICE | new top-level Statement | keywords reserved |
| SECURITY | new top-level Statement | keyword reserved |
| WHEN (events) | statement usable in future contexts | keyword reserved |
| USE (modules) | new top-level statement | global/module scope already separated conceptually |
| List literals | widen `primary` | `list` runtime type already exists |
| Full-expression interpolation | widen `interpolation` production | already isolated from the rest of string lexing |

## 16. Open Questions

- Exact integer precision/overflow policy (arbitrary precision vs. fixed
  width with a hard error on overflow — this repo uses JS's native
  `number`/`BigInt` pragmatically; see `src/interpreter/values.js`).
- Unicode identifiers.
- Whether `NONE` gets a user-writable literal spelling.

## 17. Implementation Contract

An implementation is conformant iff it accepts and correctly executes every
construct in §2–§9 exactly as specified (including reserved-but-unused
keywords/punctuation producing a clear "not yet supported" diagnostic if
used), and rejects every violation listed in §11 with a diagnostic matching
the WHAT/WHERE/WHY/HOW shape — using **no** regex-based translation, textual
substitution, or line-based hacking; the pipeline is strictly
Source → Lexer → Tokens → Parser → AST → Semantic Analysis → Interpreter.

---

## v0.2 Amendments — List and Record Literals (ADR-003)

Status: Implemented (this repository). See
[docs/adr/ADR-003-list-record-literals.md](adr/ADR-003-list-record-literals.md)
for full rationale.

**§2.8 (amended)** — `[`, `]`, `{`, `}` are now tokens, in addition to
everything §2.8 already listed. `:` (already reserved since v0.1) is now
given real grammar as the `field: value` separator in a record literal.

**§5.1 (amended)** — `primary` gains two new alternatives:
```
primary       ::= literal | identifier ("." identifier)*
                 | call-expression | list-literal | record-literal
                 | "(" expression ")"
list-literal   ::= "[" ( expression ( "," expression )* ","? )? "]"
record-literal ::= "{" ( field-init ( "," field-init )* ","? )? "}"
field-init     ::= identifier ":" expression
```
A trailing comma before the closing bracket is permitted.

DECISION: list elements may be of **mixed types** — v0.1/v0.2 has no type
system capable of expressing "a list of integers," so nothing yet exists to
check homogeneity against (DEFERRED until typed lists exist).

DECISION: a record literal with a **repeated field name is a semantic
error** (`E-SEM-012`) — not "last value wins." Discarding an earlier field
silently is exactly the hidden behavior NOVA's philosophy rejects.

DECISION: postfix `.field` access now follows **any** primary expression
(a call, a list, a record, a parenthesized expression), not only
identifiers — `{ x: 1 }.x` and `makePoint().x` are both legal.

DECISION: `==`/`!=` structural equality (already defined for `list` in
v0.1) now also covers `record`: two records are equal iff they have the
same field names and every field's value is (recursively) equal.

New diagnostic:

| Code | Meaning |
|---|---|
| E-SEM-012 | Duplicate field name in a record literal |

Consequence worth calling out explicitly: `FOR EACH x IN [1, 2, 3]` and
`FOR EACH product IN [{ name: "Widget", price: 9.99 }]` now need **zero**
host injection — see [examples/catalog.nova](../examples/catalog.nova) for
the first fully self-contained `FOR EACH`-over-records example in this
repo's history.

Everything else in §1–§17 above is unchanged by v0.2.

---

## v0.3 Amendments — Typed Procedures (ADR-004)

Status: Implemented (this repository). See
[docs/adr/ADR-004-typed-procedures.md](adr/ADR-004-typed-procedures.md) for
full rationale.

**§9 (amended)** — parameter and return type annotations, both optional:
```
input-declaration ::= "INPUT" identifier ( ":" type-name )?
type-name          ::= identifier   # integer | decimal | text | boolean | list | record
do-declaration     ::= "DO" identifier ( "RETURNS" type-name )? input-declaration* block "END"
```
New keyword: `RETURNS`. Type names are ordinary identifiers, validated
against a fixed set (`E-SEM-016` if unrecognized) — no new keywords for the
type names themselves.

DECISION: fully backward compatible — omitting annotations keeps v0.1/v0.2
behavior (`'unknown'`, fully permissive) exactly as before.

DECISION: an annotated parameter's declared type is used for checks
*inside* the procedure body (not just at call sites) — the analyzer's
`infer()` for an `Identifier` naturally uses whatever type the parameter
was bound to.

DECISION: at a call site, each argument's inferred type must be compatible
with the declared parameter type (same integer→decimal widening rule as
`SET`/`CHANGE`, §4.1/§4.3) — mismatch is `E-SEM-015`.

DECISION: when `RETURNS type` is declared, every `RETURN` in the body must
give a compatible value (`E-SEM-013` if not, including a bare `RETURN`),
and the body must **definitely return** on every path or it's
`E-SEM-014`. "Definitely returns" is a deliberately conservative, sound
check: a statement list definitely returns iff any statement in it does; a
`RETURN` always does; an `IF` does only when it has an `ELSE` and every
branch (all `ELSE IF`s plus the final `ELSE`) definitely returns; `FOR
EACH`/`REPEAT` bodies **never** count, regardless of contents, because a
loop can run zero times. See ADR-004 for the full rationale — this may
reject some technically-safe procedures, but never accepts one that can
silently fall through to `NONE`.

DECISION: none of this is re-checked at runtime — per §13, a
semantically-validated program is trusted completely by the interpreter.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-013 | RETURN value doesn't match the declared RETURNS type (or is a bare RETURN when one is declared) |
| E-SEM-014 | Procedure declares RETURNS but doesn't return on every path |
| E-SEM-015 | Call argument type doesn't match the declared parameter type |
| E-SEM-016 | Unrecognized type name in an annotation |

Everything else in §1–§17 and the v0.2 amendments above is unchanged.

---

## v0.4 Amendments — DATA Named Types (ADR-005)

Status: Implemented (this repository). See
[docs/adr/ADR-005-data-named-types.md](adr/ADR-005-data-named-types.md) for
full rationale.

**§2.6 (amended)** — `DATA` moves from the forward-reserved list into real
grammar (the first of the six §2.6 placeholders to get one).

**§9/§12 (amended)** — a new top-level declaration and a widened
`type-name` production:
```
data-declaration ::= "DATA" identifier NEWLINE field-decl* "END"
field-decl        ::= identifier ":" type-name
type-name          ::= identifier   # a primitive, OR any DATA name (incl. itself)
```

DECISION: **zero new runtime concept** — a `DATA` type has no interpreter
representation distinct from the anonymous `record` it names (§3, §14
unchanged). This is purely an analysis-time naming layer.

DECISION: `DATA` names and procedure names are **separate namespaces** — a
`DATA Product` and `DO Product` can coexist.

DECISION: `DATA` names are pre-registered before any field types are
resolved (mirroring how procedure names are pre-registered for recursion),
so self-referencing (`DATA Node ... next: Node ... END`) and
forward-referencing types work regardless of declaration order.

DECISION: a record literal used **directly** where a specific `DATA` type
is expected (a typed parameter's argument, a typed `RETURN`'s value) is
checked for an **exact** field match — no missing fields (`E-SEM-018`), no
extra fields (`E-SEM-020`), and every field's value type-compatible with
its declared type (`E-SEM-019`). Away from that point of direct
construction, NOVA stays structurally typed as before: any `'record'`
value can flow through generic record-typed positions, and (§4.1/§4.3
amended) a generic `'record'` may flow into a `DATA`-typed slot and back
— but two *different* `DATA` types remain incompatible with each other.

DECISION: once a value's static type is a known `DATA` name, `.field`
access — and `{value.field}` interpolation — is checked statically and
returns the field's own declared type instead of `'unknown'`
(`E-SEM-021` if the field doesn't exist). This is the actual payoff of
`DATA`; everywhere a value's exact shape isn't statically visible, field
access stays exactly as permissive as v0.1–v0.3.

**Correctness fix picked up along the way**: §4.1's integer/decimal
reassignment widening is **symmetric**, not the one-directional rule
originally stated — a `decimal`-tracked variable freely accepts a later
`integer` reassignment too (and vice versa), consistent with §3's
arithmetic coercion already mixing the two freely. See §4.1 above.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-017 | Duplicate DATA type name |
| E-SEM-018 | Record literal is missing a field a DATA type requires |
| E-SEM-019 | Record literal field's type doesn't match the DATA type's declared field type |
| E-SEM-020 | Record literal has a field the DATA type doesn't declare |
| E-SEM-021 | Static `.field` access naming a field that doesn't exist on a known DATA type |

Everything else in §1–§17 and the v0.2/v0.3 amendments above is unchanged.

---

## v0.5 Amendments — Persistence: SAVE / GET / DELETE (ADR-006)

Status: Implemented (this repository). See
[docs/adr/ADR-006-persistence.md](adr/ADR-006-persistence.md) for full
rationale.

**§2.6 (amended)** — `SAVE`, `GET`, `DELETE` move from forward-reserved
into real grammar.

**New grammar**:
```
save-expression  ::= "SAVE" expression
get-expression    ::= "GET" identifier
delete-statement  ::= "DELETE" identifier expression
```
`SAVE`/`GET` are expression-level (usable anywhere an expression is valid,
e.g. `SET id = SAVE ...`, `FOR EACH p IN GET Product`); `DELETE` is a
statement.

DECISION: one in-memory collection per `DATA` type, alive only for the
current process (no durability — a later milestone). `SAVE <expr>`
requires `expr`'s *specific* `DATA` type to be statically known — plain
`'record'` and even `'unknown'` are rejected (`E-SEM-022`), a deliberate
exception to NOVA's usual unknown-is-permissive rule, since the target
collection has no runtime fallback to derive it from. `SAVE` returns a
fresh per-type `integer` id (starting at 1) and is the only way to obtain
one — the id is bookkeeping the *store* keeps, not a field injected into
the record's own shape (`DATA`'s exact-shape guarantee, ADR-005, is
preserved).

DECISION: `GET TypeName` returns every currently-saved record of that
type, oldest first, as a `list` — no `id` attached, no filtering yet
(`E-SEM-023` if `TypeName` isn't a known `DATA` type). `WHERE`-style
filtering is intentionally deferred.

DECISION: `DELETE TypeName idExpr` is **idempotent** — removing an id
that's already gone is a silent no-op, not an error (`E-SEM-024` for an
unknown type, `E-SEM-025` if the id expression isn't an integer).

Consequence worth calling out: because `SAVE` needs a *specific* static
`DATA` type and a bare record literal only gets one when checked against an
expected type (ADR-005), `SAVE { ... }` directly on a literal doesn't
type-check — the literal has to pass through a typed `INPUT` or `RETURNS`
position first (see `examples/persistence.nova`). This is the direct,
foreseeable consequence of ADR-005's own deferred "no named-constructor
syntax" item meeting persistence's need for an unambiguous target.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-022 | SAVE's operand isn't a value of a specific, known DATA type |
| E-SEM-023 | GET names a type that isn't a declared DATA type |
| E-SEM-024 | DELETE names a type that isn't a declared DATA type |
| E-SEM-025 | DELETE's id expression isn't an integer |

Everything else in §1–§17 and the v0.2/v0.3/v0.4 amendments above is
unchanged.

---

## v0.6 Amendments — A Small Standard Library (ADR-007)

Status: Implemented (this repository). See
[docs/adr/ADR-007-standard-library.md](adr/ADR-007-standard-library.md) for
full rationale.

Six built-ins, called with **exactly** the same syntax as a `DO` procedure
— no separate "builtin call" form:

| Name | Signature | Behavior |
|---|---|---|
| `UPPER` | `(text) RETURNS text` | Uppercase |
| `LOWER` | `(text) RETURNS text` | Lowercase |
| `TRIM` | `(text) RETURNS text` | Strip leading/trailing whitespace |
| `LENGTH` | `(unknown) RETURNS integer` | Length of `text` or `list`; `E-RUN-003` otherwise |
| `ROUND` | `(unknown) RETURNS integer` | Nearest integer to a number; `E-RUN-003` otherwise |
| `ABS` | `(unknown) RETURNS decimal` | Absolute value of a number; `E-RUN-003` otherwise |

DECISION: built-ins occupy the **same procedure namespace** as user `DO`
declarations — a `DO UPPER ... END` collides with the built-in exactly
like redeclaring any other procedure (`E-SEM-002`), not silent shadowing.

DECISION: `UPPER`/`LOWER`/`TRIM` have a real, statically-checked `text`
parameter type, exactly like a user-typed procedure. `LENGTH`/`ROUND`/
`ABS` are typed `'unknown'` and checked **at the call** instead — NOVA has
no union/polymorphic type-annotation syntax, and these three are the only
places genuinely needing one; adding that machinery for three built-ins
was declined for the same reason ADR-003 declined full string-
interpolation expressions (real complexity for a narrow, not-yet-broadly-
needed case). New diagnostic `E-RUN-003` covers the runtime check.

DECISION: `ABS` always declares return type `decimal`, even for an
`integer` input — costs nothing given `integer` already widens into
`decimal` contexts everywhere (§3), and avoids inventing a per-argument
return type just for this one builtin.

Everything else in §1–§17 and the v0.2–v0.5 amendments above is unchanged.

---

## v0.7 Amendments — ASK: Real Input (ADR-008)

Status: Implemented (this repository). See
[docs/adr/ADR-008-ask-input.md](adr/ADR-008-ask-input.md) for full
rationale.

**New grammar**: `ask-expression ::= "ASK" expression`. New keyword `ASK`.

DECISION: `ASK <expr>` writes `expr`'s `display()` form as a prompt with
**no trailing newline**, then blocks reading one real line of input,
returned as `text`. `ASK`'s static type is always `text` — there is still
no `text`→number parsing builtin (DEFERRED), so using an `ASK` result
arithmetically without one fails with the ordinary `E-SEM-004` operator
type error, same as any other text-plus-number mistake.

DECISION: input is read **lazily, on demand** — never eagerly at program
start. A program that never calls `ASK` never touches stdin at all; this
is what keeps every example and test written before this milestone
unaffected. Implemented as a small zero-dependency synchronous line reader
(`src/interpreter/stdin.js`) over `fs.readSync(0, ...)`, not a "slurp all
of stdin up front" shortcut.

DECISION: `ASK` called after input is exhausted is a runtime error
(`E-RUN-004`), not a silently-returned empty string or `NONE` — an empty
string needs to stay distinguishable from "no more input," matching how
every other runtime-only condition in NOVA (`E-RUN-001`, `E-RUN-002`) gets
a loud diagnostic instead of a quiet fallback.

New diagnostic:

| Code | Meaning |
|---|---|
| E-RUN-004 | ASK called with no input left (stdin exhausted) |

Everything else in §1–§17 and the v0.2–v0.6 amendments above is unchanged.

---

## v0.8 Amendments — List Indexing and Mutation (ADR-009)

Status: Implemented (this repository). See
[docs/adr/ADR-009-list-indexing-mutation.md](adr/ADR-009-list-indexing-mutation.md)
for full rationale.

**§5.1 (amended)** — postfix `[expression]` generalizes the same
mechanism `.field` already uses (ADR-003): it follows *any* primary, and
the two chain freely (`a[0].b[1]`).

**§6.1/§4.3 (amended)** — `CHANGE` gains an optional index chain:
```
change-statement ::= "CHANGE" identifier ( "[" expression "]" )* "=" expression
```

DECISION: mutation reuses `CHANGE`, not `SET`, and no new keyword —
mutating an existing list's element is, by ADR-002's own established
distinction, always a mutation of something that already exists, never a
declaration. `CHANGE products[0] = "..."` is the same rule (`CHANGE`
mutates an existing binding via the same scope-chain walk as a read)
reaching one level deeper, not a new rule.

DECISION: **lists are reference types** — assigning a list to another
variable, or passing it as an argument, shares the same underlying
storage; `CHANGE` on one is visible through every alias. This was already
true of the interpreter's internal representation since v0.2; this
amendment makes it an explicit, documented language property.

DECISION: `list[i]`'s static type stays `'unknown'` (no element-type
tracking, per ADR-003's still-unchanged deferral). What *is* checked
statically: the target must be `'list'`/`'unknown'` (`E-SEM-026`
otherwise) and the index must be `'integer'`/`'unknown'` (`E-SEM-027`
otherwise); genuinely unknown-until-runtime cases fall through to a
runtime check instead (`E-RUN-006`/`E-RUN-007`).

DECISION: index `0` is the first element; anything `< 0` or `>= LENGTH`
is a runtime error (`E-RUN-005`) — no negative/from-the-end indexing yet
(DEFERRED; purely additive to add later). Indexed `CHANGE` skips the
ordinary same-type reassignment check, since list elements may be mixed
types and there is no single tracked type to check against.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-026 | Indexing (`[ ]`) a value whose type is definitely not a list |
| E-SEM-027 | A list index whose type is definitely not an integer |
| E-RUN-005 | Index out of bounds |
| E-RUN-006 | Runtime fallback of E-SEM-026, for an 'unknown'-typed value |
| E-RUN-007 | Runtime fallback of E-SEM-027, for an 'unknown'-typed index |

Everything else in §1–§17 and the v0.2–v0.7 amendments above is unchanged.

---

## v0.9 Amendments — Error Handling: TRY / CATCH (ADR-010)

Status: Implemented (this repository). See
[docs/adr/ADR-010-error-handling.md](adr/ADR-010-error-handling.md) for
full rationale.

**New grammar**: `try-statement ::= "TRY" block "CATCH" identifier block
"END"`. New keywords `TRY`, `CATCH` (`CATCH` is mandatory — no bare `TRY`).

DECISION: `TRY`/`CATCH` can only ever observe **runtime** errors
(`E-RUN-*`) — a structural consequence of §13's existing fail-fast design
(the whole program is rejected before any statement executes on any
lexical/syntactic/semantic error), not an arbitrary restriction layered on
top.

DECISION: `CATCH error` binds `error` to the failed diagnostic's message,
as `text` — the smallest useful shape, consistent with `ASK` also being
`text`-only in its first version (ADR-008). No error code/kind to match
on, and no re-throw, yet (DEFERRED).

DECISION: only genuine `NovaError`s are caught. A `RETURN`'s control-flow
signal, and any plain (non-`NovaError`) exception — which in this codebase
only ever means an actual interpreter bug — both pass straight through
uncaught. A user's `TRY` can never mask a real implementation bug as an
ordinary, anticipated failure.

DECISION: `TRY`/`CATCH` extends ADR-004's "definitely returns" check the
same way `IF`/`ELSE` does — a `TRY` statement counts as definitely
returning only when *both* its `TRY` body and its `CATCH` body definitely
return, which is sound because exactly one of the two always finishes
running (unlike a loop body, which may run zero times).

No new diagnostics — `TRY`/`CATCH` only changes what happens when an
already-existing runtime error fires inside it.

Everything else in §1–§17 and the v0.2–v0.8 amendments above is unchanged.

---

## v0.10 Amendments — PAGE: a Static HTML Compiler (ADR-011)

Status: Implemented (this repository). See
[docs/adr/ADR-011-static-page-compiler.md](adr/ADR-011-static-page-compiler.md)
for full rationale.

**§2.6 (amended)** — `PAGE`, `STYLE` move from forward-reserved into real
grammar. New keywords: `TITLE`, `HEADING`, `TEXT`.

**New top-level declaration**:
```
page-declaration ::= "PAGE" string-literal NEWLINE page-element* "END"
page-element      ::= ("TITLE" | "STYLE" | "HEADING" | "TEXT") expression
```

DECISION: `PAGE` is a declaration, not code — inert during `nova run`,
exactly like `DATA`/`DO`. A **new command**, `nova build <file>.nova`,
reads `PAGE` declarations and writes HTML files to `dist/` next to the
source (`nova build` never executes the file's ordinary statements, the
mirror image of `nova run` never touching `PAGE` content). One `.nova`
file can hold both a runnable script and page content side by side.

DECISION: every `page-element`'s value must be a **literal** (no
identifiers, calls, or interpolated strings) — `PAGE` is compiled, never
executed, so there is no running program state for anything else to
resolve against (`E-SEM-030`). Data-bound content is explicitly the next
milestone's job, not a partial answer squeezed into this one.

DECISION: `TITLE` (at most one, `<title>`), `STYLE` (any number, raw CSS
text — must be `text`, `E-SEM-031` — concatenated into one `<style>`
block), `HEADING` (`<h1>`), `TEXT` (`<p>`, may repeat, renders in
declaration order interleaved with `HEADING`). Text content is
HTML-escaped; `STYLE` content is not (it isn't HTML text). No heading
levels, layout containers, links, images, or lists yet (DEFERRED — this is
"enough to render a genuine page," not a layout system).

DECISION: a `PAGE`'s string literal is its route, and must start with `/`
(`E-SEM-029`); routes must be unique within a file (`E-SEM-028`). `nova
build` maps a route straight to a file path — `/` → `dist/index.html`,
`/about` → `dist/about.html`, `/products/list` →
`dist/products/list.html` — no routing configuration to learn.

**Lexer fix picked up along the way**: a `{` inside any string literal
that isn't immediately followed by a valid `identifier(.identifier)*}`
path is now literal text, not a lexical error — needed for raw CSS in
`STYLE` (`"body { color: red; }"` previously failed to lex, in *any*
string, since v0.1), implemented as a backtracking lookahead in the string
scanner. Genuine `{name}`/`{a.b}` interpolation is completely unaffected.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-028 | Duplicate PAGE route within one file |
| E-SEM-029 | PAGE route missing its leading `/` |
| E-SEM-030 | Non-literal PAGE content (PAGE is never executed) |
| E-SEM-031 | STYLE given a non-text value |

Everything else in §1–§17 and the v0.2–v0.9 amendments above is unchanged.

---

## v0.11 Amendments — Data-Bound PAGE (ADR-012)

Status: Implemented (this repository). See
[docs/adr/ADR-012-data-bound-pages.md](adr/ADR-012-data-bound-pages.md)
for full rationale.

**§ADR-011 grammar (amended)** — `page-element` gains a recursive
`FOR EACH` variant:
```
page-element ::= ("TITLE"|"STYLE"|"HEADING"|"TEXT") page-content
               | "FOR" "EACH" identifier "IN" "GET" identifier NEWLINE page-element* "END"
page-content  ::= literal | loop-variable ("." identifier)+
```
No new keywords — `FOR`/`EACH`/`IN` (§6.5) and `GET` (ADR-006) are reused
with exactly their existing meaning, the same move ADR-009 made reusing
`CHANGE` for indexed mutation.

DECISION: `nova build` now works like a conventional **static site
generator** — it runs the file's ordinary statements once, **silently**
(`SHOW`/`ASK`-prompt output suppressed; an `ASK` call still blocks on real
input exactly as `nova run` would, not special-cased), letting `SAVE`
calls (ADR-006) populate the store, and only then compiles `PAGE`
content. The output reflects data as of build time — nothing is
"live"; there is no server yet to make that claim honest.

DECISION: inside a `PAGE`-level `FOR EACH`, content may be a literal (as
before, ADR-011) **or** a field-access chain rooted at the loop variable
(`product.name`) — nothing else. The field is checked against the real
`DATA` shape, reusing the exact static-field-checking machinery ordinary
`.field` access already has (ADR-005) — an unknown field is `E-SEM-021`,
an unknown `DATA` type in `GET` is `E-SEM-023`, both reused directly, not
duplicated.

DECISION: `TITLE`/`STYLE` remain top-level-only (`E-SEM-032` inside a
`FOR EACH` — repeating a title or stylesheet per record has no meaning);
`HEADING`/`TEXT` may nest at any depth and render in the loop body's
written order, once per fetched record, in save order (`GET`'s existing
oldest-first order, ADR-006) — an empty collection renders nothing, not
an error.

New diagnostic:

| Code | Meaning |
|---|---|
| E-SEM-032 | TITLE or STYLE used inside a PAGE-level FOR EACH |

Everything else in §1–§17 and the v0.2–v0.10 amendments above is
unchanged.

---

## v0.12 Amendments — Interactive PAGE: BUTTON / WHEN CLICKED (ADR-013)

Status: Implemented (this repository) — **the last originally-planned
milestone**. See
[docs/adr/ADR-013-interactive-pages.md](adr/ADR-013-interactive-pages.md)
for full rationale.

**New grammar**:
```
page-element ::= ... (ADR-011/012, unchanged)
               | "SET" identifier "=" literal
               | "BUTTON" expression NEWLINE "WHEN" "CLICKED" block "END" NEWLINE "END"
```
New keywords `BUTTON`, `CLICKED`; `WHEN` graduates from forward-reserved
(§2.6) into real grammar.

DECISION: a `SET` at a `PAGE`'s top level declares **page-local state** —
initialized from a literal, mutable only via `CHANGE` inside a `WHEN
CLICKED` block. The exact same `SET`-declares/`CHANGE`-mutates split
ADR-002 established, applied a third time (after ADR-009's list elements)
to a third kind of storage — not a new rule.

DECISION: a `WHEN CLICKED` block parses as an **ordinary** statement block
(any statement syntactically valid) — what's actually *allowed* there is
a semantic restriction, not a parser one: every statement must be
`CHANGE <pageLocalState> = <safe expression>` (`E-SEM-034` for any other
statement kind, `E-SEM-035` if the target isn't page-local state,
`E-SEM-036` for an indexed target). A safe expression is a literal, a
page-local-state reference, or `+ - * / == != < > <= >= AND OR NOT`
combining safe expressions — never a call, `SAVE`/`GET`/`ASK`, field/
index access, or a list/record literal (`E-SEM-037`, checked by a
dedicated structural pass, `assertNoUnsafeConstructs`, kept deliberately
separate from type-checking — see the ADR for why that split matters).

DECISION: `BUTTON` is top-level only (`E-SEM-038` inside `FOR EACH` — a
button per rendered record needs to know which record, a real question
left to a later milestone).

DECISION: `nova build` emits one `<script>` per interactive page — a
`state` object, a `render()` updating every state-bound element's
`textContent` (never `innerHTML`, so no HTML-escaping is needed for these
updates specifically), and one named function per `BUTTON`. Verification
executes the generated script against a DOM stub and calls the button
functions programmatically, asserting on the resulting state and DOM
text — not a string match.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-033 | Duplicate page-local state name |
| E-SEM-034 | A non-CHANGE statement inside WHEN CLICKED |
| E-SEM-035 | A CHANGE target inside WHEN CLICKED that isn't page-local state |
| E-SEM-036 | An indexed CHANGE target inside WHEN CLICKED (state is scalar-only) |
| E-SEM-037 | An unsafe construct (call, SAVE/GET/ASK, field/index access, list/record literal) inside a click handler |
| E-SEM-038 | BUTTON used inside FOR EACH (not yet supported) |

Everything else in §1–§17 and the v0.2–v0.11 amendments above is
unchanged. **This completes every milestone in the v0.1–v0.12 roadmap.**

---

## v0.13 Amendments — SERVICE / API: a Live HTTP Server (ADR-014)

Status: Implemented (this repository) — the first milestone past the
v0.1–v0.12 roadmap. See
[docs/adr/ADR-014-service-api.md](adr/ADR-014-service-api.md) for full
rationale.

**§2.6 (amended)** — `SERVICE`, `API` move from the forward-reserved list
into real grammar (`GET` is reused verbatim from ADR-006 for the HTTP
verb, not a new keyword).

**New grammar**:
```
top-level-statement ::= ... (unchanged) | service-declaration
service-declaration ::= "SERVICE" NEWLINE api-declaration* "END"
api-declaration      ::= "API" "GET" string-literal NEWLINE statement* "END"
```

DECISION: smallest correct version — only the `GET` HTTP method is
supported in v0.13; the grammar itself accepts only that literal keyword
after `API` (any other word is a plain parse error, not a semantic one —
there's no partial write-verb support yet to report a nicer diagnostic
about). Every write verb (`POST`/`PUT`/`DELETE`) needs a request-body
story that's a genuinely separate design question, deferred exactly the
way ADR-011 deferred variables out of `PAGE` content until ADR-012.

DECISION: an API route must start with `/` (`E-SEM-040`, the same rule
ADR-011 gives `PAGE`) and may not contain string interpolation. Two `API`
declarations may not share the same method+route pair (`E-SEM-039`,
modeled directly on `DUPLICATE_PAGE_ROUTE`), checked globally across every
`SERVICE` block in the file — they all end up in one process's routing
table at `nova serve` time.

DECISION: an API handler's body is an **ordinary** statement block,
type-checked by reusing the exact same machinery a `DO` procedure body
already has (a child of global scope, `RETURN` valid, no declared return
type so `definitelyReturns` is not required — a handler that never hits
`RETURN` responds with NONE, serialized as JSON `null`). Unlike `WHEN
CLICKED` (ADR-013), this is deliberately **not** sandboxed: `SAVE`, `GET`,
`DELETE`, and procedure calls are all genuine, unrestricted server-side
code, because (unlike a `PAGE` compiled to a stranger's browser) there is
no new trust boundary being crossed here — this is exactly where
`SAVE`/`GET`/`DELETE` already run today. The one narrow exception:
`ASK` is rejected directly inside a handler's own statements (`E-SEM-041`)
— it blocks on real stdin (ADR-008), and a live server has no per-request
terminal to read from, so every request would hang forever. This check is
shallow by design (it does not follow calls into procedures a handler
invokes) — a real, bounded, and explicitly named limitation, not a silent
gap (see the ADR).

DECISION: `nova serve <file>.nova [port]` (default port 3000) runs the
file's top-level statements once, silently — identical to `nova build`'s
existing "populate SAVE'd data" step (ADR-011/012) — and then starts a
real Node `http` server (`src/apiserver/serve.js`, zero dependencies) that
keeps the **same interpreter instance**, and so the same persistence
store, alive across every subsequent request. A `SAVE` from one request is
visible to a `GET` in the next, and every request after that, for as long
as the process runs — this is what makes "live" genuinely honest, in
contrast to `PAGE`/`nova build`'s one-shot, build-time-only snapshot
(ADR-012), which this ADR leaves completely unchanged. Routing is a flat,
exact-match `"<METHOD> <route>"` table (no path parameters, no
query-string parsing — deferred). An unmatched method+path is a `404`
with a JSON error body. A handler that raises a genuine NOVA runtime error
is a `500` with the diagnostic message as JSON, without crashing the
server; any other exception (an actual interpreter bug) is left to
propagate, matching `TryStatement`'s own existing rule (ADR-010).

DECISION: a NOVA runtime value becomes a JSON HTTP response body via a
small, total mapping (`integer`/`decimal`/`text`/`boolean` pass through as
the matching JS type; `list` maps element-wise; `record` maps its fields,
recursively; `none` becomes JSON `null`) — the JSON-audience analogue of
`display()` (§14).

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-039 | Duplicate API method+route |
| E-SEM-040 | API route not starting with "/" |
| E-SEM-041 | ASK used directly inside an API handler body |
| E-SEM-044 | SERVICE declared somewhere other than a file's top level |

**Post-launch fix**: a `SERVICE` nested inside `IF`/`DO`/`FOR EACH`/
`REPEAT`/`TRY` parsed and analyzed without error, but `collectApiRoutes`
only ever walks genuine top-level statements — the nested block compiled
into no route at all, so `nova serve` booted clean and every request
against it silently 404'd, with no compile-time signal about why.
`E-SEM-044` closes this: `SERVICE` is now rejected wherever it isn't a
true top-level declaration, the same "must be top level" treatment
`PAGE_TITLE_STYLE_NOT_TOP_LEVEL` already gives `TITLE`/`STYLE`/`SET`
inside a `PAGE`-level `FOR EACH`. Also fixed alongside it: request-path
matching now decodes percent-encoding before the routing-table lookup — a
route literal with non-ASCII or reserved characters (e.g. `API GET
"/café"`) previously could never match a real client's request, since a
standards-compliant client percent-encodes such characters on the wire
(`/caf%C3%A9`) and `url.pathname` does not decode that back.

Everything else in §1–§17 and the v0.2–v0.12 amendments above is
unchanged — `PAGE`/`nova build` in particular are completely untouched by
this milestone.

---

## v0.14 Amendments — API POST and REQUEST AS: Reading the Request Body (ADR-015)

Status: Implemented (this repository) — continues directly from ADR-014's
own explicitly-deferred write-verb work. See
[docs/adr/ADR-015-api-post-request-body.md](adr/ADR-015-api-post-request-body.md)
for full rationale.

**§2.6 (amended)** — three new keywords: `POST`, `REQUEST`, `AS` (none
were previously forward-reserved — the same "introduce a genuinely new
keyword when needed" precedent ADR-013 set with `BUTTON`/`CLICKED`).

**New grammar**:
```
api-declaration ::= "API" ("GET"|"POST") string-literal NEWLINE
                     statement* "END"
primary         ::= ... | "REQUEST" "AS" identifier
```

DECISION: `API` now accepts `POST` alongside `GET` (still only those two —
`PUT`/`DELETE` remain deferred, each raising its own distinct design
question). `REQUEST AS <DataType>` is a new expression that evaluates to
the current POST request's JSON body, validated against `<DataType>`'s
declared fields — the same "does this value match this `DATA` shape"
question `checkRecordLiteralAgainstDataType` (ADR-005) already answers for
a record literal, applied to a value only known at request time instead of
written in the source file. Its static type is `<DataType>` itself, so
`SAVE`/`RETURN` afterward work unchanged.

DECISION: `REQUEST` is valid only lexically inside a `POST` handler's own
body — not a `GET` handler, not a `DO` procedure another handler calls,
not a file's top level (`E-SEM-042`). Because `ProcedureDeclaration`
bodies are analyzed exactly once, at their own declaration, never
re-entered from a call site, this restriction is fully sound (unlike
ADR-014's shallow, explicitly-limited `ASK` check).

DECISION: every field of `<DataType>` used with `REQUEST AS` must be
`integer`/`decimal`/`text`/`boolean` (`E-SEM-043`) — a nested `DATA` type,
`list`, or `record` field would need a recursive (and, for `list`, an
element-typed) validation story out of scope here, deferred the same way
ADR-011 deferred variables out of `PAGE` content until ADR-012.

DECISION: at runtime, the request body must be a JSON object matching
every declared field's presence and JS type (`E-RUN-008` if it isn't an
object at all; `E-RUN-009` naming the specific missing/mismatched field).
Extra fields beyond the `DATA` type's own are silently ignored — more
forgiving than `RecordLiteral`'s exact-match rule, since a request body
comes from a client NOVA doesn't control, unlike a literal the developer
wrote. `E-RUN-008`/`E-RUN-009` specifically map to HTTP `400` (the
client's fault), unlike every other runtime error reaching `nova serve`
(`500`, unchanged from ADR-014).

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-042 | REQUEST used outside an API POST handler's own body |
| E-SEM-043 | REQUEST AS a DATA type with a non-integer/decimal/text/boolean field |
| E-RUN-008 | POST request body is not a JSON object |
| E-RUN-009 | POST request body is missing a field, or a field's type doesn't match |

Everything else in §1–§17 and the v0.2–v0.13 amendments above is
unchanged — `API GET` and `PAGE`/`nova build` in particular are completely
untouched by this milestone.

---

## v0.15 Amendments — PAGE/SERVICE Integration: BUTTON in a Loop, CALL API, and Serving Pages Live (ADR-016)

Status: Implemented (this repository). See
[docs/adr/ADR-016-page-service-integration.md](adr/ADR-016-page-service-integration.md)
for full rationale.

**§2.6 (amended)** — two new keywords: `CALL`, `WITH` (neither was
previously forward-reserved).

**New grammar**:
```
statement            ::= ... (unchanged) | call-api-statement
call-api-statement    ::= "CALL" "API" ("GET"|"POST") string-literal
                           ( "WITH" record-literal )?
```
`call-api-statement` parses generically (any statement position), the
same "parse generically, restrict semantically" precedent ADR-013 already
set for `WHEN CLICKED`'s own body.

DECISION: `nova serve` now compiles every `PAGE` declaration once at
startup — the same timing and store snapshot `nova build` already uses
(ADR-012's build-time-snapshot model is unchanged; a page does not
recompile per request) — and serves the result for `GET` requests that
don't match a declared `API`. `nova build`'s file-writing behavior is
completely unchanged; this only adds a second, in-memory way to reach the
same compiled HTML from the live server. Because a `PAGE` route and an
`API GET` route can now collide on one server, that's a new compile-time
error (`E-SEM-048`) rather than a silent routing ambiguity.

DECISION: `BUTTON` is now allowed inside `FOR EACH` — the v0.12 amendment
above (`E-SEM-038`, "not supported yet") is retired (the code stays
defined, per this codebase's convention of never reusing a diagnostic
code for a different meaning). A per-record button's label and click
handler data are both resolved against the concrete bound record at PAGE
**compile time**, the exact same mechanism a data-bound `HEADING`/`TEXT`
already uses (ADR-012) — no new runtime "which record" tracking exists,
or is needed.

DECISION: `CALL API` is valid **only** inside a `BUTTON`'s `WHEN CLICKED`
block; found anywhere else (top level, a `DO` body, an `API` handler
body), it's rejected (`E-SEM-045`) the moment ordinary statement checking
reaches it — a legitimate one is only ever visited through the
button-action path, never through ordinary statement dispatch. Its
method+route must match a real `API` declared somewhere in the same file,
checked against the exact routing map `registerService` (ADR-014) already
builds — an unmatched method+route is `E-SEM-046`. A `WITH` payload's
fields follow the same restricted shape any page-element value already
has (ADR-012/013): a plain literal, page-local state, or a field access
rooted at an enclosing `FOR EACH`'s loop variable, checked against the
real `DATA` shape — anything else is `E-SEM-047`.

DECISION, explicitly deferred: a `CALL API` payload's *shape* is not
statically cross-checked against the target handler's own
`REQUEST AS <DataType>` field list — that's real, separate work (tracing
which `DATA` type an arbitrary declared route's handler binds). A mismatch
is instead caught the same way it already is for any other client: at
runtime, by the existing `E-RUN-008`/`E-RUN-009` checks (ADR-015),
surfacing to the page as an ordinary failed request.

DECISION: a button whose actions include a `CALL API` compiles to an
`async` click-handler function; a button with only `CHANGE` actions is
completely unaffected (byte-for-byte the same synchronous function
ADR-013 already produced). The button element gains a stable `id` so its
own generated function can reach back into the DOM: on click it disables
itself, `await fetch()`s the declared route, and on a non-OK response
throws, caught by the same handler. On success the button's own label
becomes a fixed `"Done"`; on failure, a fixed `"Failed - try again"`, and
it re-enables. No syntax yet exists for a developer-chosen success/failure
label (DEFERRED, the same "smallest correct version first" ADR-013 itself
shipped with).

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-045 | CALL API used outside a BUTTON's WHEN CLICKED body |
| E-SEM-046 | CALL API references a method+route no API in this file declares |
| E-SEM-047 | A CALL API WITH payload field isn't a literal, page-local state, or a valid loop-variable field reference |
| E-SEM-048 | A PAGE route collides with an API GET route (nova serve now serves both from one server) |

`E-SEM-038` (`BUTTON_INSIDE_LOOP_NOT_SUPPORTED`) is retired, not reused.

Everything else in §1–§17 and the v0.2–v0.14 amendments above is
unchanged — a `PAGE` with no `BUTTON`-in-loop and no `CALL API`, and
`nova build` itself, keep their exact current behavior.

---

## v0.16 Amendments — FORM / INPUT: Collecting Real User Input (ADR-017)

Status: Implemented (this repository). See
[docs/adr/ADR-017-page-forms.md](adr/ADR-017-page-forms.md) for full
rationale.

**§2.6 (amended)** — one new keyword: `FORM`. `INPUT` is reused verbatim
(the same keyword `DO` parameters already use).

**New grammar**:
```
page-element ::= ... (unchanged) | form-element
form-element ::= "FORM" NEWLINE page-element* "END"
form-input   ::= "INPUT" identifier ":" type-name string-literal?
```
`INPUT` is parsed generically, as one more `page-element` (the same
"parse generically, restrict semantically" precedent `CALL API` and
`WHEN CLICKED`'s body already use) — "INPUT outside a FORM" is a semantic
error (`E-SEM-049`), not a parser-level restriction.

DECISION: an `INPUT`'s type must be `integer`/`decimal`/`text`/`boolean`
— the same restriction `REQUEST AS <DataType>` already places on its own
fields (ADR-015), for the same reason: a real HTML `<input>` only has an
unambiguous mapping for these four (`E-SEM-052` otherwise).

DECISION: `FORM` is top-level only inside a `PAGE`, not inside `FOR EACH`
or another `FORM` (`E-SEM-050`) — the same first-version scoping `BUTTON`
itself shipped with (ADR-013) before ADR-016 later lifted it. A form per
rendered record is a real, plausible future need, deliberately deferred.
Every `INPUT` name within one `FORM` must be unique (`E-SEM-051`).

DECISION: inside a `FORM`, a `BUTTON`'s `CALL API ... WITH { field:
<value> }` (ADR-016) may now reference an `INPUT`'s name directly, in
addition to the existing literal/page-local-state/loop-variable-field
references — checked by the same `isValidPageValueRef` predicate, one
more case. Unlike those existing cases (all resolvable at PAGE-compile
time), a form field's value is only known at submit time: the compiler
now builds a `CALL API` payload as a JS object-literal **expression**
(some fields still compile-time constants, some live reads —
`document.getElementById(...).value`/`.checked`, type-converted per the
field's declared type) rather than a single pre-resolved JSON value.

**Bug fix picked up along the way**: a page-local-state reference inside
a `WITH` payload was already syntactically accepted by the analyzer since
ADR-016 shipped, but the compiler silently produced `undefined` for it
(the payload-resolution helper only ever handled a loop-variable field or
a literal, never a bare state `Identifier`). Rebuilding payload
compilation as expression text fixes this: a state reference now
correctly compiles to a live `state.x` read, exactly like a form field.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-049 | INPUT used outside a FORM |
| E-SEM-050 | FORM declared somewhere other than a PAGE's top level |
| E-SEM-051 | Duplicate INPUT name within one FORM |
| E-SEM-052 | INPUT with a non-integer/decimal/text/boolean type |

Everything else in §1–§17 and the v0.2–v0.15 amendments above is
unchanged — a `PAGE` with no `FORM`, and `nova build` itself, keep their
exact current behavior.

## v0.17 Amendments — Durable Persistence for `nova serve` (ADR-018)

Status: Implemented (this repository). See
[docs/adr/ADR-018-durable-persistence.md](adr/ADR-018-durable-persistence.md)
for full rationale.

**No grammar, keyword, or diagnostic changes.** `SAVE`/`GET`/`DELETE`
(§9, ADR-006) keep their exact existing syntax and semantics. This
amendment is entirely a `nova serve` (ADR-014) runtime/CLI concern: `nova
run` and `nova build` are unchanged and remain in-memory-only.

DECISION: `nova serve path/to/app.nova [port]` now reads and writes
`path/to/app.nova.data.json` — the store's own `{ type, value }`-tagged
shape (values.js), wrapped in a small versioned envelope
(`{ novaDataFormat: 1, store: {...} }`), written atomically (temp file +
rename) after the boot run and after every request that reaches a
declared `API` handler. On the next `nova serve` of the same file, that
file (if present) is loaded into the store **before** the boot run
executes, so the process's own `SAVE`/`GET`/`DELETE` state now survives a
real restart, not just requests within one already-running process (which
already worked, since ADR-014).

DECISION: a program's own top-level `SAVE` statements still run on every
boot, unchanged — durability does not make the interpreter skip them. A
program that seeds data unconditionally is expected to guard it itself,
using existing NOVA (`IF LENGTH(GET Product) == 0 ... END` around the
seed `SAVE`s), not a new interpreter concept. This is a direct, deliberate
consequence of keeping the store's own on-disk format the single source
of truth, with zero new language surface.

```nova
DATA Product
    name: text
    price: decimal
END

IF LENGTH(GET Product) == 0
    SAVE { name: "Widget", price: 9.99 }
END
```

Everything else in §1–§17 and the v0.2–v0.16 amendments above is
unchanged.

## v0.18 Amendments — API DELETE and Path Parameters (ADR-019)

Status: Implemented (this repository). See
[docs/adr/ADR-019-api-delete-path-params.md](adr/ADR-019-api-delete-path-params.md)
for full rationale.

**§14 (amended)** — `API` now accepts `DELETE` alongside `GET`/`POST`. No
new keyword: `DELETE` is already active (the `DELETE` statement, ADR-006),
reused as an HTTP method exactly the way `GET`/`POST` already are.
`PUT` remains unsupported, deliberately deferred (see the ADR for why).

**New grammar**:
```
api-declaration ::= "API" ("GET"|"POST"|"DELETE") string-literal
                     NEWLINE statement* "END"
```

**Path parameters**: a route segment written `:name` (e.g. `API DELETE
"/products/:id"`) is a path parameter, always typed `integer` — the only
kind of id `SAVE` has ever produced (ADR-006). No new grammar or token:
`:name` lives entirely inside the route's existing string literal: any
segment starting with `:` is treated as a parameter, extracted and
validated by a shared module (`src/apiserver/routePattern.js`) used
identically by the analyzer and the server.

Inside the handler body, each path parameter is bound as an ordinary
`integer` local — exactly like a `DO` procedure's own `INPUT` parameter —
so `DELETE Product id` in the example below is just an ordinary,
already-typed statement:

```nova
DATA Product
    name: text
    price: decimal
END

SERVICE
    API DELETE "/products/:id"
        DELETE Product id
    END
END
```

A real request's path segment that doesn't parse as an integer simply
doesn't match the route at all — an ordinary `404`, not a `500` from a
failed conversion inside the handler.

DECISION: a path parameter name must be a valid identifier and not a NOVA
keyword (`E-SEM-053`); two parameters with the same name in one route is
`E-SEM-054`. Two `API` declarations with the same method whose route
*shapes* collide — same segment count and static/param pattern, differing
only in a parameter's name (`/products/:id` vs `/products/:pid`) — is
`E-SEM-055`, the same "don't let it be ambiguous" treatment `E-SEM-039`
already gives two literally-identical routes.

New diagnostics:

| Code | Meaning |
|---|---|
| E-SEM-053 | A path parameter's name isn't a valid identifier, or is a NOVA keyword |
| E-SEM-054 | The same path parameter name appears more than once in one route |
| E-SEM-055 | Two API routes with the same method have colliding shapes (differ only in a parameter's name) |

**Unchanged**: `CALL API` (ADR-016) — still `GET`/`POST` only, still a
literal route with no interpolation. `PUT`, a single-record `GET` by id,
and query-string parsing remain deferred (see the ADR for why `PUT` and
single-record `GET` are blocked on the same open question: `GET
TypeName` returns records with no id attached, ADR-006, so a handler has
no way to identify "the one with id 5" among them without a lookup
primitive this milestone deliberately doesn't add).

Everything else in §1–§17 and the v0.2–v0.17 amendments above is
unchanged.
