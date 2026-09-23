# ADR-016: PAGE/SERVICE integration — BUTTON in a loop, CALL API, and serving pages live

## Problem

ADR-014/ADR-015 gave NOVA a real backend (`SERVICE`/`API`, live persistence)
and ADR-011/012/013 gave it a real frontend (`PAGE`, data-bound, with
client-side interactivity) — but the two halves never talk to each other.
Concretely, three gaps compound into one real limitation: a `PAGE`-level
`BUTTON` is rejected outright inside a `FOR EACH` (`E-SEM-038`, "a real
design question left to a later milestone"), because a per-record button
has no way to know which record it belongs to; even if it did, there is no
statement that lets a click handler reach a `SERVICE`/`API` endpoint at
all; and even if there were, `nova build`'s static HTML and `nova serve`'s
live server are two separate commands with no shared origin for a
same-page `fetch` to target. The result: a compiled page can *display*
live-looking, data-bound content, but nothing on it can ever cause a real
write. A "Book this room" button is, today, unbuildable.

This ADR closes that gap for the single smallest case that makes it real:
a per-record button that calls a declared `API` endpoint and reflects the
result, on a page actually served by `nova serve`.

## Decision

### `nova serve` now serves PAGE routes too

`nova serve` compiles every `PAGE` declaration once at startup — the exact
same timing and the exact same store snapshot `nova build` already uses
(ADR-012's "build-time snapshot" model is unchanged; pages do not
recompile per request) — and serves the result at its own route for `GET`
requests that don't match a declared `API`. `nova build`'s file-writing
behavior is completely untouched; this only adds a second way to reach the
same compiled HTML, in-memory, from the live server.

This is what makes `CALL API` (below) meaningful in a browser at all: a
button's `fetch("/reservations")` only works same-origin, and until now
there was no single server exposing both a page and its API together.

DECISION: because a `PAGE` route and an `API GET` route can now collide on
the same live server (both would claim `GET /`), that collision is now a
compile-time error (`E-SEM-048`), checked once both route tables are known
(end of phase 1), rather than a silent "whichever the routing table
happened to keep" runtime ambiguity.

### BUTTON is now allowed inside FOR EACH

`E-SEM-038` is retired (the code stays defined in `codes.js` as a
historical marker, per this codebase's existing convention of never
reusing a diagnostic code for a different meaning). The "which record"
question ADR-013 deferred is answered the same way `HEADING`/`TEXT`
already answer it inside a data-bound loop (ADR-012): the page compiler
already walks real store records at *compile* time, so a per-record
button's label and its click handler's data are both resolved against the
concrete bound record when that specific button is generated — no new
runtime "which record was I created for" tracking is needed, because
nothing about it is runtime; it's baked into that button's own generated
JavaScript function, exactly like a data-bound `HEADING`'s text already is.

### CALL API — a new click-handler statement

```
call-api-statement ::= "CALL" "API" ("GET"|"POST") string-literal
                        ( "WITH" record-literal )?
```

New keywords: `CALL`, `WITH` (neither was previously forward-reserved —
the same "introduce a genuinely new keyword when needed" precedent
ADR-013/015 already set).

```nova
BUTTON "Book Now"
    WHEN CLICKED
        CALL API POST "/reservations" WITH { roomNumber: room.number }
    END
END
```

DECISION: `CALL API` is grammatically an ordinary statement (parseable
anywhere any statement is, the same "parse generically, restrict
semantically" precedent ADR-013 set for `WHEN CLICKED`'s body), but valid
**only** inside a `BUTTON`'s `WHEN CLICKED` block — found anywhere else
(top level, a `DO` body, an `API` handler body), it's rejected with a
dedicated diagnostic (`E-SEM-045`) the moment the analyzer's ordinary
statement dispatch reaches it, since a legitimate one is only ever visited
through the button-action path, never through that dispatch.

DECISION: the method+route must match a real `API` declared somewhere in
the same file, checked against `this.apiRoutes` — the exact map
`registerService` (ADR-014) already builds in phase 1, so this reuses
existing infrastructure rather than adding a second routing table. An
unmatched method+route is `E-SEM-046`, listing what *is* declared as a
hint. This is a genuinely new cross-check NOVA didn't need before: nothing
previously connected a page-side construct to a service-side one.

DECISION: a `WITH` payload's fields follow the *exact* same restricted
shape ADR-012/013 already established for any page-element value: a plain
literal, a reference to page-local state, or a field-access chain rooted
at an enclosing `FOR EACH`'s loop variable (checked against the real
`DATA` shape, reusing `staticFieldType`). This is refactored out of the
existing `checkPageContent` into a shared `isValidPageValueRef` predicate
so both call sites — ordinary page content and a `CALL API` payload field
— give their own contextually-accurate error message
(`PAGE_CONTENT_NOT_STATIC` vs. the new `CALL_API_PAYLOAD_NOT_STATIC`,
`E-SEM-047`) off one shared check, not two copies of the same logic.

DECISION, explicitly deferred: the payload's *shape* is not statically
cross-checked against the target handler's own `REQUEST AS <DataType>`
field list. Doing so would mean tracing, for an arbitrary declared route,
which `DATA` type (if any) its handler binds via `REQUEST AS` — real,
useful work, but a separate feature from "can a page reach a real
endpoint at all," the same kind of scope line ADR-014 drew around request
bodies before ADR-015 picked it up. A shape mismatch is instead caught the
same way it already is for *any* other client: at runtime, by the
existing `E-RUN-008`/`E-RUN-009` checks, surfacing to the page as an
ordinary failed request (see below) — not a silent gap, an explicit,
named boundary.

### What the generated JavaScript does

DECISION: a button whose actions include a `CALL API` compiles to an
`async` click-handler function (a button with only `CHANGE` actions is
completely unaffected — it keeps generating the exact same synchronous
function ADR-013 already produces, byte for byte). The button element
itself gets a stable `id` (previously buttons had none) so its own
generated function can reach back into the DOM directly: on click, it
disables itself, `await fetch()`s the declared route (a literal path — no
new URL-construction machinery), and on a non-OK response throws, caught
by the same handler. On success the button's own label becomes a fixed
`"Done"`; on failure, a fixed `"Failed - try again"` and it re-enables.

DECISION, explicitly deferred: no new syntax exists yet for a
developer-chosen success/failure label — matching ADR-013's own first
version (which also shipped with zero customization of button behavior
beyond the label itself). A `THEN SHOW "..."`-style refinement is a small,
natural follow-up once this shape has seen real use, not a blocker to
shipping the underlying capability now.

A `WITH` payload's field values are resolved to literal JSON at *page
compile time* (the same moment `HEADING room.roomType` already resolves
`room.roomType` to literal text), via a new raw-value counterpart to the
existing `resolvePageValue` (which returns `display()`-formatted text —
wrong for a JSON body, where a price needs to stay a JSON number, not
become the string `"149"`).

## Consequences

- New keywords: `CALL`, `WITH`.
- New AST node: `CallApiStatement(method, route, routeSpan, payload, span)`.
- New diagnostics: `E-SEM-045` (`CALL API` outside a click handler),
  `E-SEM-046` (`CALL API` references an undeclared method+route),
  `E-SEM-047` (a `WITH` payload field isn't a literal or a valid
  loop-variable/state reference), `E-SEM-048` (a `PAGE` route collides
  with an `API GET` route now that one server can serve both).
  `E-SEM-038` (`BUTTON_INSIDE_LOOP_NOT_SUPPORTED`) is retired, not reused.
- `Analyzer.checkButtonAction` now dispatches on the action's kind
  (`ChangeStatement`, unchanged, or the new `CallApiStatement`) instead of
  rejecting anything but `ChangeStatement` outright; `checkPageContent`'s
  core predicate is factored out as `isValidPageValueRef` so the new
  payload check can reuse it with its own error message.
- `src/pagecompiler/compile.js`: every `BUTTON` gets a stable element id;
  `buttons` now also carries the `bindings` captured at compile time (for
  resolving a loop-scoped payload) and a per-button async/sync choice in
  `buildScript`; new `resolvePageValueRaw`/`rawJsValue` helpers alongside
  the existing `resolvePageValue`.
- `src/apiserver/serve.js`: `startServer` also compiles `PAGE` routes
  (via a new `collectPageRoutes`, reusing `compilePage` from
  `pagecompiler/compile.js`) once at startup and serves them for `GET`
  requests that don't match a declared `API`; `nova build`'s own behavior
  is completely unchanged.
- `PAGE`/`SERVICE` in isolation (no `BUTTON`-in-loop, no `CALL API`) are
  entirely unaffected — every existing example and test keeps its exact
  current output.
