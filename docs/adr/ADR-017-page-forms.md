# ADR-017: FORM / INPUT — collecting real user input on a page

## Problem

`CALL API` (ADR-016) lets a click handler reach a live endpoint, but every
`WITH` payload field has to come from data already known at compile time —
a loop record, page-local state, or a literal. There is still no way for a
visitor to type something in and have *that* reach the server: a hotel
booking demo can list rooms and book one with a single click, but it can't
ask who's booking it. A real app needs a form.

## Decision

### FORM / INPUT

```nova
PAGE "/"
    FORM
        INPUT guestName: text "Your name"
        INPUT nights: integer "Nights"
        BUTTON "Book"
            WHEN CLICKED
                CALL API POST "/reservations" WITH { guestName: guestName, nights: nights }
            END
        END
    END
END
```

New keyword: `FORM`. `INPUT` is reused verbatim — same keyword `DO`
parameters already use, same "reuse an existing keyword before inventing
one" precedent HANDOFF.md itself calls out (`CHANGE` reused three times
already). Inside a `FORM`, `INPUT name: type "label"` declares one field
(the label string is optional; the field name is used if omitted).

```
form-element  ::= "FORM" NEWLINE form-body-element* "END"
form-body-element ::= page-element | form-input
form-input    ::= "INPUT" identifier ":" type-name string-literal?
```

DECISION: an `INPUT`'s type must be `text`, `integer`, `decimal`, or
`boolean` — the exact same restriction `REQUEST AS <DataType>` already
places on its own fields (ADR-015, `REQUEST_SCALAR_TYPES`), for the same
reason: a real HTML input element has a direct, unambiguous mapping only
for these four (`<input type="text">`, `<input type="number">`,
`<input type="checkbox">`), not for `list`/`record`/another `DATA` type.

DECISION: `FORM` is top-level only inside a `PAGE` (not inside `FOR
EACH`) — the same "smallest correct version first" scoping `BUTTON` itself
shipped with in ADR-013, before ADR-016 later lifted it for buttons. A
form per rendered record (e.g. "leave a review for this product") is a
real, plausible future need, deliberately deferred rather than solved
here. `INPUT` is only legal directly inside a `FORM`.

### An INPUT's name is a new kind of reference a CALL API payload can use

DECISION: inside a `FORM`, a `BUTTON`'s `CALL API ... WITH { field:
<value> }` may now reference an `INPUT`'s name directly (`guestName`,
`nights` above), in addition to the existing literal / page-local-state /
loop-variable-field references (ADR-016). This is checked the same way —
`isValidPageValueRef` gains one more case — and, like a loop-variable
reference, it's resolved against the *real* declared type (so a later
runtime mismatch against the target handler's `REQUEST AS` shape is still
just an ordinary `E-RUN-009`, unchanged from ADR-015/016).

DECISION, and the one genuinely new piece of machinery here: unlike a
loop-variable field (fixed at PAGE-compile time) or page-local state
(already a live JS reference, `state.x`), a form field's value can only be
known **at submit time** — a visitor hasn't typed it yet when the page is
built. So where every previous `CALL API` payload field compiled straight
to a JSON literal (`resolvePageValueRaw`, ADR-016), a payload can now mix
compile-time constants with live JavaScript expressions:
`document.getElementById("novaInput_2").value` (or `.checked` for
`boolean`, `Number(...)` for `integer`/`decimal`). The payload is now
built as a JS **object-literal expression string** at compile time (some
fields baked constants, some live DOM reads), not a fully pre-resolved
JSON value.

Picked up along the way fixing this: a page-local-state reference inside a
`WITH` payload was *already* syntactically accepted by the analyzer
(`isValidPageValueRef` didn't distinguish it) but the compiler's
`resolvePageValueRaw` silently mishandled a bare `Identifier`, producing
`undefined` instead of a live `state.x` read — a genuine latent bug from
ADR-016's own first version, not something new. Rebuilding payload
compilation as JS-expression-text (rather than a pre-resolved value) fixes
this as a side effect: a state reference now correctly compiles to
`state.x`, read live at click time, exactly like a form field.

## Consequences

- New keyword: `FORM`.
- New AST: a `FORM` page-element (`{ kind: "FORM", elements, span }`) and
  a `FORM_INPUT` page-element (`{ kind: "FORM_INPUT", name, type, label,
  span }`), following the same plain-object convention `FOR_EACH`/`BUTTON`
  already use.
- New diagnostics: `E-SEM-049` (`INPUT` outside a `FORM`), `E-SEM-050`
  (`FORM` somewhere other than a `PAGE`'s top level), `E-SEM-051`
  (duplicate `INPUT` name within one `FORM`), `E-SEM-052` (`INPUT` with a
  non-`integer`/`decimal`/`text`/`boolean` type).
- `Analyzer`: `validatePageElements`/`checkPageContent`/`checkCallApiAction`
  all gain a `formInputs` parameter (name → type), threaded the same way
  `loopVarStack`/`stateVars` already are; `isValidPageValueRef` gains the
  form-input case.
- `src/pagecompiler/compile.js`: each `FORM_INPUT` renders a `<label>` +
  a typed `<input>` with a stable id; `render()` threads a `formInputs`
  map (name → `{id, type}`) the same way it threads `bindings`. `CALL
  API` payload compilation moves from "resolve every field to a JSON
  value at compile time" to "compile every field to a JS expression
  string" (literal/loop-field fields still compile-time constants; state
  and form-input fields become live reads) — this is the one real
  refactor, not additive-only.
- Nothing about `PAGE` content without a `FORM`, or a `BUTTON`'s existing
  `CHANGE`-only/loop-only `CALL API` payloads, changes in observable
  behavior.
