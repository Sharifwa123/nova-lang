# ADR-002: Outer-Scope Mutation (`CHANGE`)

## Problem
§8.6 of the original v0.1 draft established that `SET` always creates or
updates a binding in the current innermost scope only — it never reaches
outward. That makes scoping fully predictable, but leaves no way to write
the single most common imperative pattern: accumulation across a loop.

```nova
SET total = 0
FOR EACH price IN prices
    SET total = total + price   # WRONG under pure-local SET:
END                              # shadows a NEW total each iteration;
SHOW total                       # prints 0, not the sum. Silently wrong.
```

## Options considered
1. **Implicit outer mutation** — `SET` auto-detects: mutate outward if the
   name already exists somewhere enclosing, else create local. **Rejected**:
   reintroduces exactly the context-dependent ambiguity §8.6 was written to
   eliminate, conflicts with shadowing rules, and is a real typo hazard (a
   misspelled local name can silently mutate unrelated outer state).
2. **No mutation; functional-only accumulation** (fold/reduce-style).
   **Rejected**: fights NOVA's explicitly imperative, natural-reading
   philosophy and its own worked examples (`SET stock = stock - 1`).
3. **Explicit `SHARE`-style declaration** (Rust `&mut`/Pascal `var`-param
   style: declare intent to mutate before the block). **Rejected**: safest
   in the abstract, but meaningfully more ceremony for the single most
   common loop pattern in the language — every accumulation loop needs a
   declaration line before doing the obvious thing.
4. **A distinct keyword** — `SET` stays pure-local (unchanged); a new
   keyword's sole job is "mutate an existing binding, found by searching
   outward through the scope chain; error if none exists." **Adopted.**

## Decision
Introduce `CHANGE name = expression`. `SET` is completely untouched.

- `SET` always writes to the *current* scope (creates if needed; shadows,
  never mutates outward).
- `CHANGE` always writes to *wherever the name currently resolves* (via the
  same scope-chain walk as an ordinary read), and **never creates** — a
  `CHANGE` on an undefined name is a semantic error (E-SEM-006).

```nova
SET total = 0
FOR EACH price IN prices
    CHANGE total = total + price   # mutates the OUTER total in place
END
SHOW total                          # correct sum
```

## Why this beats the alternatives
- Beats **implicit auto-detect**: both statements now have exactly one,
  context-independent meaning. Nothing about what a `SET` or `CHANGE` does
  depends on facts invisible at the statement itself.
- Beats **`SHARE`-style declarations**: equivalent auditability (`CHANGE` is
  itself the complete, greppable signal) with strictly less ceremony — no
  separate declaration to keep in sync as a loop body grows.
- Composes cleanly with shadowing (§8.5): `CHANGE` mutates whichever
  binding is currently the *live* one — the same one a plain read would
  resolve to — reusing name resolution rather than adding a second
  algorithm.
- Composes cleanly with procedure scoping (§8.3): a `DO` body's parent is
  global scope, not the call site, so `CHANGE` inside a procedure can reach
  global state but can *never* reach into a caller's block-scoped locals —
  this is a direct, free consequence of existing rules, not a special case.
- Sets up future analyzability for free: because `CHANGE` is the sole
  lexically-distinct statement capable of crossing a scope boundary to
  mutate state, any future concurrency/security/race-analysis pass can
  treat "does this handler contain a `CHANGE` targeting non-local state" as
  a purely syntactic question.

## Consequences
- New keyword `CHANGE` (§2.6).
- New AST node `ChangeStatement(name, value)` (§12).
- New diagnostic E-SEM-006 (§11).
- Affects: §4 (new §4.3), §6.1 (statement grammar), §8.6 (rewritten), §13
  (semantic analysis must resolve `CHANGE` targets the same way as reads).
