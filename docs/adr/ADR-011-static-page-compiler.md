# ADR-011: PAGE — a Static HTML Compiler Target

**Provenance note**: this is where genuine invention starts. The original
chat's *very first message* — before any code existed — flagged this
exact area as the hardest problem in the whole spec: *"PAGE/SCREEN/API/
SERVICE/DATA as top-level declarations sharing one language is the single
hardest architectural problem in this whole spec... NOVA needs an explicit
answer here, not 'the compiler figures it out.'"* That critique, the
roadmap's three-step split (static UI → data-bound UI → interactive UI),
and the reserved keywords `PAGE`/`STYLE` (plus one confirmed detail: a
`PAGE` block was described as containing `STYLE` and `BUTTON` and `WHEN`)
are everything that survived. The element vocabulary, grammar, and
compilation strategy below are this repository's own design, scoped
deliberately small for exactly the reason the original critique named:
promising more than a genuinely safe answer for the client/server boundary
would be scope collapse waiting to happen.

## Problem
Every NOVA program so far is a script: `nova run` lexes, parses, analyzes,
and interprets it, end to end. `PAGE` needs to produce something
fundamentally different — a static artifact (HTML) — not a value or a
side effect during interpretation. This is NOVA's first real compilation
target other than the tree-walking interpreter itself (§14 called the
interpreter "an explicit starting strategy, not a permanent commitment" —
this is the first place that separation actually gets exercised).

## Decision — scope, deliberately narrow
This ADR is **static HTML only** — literal content, no variables, no
`DATA`/`GET`-sourced values, no interactivity. That split matches the
roadmap's own three steps, and matters for the same reason ADR-001 and
ADR-003 kept early milestones narrow: `PAGE` reading live data and `PAGE`
handling clicks are each a real design problem in their own right (the
clicks one especially — restricting what a click handler can touch is
exactly the "PAGE safely calling into backend logic" concern the original
critique raised). Solving all three at once would repeat the original's
own named mistake.

### Grammar
```
page-declaration ::= "PAGE" string-literal NEWLINE page-element* "END"
page-element      ::= "TITLE" expression
                     | "HEADING" expression
                     | "TEXT" expression
                     | "STYLE" expression
```
New keywords: `TITLE`, `HEADING`, `TEXT` (new, like `CHANGE`/`ASK`/`TRY`
before them). `PAGE` and `STYLE` graduate from forward-reserved (§2.6)
into real grammar.

```nova
PAGE "/"
    TITLE "Welcome"
    STYLE "body { font-family: sans-serif; }"
    HEADING "Hello, NOVA"
    TEXT "This page was compiled, not interpreted."
END
```

### PAGE is a declaration, not code that runs
DECISION: a `PAGE` block is inert during `nova run`, exactly like `DATA`
and `DO` are already inert-until-called/referenced — `nova run` continues
to execute only the file's ordinary imperative statements. A **new**
command, `nova build <file>.nova`, is what reads `PAGE` declarations and
emits HTML files (to a `dist/` directory next to the source file). This
means one `.nova` file can hold both a runnable script and page content
side by side — no second file extension, no second language — which is
the actual, concrete form of "PAGE/DATA sharing one language" the
original vision asked for, kept honest by *not* pretending they share one
execution model too.

### Content must be a static literal — enforced, not just documented
DECISION: every `page-element`'s expression must be a **literal**
(`integer`/`decimal`/`boolean`, or a `text` literal with **no**
interpolation) — never an identifier, call, or any other expression form.
This isn't an arbitrary restriction; it's the direct, honest consequence
of `PAGE` never being executed: there is no running program, no scope, no
variable state for anything else to resolve against at compile time.
Rejecting a non-literal here (`E-SEM-030`) is what keeps "static" true
rather than aspirational — the alternative (silently treating a variable
reference as empty, or partially evaluating some expressions but not
others) is exactly the kind of hidden, inconsistent behavior NOVA's
philosophy has rejected everywhere else. Data-bound content is next
milestone's entire job, not a partial answer squeezed into this one.

### Element vocabulary, and what's deliberately not in it yet
DECISION: four elements only — `TITLE` (the document `<title>`, at most
one per `PAGE`), `STYLE` (raw CSS text, concatenated into one `<style>`
block; any number, each must be `text`), `HEADING` (`<h1>`), `TEXT`
(`<p>`). `HEADING`/`TEXT` may repeat freely and render in the order
written, interleaved. DEFERRED, explicitly: heading levels (`H1`-`H6`),
layout/grouping containers (a `SECTION`/`DIV`-equivalent), links, images,
lists. This is a real, narrow "smallest correct version" — enough to
render a genuine page, not a layout system.

### Routing and output
DECISION: `PAGE`'s string literal is a route path, and must start with
`/` (`E-SEM-029` otherwise). Duplicate routes within one file are
rejected (`E-SEM-028`). `nova build` maps a route to an output file the
obvious way (`/` → `dist/index.html`, `/about` → `dist/about.html`,
`/products/list` → `dist/products/list.html`, creating subdirectories as
needed) — no configuration, no routing DSL; the route *is* the file path,
one honest, discoverable rule instead of a system to configure.

### HTML generation, not string concatenation
DECISION: text content is HTML-escaped (`&`, `<`, `>`, `"`) before being
placed into output — a literal containing `<` or `&` must render as
literal text, not be silently interpreted as markup. This matters even
though v0.10's content is author-controlled literals only: it's still the
only correct way to turn arbitrary text into HTML content, and getting it
right now costs nothing and avoids a real, easy-to-miss bug once dynamic
content (next milestone) makes it a genuine correctness and security
requirement rather than only a correctness one.

## Consequences
- New AST node: `PageDeclaration(route, elements)`, where each element is
  `{ kind: 'TITLE'|'STYLE'|'HEADING'|'TEXT', value: Expression }`.
- New analyzer phase: `PAGE` declarations are registered and validated
  (route format/uniqueness, element literal-ness, `STYLE`'s type) as part
  of the existing two-phase top-level pass (ADR-005) — before the main
  statement-checking traversal, which then treats `PageDeclaration` as a
  no-op, the same pattern `DataDeclaration` already established.
- New module `src/pagecompiler/` — pure functions from a validated
  `Program` AST to a list of `{ path, html }` outputs; no dependency on
  the interpreter (`PAGE` content is never executed, by design).
- New CLI command `nova build <file>.nova`.
- Five new diagnostics: `E-SEM-028` (duplicate route), `E-SEM-029`
  (route missing a leading `/`), `E-SEM-030` (non-literal `PAGE`
  content), `E-SEM-031` (`STYLE` given a non-`text` value).
