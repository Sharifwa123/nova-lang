# ADR-010: Error Handling (TRY / CATCH)

## Problem
Every runtime error in NOVA so far (division by zero, index out of
bounds, a missing field, `ASK` running out of input, a bad built-in
argument) is unconditionally fatal — it prints a diagnostic and stops the
whole program. That's correct default behavior (§14's "fail loud and
clear" philosophy), but a real program sometimes needs to anticipate a
specific, recoverable failure — the exact case `TRY`/`CATCH` is for.

## Decision

```
try-statement ::= "TRY" block "CATCH" identifier block "END"
```

```nova
TRY
    SET total = price / quantity
    SHOW "Average: {total}"
CATCH error
    SHOW "Could not compute an average: {error}"
END
```

New keywords `TRY`, `CATCH`. `CATCH` is mandatory — a `TRY` with nothing to
do differently on failure isn't meaningful, so there's no bare-`TRY` form
to special-case (consistent with `IF` always requiring at least the `IF`
branch and `FOR EACH` always requiring `IN`).

### Only runtime errors are ever catchable, and that's structural, not a rule
DECISION: `TRY`/`CATCH` can only ever observe **runtime** errors
(`E-RUN-*`). This isn't an arbitrary restriction to enforce — it falls
directly out of §13's existing fail-fast design: semantic analysis runs
to completion, rejecting the *whole* program on any lexical, syntactic, or
semantic error, strictly *before* any statement executes (§13). By the
time a `TRY` block's statements are actually running, the entire program
has already passed analysis — there is no execution-time path back to a
parse or type error for `CATCH` to ever see. `TRY`/`CATCH` composing
cleanly with the existing "analyze everything, then run" pipeline, with no
special-casing needed to keep it that way, is a direct dividend of that
design.

### The caught error is text — its message, nothing structured yet
DECISION: `CATCH error` binds `error` to a `text` value — the diagnostic's
own human-readable message, the same text a user would have seen printed
if the error hadn't been caught. DEFERRED: a richer error value (a code,
a location, a distinguishable "kind") — `text` is the smallest useful
thing, consistent with `ASK` also being `text`-only in its own first
version (ADR-008), and it's immediately useful for the obvious case
(`SHOW "Failed: {error}"`) without inventing a new built-in shape.

### Only genuine NovaErrors are caught — a real implementation bug is never silently swallowed
DECISION: `CATCH` only intercepts NOVA-level runtime errors (well-formed
`Diagnostic`s the interpreter deliberately raised — divide-by-zero, index
out of bounds, and so on). A `RETURN`'s control-flow signal passes through
untouched (a `RETURN` inside a `TRY` block still exits the enclosing
procedure normally — it is not "a failure" `CATCH` should intercept), and
so does any plain, non-`NovaError` JavaScript exception, which in this
codebase only ever means an actual bug in the interpreter itself (an
"unhandled statement/expression kind" — something that should never fire
against a program that passed analysis). A user's `TRY`/`CATCH` must never
be able to mask a real implementation bug as if it were an ordinary,
anticipated NOVA-level failure.

### No re-throw, no error kinds/codes to match on (yet)
DEFERRED, explicitly: there is no way to re-raise a caught error, and no
way for `CATCH` to distinguish *which* kind of runtime error occurred
(matching on `E-RUN-001` vs `E-RUN-005`, for instance) beyond reading the
message text. Both are real, reasonable future refinements once there's
a demonstrated need, not required to make `TRY`/`CATCH` useful today.

### TRY/CATCH and ADR-004's "definitely returns" check
DECISION: a `TRY`/`CATCH` statement counts toward ADR-004's conservative
"does every path return" analysis exactly when **both** its `TRY` body and
its `CATCH` body definitely return — the same "every branch is covered"
shape `IF`/`ELSE` already gets, not the "never counts" treatment given to
`FOR EACH`/`REPEAT`. This is sound for the same reason `IF`/`ELSE` is:
exactly one of the two bodies ever finishes running (the `TRY` body runs to
completion, or an error partway through hands off to `CATCH`), unlike a
loop body that might execute zero times and never run at all.

## Consequences
- New keywords `TRY`, `CATCH`; new AST node `TryStatement(tryBody,
  errorVar, catchBody)`.
- No new diagnostics — `TRY`/`CATCH` doesn't reject any new class of
  program; it only changes what happens when an *existing* runtime error
  fires inside its `TRY` block.
- The interpreter's `TryStatement` handling is the only place in the
  codebase that distinguishes `NovaError` (catchable) from every other
  JS exception (not) — everywhere else, an uncaught error of either kind
  already propagates to the CLI's own top-level handler the same way.
