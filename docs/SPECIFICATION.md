# NOVA v0.1 — Core Language Specification

Status: Implemented (this repository)
Scope: Language core only — the lexer, parser, AST, semantic analyzer, and
tree-walking interpreter for the Milestone-1 surface, plus ADR-002's `CHANGE`
keyword, which was adopted as part of v0.1 before implementation began.

This document is a reconstruction, from the original design chat's own
verbatim text, of the specification that was frozen before any code was
written. See [docs/reference/raw-chat-transcript-partial.txt](reference/raw-chat-transcript-partial.txt)
and the ADRs in [docs/adr/](adr/) for the full rationale behind each decision.
Everything marked `DECISION` below is binding on this implementation.

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
today, protecting the extension points named in the original brief:
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
(integer→decimal widening permitted; any other type change on reassignment
is a semantic error).

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

## What v0.4 and beyond were (per the original design chat)

The original chat session (see the raw transcript reference above) continued
past v0.3 through v0.12, in this order, each with its own ADR:

1. **v0.4 (ADR-005)** — `DATA Name \n field: type \n END` named-type
   declarations — a pure naming layer over the existing structural
   record/list machinery, zero new runtime concept.
2. **v0.5–v0.6** — persistence (`SAVE`/`GET`/`DELETE`, in-memory only) and a
   small standard library.
3. **v0.7 (ADR-008)** — `ASK "prompt"` for real synchronous stdin input,
   verified against piped stdin through the real CLI.
4. Error handling (`TRY`/catch-style), list indexing/mutation.
5. **Static web UI** — a `PAGE` compiler target emitting HTML.
6. **Data-bound web UI** — `PAGE` reading `DATA`/`GET`-sourced values.
7. **v0.12 (ADR-013)** — `BUTTON`/`WHEN clicked` compiled to real, sandboxed
   client-side JavaScript (state mutation restricted to prevent
   `SAVE`/`GET`/`ASK`/arbitrary calls inside click handlers), verified by
   executing the generated `<script>` in Node against a DOM stub.

None of that source code survived (see [HANDOFF.md](../HANDOFF.md) for why) —
only the prose narrative of what was built and why. Re-implementing v0.2
onward from scratch, following the same ADR-first discipline, is the
project's next phase; see HANDOFF.md's roadmap for the recommended order.
