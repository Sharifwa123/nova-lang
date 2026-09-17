# ADR-012: Data-Bound PAGE Content

## Problem
ADR-011's `PAGE` can only ever show fixed, literal content — genuinely
useful pages need to show *records*: a product catalog, a list of saved
items, anything backed by `DATA`/persistence (ADR-005/006). The real
question: **what does "data-bound" even mean when `nova build` compiles a
page exactly once, and there is no server yet to re-run it per request?**

## Decision — build-time binding, honestly named as such
`nova build` now works like a conventional **static site generator**:
it runs the file's ordinary statements once (silently — see below),
letting any `SAVE` calls populate the in-memory store (ADR-006), and
*then* compiles `PAGE` content, including new syntax that reads from that
now-populated store. The HTML `nova build` writes reflects the data that
existed at build time — full stop, no promise of anything beyond that.
This is the same model real static-site generators use (build script
populates data, templates render from it) and is the only *honest* answer
available before a server pillar exists — anything claiming "live" or
"dynamic" data without a server actually running per request would be
overselling exactly the kind of thing NOVA's philosophy has consistently
refused to gloss over.

### Grammar — reusing FOR EACH and GET, not new keywords
```
page-element ::= ("TITLE" | "STYLE" | "HEADING" | "TEXT") page-content
               | "FOR" "EACH" identifier "IN" "GET" identifier NEWLINE page-element* "END"
page-content  ::= literal | loop-variable ("." identifier)+
```
```nova
DATA Product
    name: text
    price: decimal
END

PAGE "/catalog"
    TITLE "Catalog"
    HEADING "Our Products"
    FOR EACH product IN GET Product
        HEADING product.name
        TEXT product.price
    END
END
```
No new keywords: `FOR`/`EACH`/`IN` (§6.5) and `GET` (ADR-006) already
exist with exactly the right meaning — "for each record in this
collection." Reusing them here is the same move ADR-009 made reusing
`CHANGE` for indexed mutation: the alternative (a parallel "page-loop"
construct) would be a second way to say the same thing, which ADR-001
already rejected as a category of design.

Inside a `PAGE`-level `FOR EACH`, content may now be **either** a literal
(as before) **or** a field-access chain rooted at the loop variable
(`product.name`, `product.price`) — nothing else. This is deliberately
still not "any expression": the same reasoning from ADR-011 applies
(`PAGE` content must be resolvable without running arbitrary code), just
widened by exactly one new, narrow, checkable case.

### Field access is checked against the real DATA shape
DECISION: `product.name` inside `FOR EACH product IN GET Product` is
checked against `Product`'s actual declared fields (ADR-005's existing
static-field-checking machinery, reused as-is) — referencing a field
`Product` doesn't have is `E-SEM-021`, the same diagnostic ordinary
`.field` access already uses elsewhere. `GET`ing an undeclared type is
`E-SEM-023`, also reused directly — it's the identical situation ordinary
`GET` already covers, not a new one.

### TITLE/STYLE stay page-level; HEADING/TEXT may nest
DECISION: `TITLE` and `STYLE` are only valid at a `PAGE`'s top level, not
inside a `FOR EACH` (`E-SEM-032`) — a title or a stylesheet repeated once
per record has no sensible meaning. `HEADING`/`TEXT` may appear at any
nesting depth, rendering once per iteration, in the loop body's written
order, exactly where they appear in the output — the same "renders where
it's written" rule ADR-011 already established for the flat case.

### Build-time execution is silent
DECISION: the statements `nova build` runs to populate the store produce
**no visible output** — `SHOW` is suppressed (`write`/`writePrompt` both
become no-ops for this run only; `nova run`'s behavior is completely
unchanged). A build command's job is producing files, not printing
program output; a script written to be run interactively (`nova run`)
should not spam a build log when the exact same file is also used to
populate page data. If the script calls `ASK`, `nova build` behaves
exactly like `nova run` would (blocking on real input) — this isn't
special-cased, since giving `build` different I/O semantics from `run`
would itself be a surprise; a build script that shouldn't prompt is the
script author's responsibility, the same way it is with any build tool.

## Consequences
- `page-element` gains a recursive `FOR_EACH` variant:
  `{ kind: 'FOR_EACH', loopVar, dataTypeName, dataTypeNameSpan, body }`.
- The analyzer's `registerPage` becomes recursive (`validatePageElements`),
  tracking an enclosing-loop-variable stack so nested/chained field access
  can be checked against the right `DATA` type, and reuses
  `staticFieldType` (already built for ordinary `.field` checking, ADR-005)
  rather than a parallel checker.
- `nova build` now constructs and runs a real `Interpreter` (write
  suppressed) before compiling pages; `src/pagecompiler/compile.js`
  changes from a pure AST→HTML function to one that also takes the
  interpreter's populated store, and reuses `interpreter/values.js`'s
  `display()` to render a fetched field's value the same way `SHOW` would.
- New diagnostic: `E-SEM-032` (`TITLE`/`STYLE` inside a `PAGE`-level `FOR
  EACH`). `E-SEM-021`/`E-SEM-023` are reused, not duplicated, for field
  and type-name checking respectively.
