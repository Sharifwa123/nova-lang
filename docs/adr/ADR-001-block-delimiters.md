# ADR-001: Block Delimitation Strategy

## Problem
Every statement introducing a nested body (`IF`, `FOR EACH`, `REPEAT`, `DO`,
and later `DATA`, `PAGE`, `API`, `SECURITY`) needs an unambiguous way to
know where that body starts and ends. This is the single decision every
later part of the grammar, parser error recovery, the formatter, and AI
code generation depends on.

## Options considered
- **A — Indentation-significant** (Python-style).
- **B — Explicit `END`-delimited blocks.**
- **C — Hybrid** (either legal) — rejected up front: doubles the test
  surface for every block feature forever and violates NOVA's "one way to
  do things" principle.

## Decision
**Adopt B: explicit, mandatory `END`-delimited blocks for every construct
that introduces a nested body, now and in all future extensions.**
Indentation is a style convention enforced by a future formatter; it
carries zero grammatical meaning to the parser.

## Why (summary of the six axes evaluated)
1. **Parsing robustness** — indentation requires a stateful indent/dedent
   stack (tabs-vs-spaces becomes a *correctness* issue, not style); `END`
   is straightforwardly context-free, matched like parentheses.
2. **Error recovery** — a missing `END` is immediately locatable (a real
   token with a real position); a bad dedent gives the parser very little
   to work with. This directly serves NOVA's WHAT/WHERE/WHY/HOW diagnostic
   mandate.
3. **Tooling** — with `END`, a formatter can re-indent freely with zero risk
   of changing semantics; extract/move refactors just move token ranges.
4. **Readability** — indentation's only real advantage (terseness); NOVA
   optimizes for "natural enough to read, precise enough to compile," not
   terseness, and already rejected `{}` in favor of readable keywords —
   `END` is the same instinct applied to closing a block.
5. **Extensibility** — adding a new block-introducing keyword is purely
   additive to an `END`-based grammar; with indentation, every new
   construct is one more case the indent tracker must handle, with
   lexer-wide blast radius for bugs.
6. **AI/code-generation reliability** — an `END`-delimited program survives
   whitespace mangling (chat windows, markdown fences, clipboards) because
   indentation is cosmetic; an indentation-significant program can silently
   parse into a *different, wrong* program under the same mangling. Since
   reliable AI generation is an explicit NOVA goal, this was decisive.

## Consequences
- No `INDENT`/`DEDENT` tokens; the lexer is simpler, permanently.
- `parse_block` is a straightforward recursive-descent loop: consume
  statements until `END`, `ELSE`, or another expected terminator.
- Every block-opening keyword requires exactly one matching `END` — no
  shared/ambiguous `END` closing multiple blocks at once.
- `ELSE`/`ELSE IF` do not consume their own `END` — they are continuation
  clauses inside the same `IF ... END` (see SPECIFICATION.md §7).
- Zero dangling-else ambiguity by construction (unlike C).
