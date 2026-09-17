# ADR-015: API POST and REQUEST AS — reading the request body

This ADR continues directly from ADR-014's own explicitly-deferred list
("Write verbs on `API`... a request-body story ... a genuinely separate
design question") and HANDOFF.md's "what's next" item 1.

## Problem

ADR-014 shipped `API GET` only, deliberately: a `GET` handler has no
request body to reason about, so it could reuse `DO` procedure body
type-checking wholesale with zero new expression syntax. A write verb
needs an answer for the one genuinely new thing it introduces: how does a
handler get at the JSON body a client actually sent, in a way that's
still statically checked against a `DATA` shape the way everything else
in NOVA is (record literals against `SAVE`, `DATA`-typed `RETURN`s, and so
on) — not just handed a raw, untyped blob to poke at by hand?

## Decision

### API accepts POST, alongside GET

```nova
DATA Product
    name: text
    price: decimal
END

SERVICE
    API GET "/products"
        RETURN GET Product
    END

    API POST "/products"
        SET p = REQUEST AS Product
        SAVE p
        RETURN p
    END
END
```

DECISION: smallest correct version, one more time — `API` now accepts
`POST` in addition to `GET` (still only those two; `PUT`/`DELETE` remain
deferred). `PUT`/`DELETE` are real and useful but each raises its own
question (`PUT` implies "update this existing id," `DELETE` needs no body
at all) distinct enough from "create from a posted body" that folding them
into this same pass would be exactly the kind of milestone-bundling
HANDOFF.md's own process discipline warns against.

### REQUEST AS <DataType> — a new, narrowly-scoped expression

```
primary ::= ... | "REQUEST" "AS" identifier
```

New keywords: `REQUEST`, `AS` (neither was previously forward-reserved —
the same "introduce a genuinely new keyword when an existing one doesn't
fit" precedent ADR-013 already set with `BUTTON`/`CLICKED`, not only
graduating pre-reserved placeholders).

DECISION: `REQUEST AS Product` is an expression that evaluates to the
POST request's JSON body, parsed and validated against `Product`'s
declared fields — the exact same "does this value match this `DATA`
shape" question `checkRecordLiteralAgainstDataType` already answers for a
record literal used against `SAVE`/`RETURN`, applied here to a value that
isn't known until a real request arrives instead of one written in the
source file. Its static type is `Product` itself, so `SAVE p` and
`RETURN p` afterward work exactly like they do for any other
`Product`-typed value, with zero new logic on that side.

DECISION: `REQUEST` is valid **only** lexically inside a `POST` handler's
own body — not inside a `GET` handler, not inside a `DO` procedure (even
one a `POST` handler calls), not at a file's top level. This is checked
statically, by the analyzer tracking which API method's body it's
currently checking (a single instance field, pushed/popped around each
API body — not threaded through `infer()`'s signature, which stays
untouched). Because the analyzer checks a `ProcedureDeclaration`'s body
exactly once, at its own textual position, never re-entering it from a
call site, this restriction is fully sound, unlike ADR-014's shallow
per-handler `ASK` check: there is no call-graph gap here to name as a
known limitation, because `REQUEST` inside a called procedure is rejected
at the procedure's own declaration, regardless of who calls it.

### Only primitive-typed DATA fields are supported by REQUEST, for now

DECISION: `REQUEST AS <Type>` requires every field of `<Type>` to be
`integer`/`decimal`/`text`/`boolean` — checked statically, at the
`REQUEST AS Product` expression itself (`E-SEM-043`), before any request
ever arrives. A field typed as another `DATA` type, `list`, or `record`
would need a recursive validation story (and, for `list`, an element-type
story NOVA doesn't have yet at all — see the v0.2/v0.4 amendments'
"Known, deliberate limitations") that's a real, separate feature. Scoping
`REQUEST` to flat, primitive-only shapes for v0.14 is the direct analogue
of ADR-011 scoping `PAGE` content to literals before ADR-012 added
variables — smallest correct version, not a permanent ceiling.

### Runtime validation, and why body-shape errors are 400, not 500

DECISION: at request time, the HTTP layer reads the full POST body before
invoking the handler (buffered, since NOVA's interpreter is synchronous —
there is no `await` inside `execStatements`, so a handler must receive an
already-parsed value, not a stream) and attempts `JSON.parse`; a parse
failure is treated identically to "no body at all" (both simply leave the
parsed body absent) rather than needing a separate diagnostic — a
`REQUEST AS Product` expression's own shape-check reports the same "not a
valid `Product`" story either way.

`REQUEST AS Product`'s evaluation, at runtime, checks: the body is a JSON
**object** (not an array, primitive, or absent) — else `E-RUN-008`; and
every one of `Product`'s declared fields is present with a
JS-type-matching value (`integer` requires a whole number, `decimal` any
number, `text` a string, `boolean` a boolean) — else `E-RUN-009` naming
the specific field and problem. Extra fields in the body beyond
`Product`'s own are silently ignored, not an error — deliberately more
forgiving than `RecordLiteral`'s exact-match rule (`UNEXPECTED_DATA_FIELD`,
ADR-005), because a literal is code the developer wrote and fully
controls, while a request body comes from a client NOVA doesn't control;
rejecting a client for sending one harmless extra field would be a real
usability regression a literal's author doesn't face.

DECISION: unlike every other `NovaError` reaching `nova serve`'s request
handler (which ADR-014 maps to `500`), `E-RUN-008`/`E-RUN-009`
specifically map to `400` — these two are, definitionally, "the client
sent a body that doesn't match what this endpoint declared it needs,"
which is a client error, not a server one. Every other runtime error
(divide-by-zero, an out-of-bounds index, anything **after** a
successfully-validated `REQUEST` value) stays `500`, unchanged from
ADR-014.

## Consequences

- New keywords `POST`, `REQUEST`, `AS`.
- New AST node `RequestExpression(typeName, typeNameSpan, span)`.
- `Analyzer` gains one instance field (`currentApiMethod`, push/popped
  around each API body) and two new diagnostics: `E-SEM-042` (`REQUEST`
  used outside a `POST` handler), `E-SEM-043` (`REQUEST AS <Type>` where
  `<Type>` has a non-primitive field).
- `Interpreter` gains `dataTypeFields` (name → `[{name, type}]`, populated
  once from the AST's `DataDeclaration` nodes, the same information
  `parseData` already produces) and `currentRequestBody`, set for the
  duration of one `invokeApiHandler` call. Two new runtime diagnostics:
  `E-RUN-008` (body isn't a JSON object), `E-RUN-009` (a field is missing
  or wrong-typed).
- `src/apiserver/serve.js`'s request listener becomes `async` (buffering a
  POST body before invoking the handler) and maps `E-RUN-008`/`E-RUN-009`
  to HTTP `400` specifically, everything else staying `500` as ADR-014
  already established.
- `API GET` and everything ADR-014 shipped is otherwise completely
  unchanged.
