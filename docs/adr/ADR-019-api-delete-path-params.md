# ADR-019: `API DELETE` and path parameters

## Problem

`API` only supports `GET`/`POST` (ADR-014/ADR-015) — deliberately deferred
since ADR-015: "`PUT` implies 'update this existing id' and `DELETE` needs
no body at all, each a distinct enough question... path
parameters/query-string parsing in routing" also deferred. A route is
matched by exact string only, so there is no way for a handler to know
*which* record a request is about beyond a hardcoded literal — a real app
needs "delete the product with this id," addressed by the URL
(`DELETE /products/5`), which today is simply not expressible.

## Decision

### Scope: `DELETE` only, not `PUT` — deliberately

DECISION: this milestone ships `API DELETE` and path parameters. `PUT`
is deferred to a later milestone, on purpose, not bundled in just because
ADR-015 originally listed them together.

The reason splits them cleanly: `DELETE Product id` (ADR-006) already
works standalone — no lookup needed, deleting an already-absent id is
already a defined no-op. `PUT` ("update this existing id") and a
path-parameterized single-record `GET` (`GET /products/:id`, returning
*one* record, not the whole list) both need something this language does
not have yet: a way to fetch or replace *one specific record by its id*.
`GET TypeName` returns every record with **no id attached**
(ADR-006, deliberate — "the id is bookkeeping the store keeps about a
record, not a field injected into the record's own shape"), so a handler
literally cannot tell which returned record is "the one with id 5." Path
parameters make the *request* id available; they don't, by themselves,
give a handler any way to use it against `GET`'s output. Solving that is
a real, separate design question (does `GET` grow a by-id form? does a
record's shape change? is there a new `UPDATE` verb?) that deserves its
own ADR, not a rider on this one. `DELETE` needs none of that, so it
ships now; `PUT` and single-record `GET` wait.

### Path parameters: always `integer`, no new grammar

DECISION: a route segment written `:name` (e.g. `API DELETE
"/products/:id"`) is a **path parameter** — always typed `integer`, not a
general string capture. This is the one thing worth deciding narrowly
rather than generally: every id this language has ever produced is an
`integer` (`SAVE`'s return value, ADR-006), and that is the only
realistic thing a path parameter identifies today. A segment that
doesn't parse as an integer simply doesn't match the route at all (a
routing miss, falling through same as any other unmatched request — see
below), rather than a `400` from inside the handler.

REJECTED: a general typed-path-parameter syntax (`:id: integer`, or a
`WHERE` clause naming each parameter's type). That's real new grammar for
a generality nothing in this language needs yet — `REQUEST AS <DataType>`
already covers "a request body with real structure"; a path segment
identifying a record is, in practice, always its id.

No new keyword, no new token: `:name` lives entirely inside the route's
existing string literal (the parser already accepts any string there
unchanged) — recognizing it as a parameter is a semantic concern, handled
by a new shared module, `src/apiserver/routePattern.js`, used identically
by the analyzer (to validate/extract parameter names at compile time) and
the server (to match a real request path against a route pattern at
request time) — the same "one source of truth, not two copies that can
drift" precedent `BUILTINS` (ADR-007) already sets.

```nova
DATA Product
    name: text
    price: decimal
END

SERVICE
    API GET "/products"
        RETURN GET Product
    END

    API DELETE "/products/:id"
        DELETE Product id
    END
END
```

Inside the handler body, `id` is bound as an ordinary `integer` local —
exactly like a `DO` procedure's own `INPUT` parameter (`apiScope`, the
same child-of-global-scope the handler body already type-checks against,
gains `id: integer` before the body is checked) — so `DELETE Product id`
above is just an ordinary, already-typed-correctly statement, needing no
special-casing in `DeleteStatement`'s own analysis or execution at all.

DECISION: a parameter name must be a valid NOVA identifier and must not
be a NOVA keyword (`E-SEM-053`) — a path parameter shadowing `IF` or
`GET` would parse into an unusable binding (the handler body could never
actually reference it, since the parser would read that spelling as the
keyword, not an identifier), so this is caught at the route declaration
instead of surfacing as a confusing "undefined variable" deep in the
handler body. Two parameters with the same name in one route (`:id`
appearing twice) is `E-SEM-054`.

### Route matching: exact-match first, pattern-match as a fallback

DECISION: a request is matched against the existing flat "METHOD route"
map first (unchanged, and unaffected — every existing static route keeps
its exact-match performance and behavior). Only on a miss does the server
try each declared parameterized route for the same method,
segment-by-segment: a static segment must match literally, a `:name`
segment matches any path segment that parses as an integer
(`/^-?\d+$/`). First match wins (route registration order is already
meaningless for static routes — DECISION: it stays meaningless here too,
since two routes of the same method whose *segment shapes* collide are
already a compile-time error, below, so no two declared routes can ever
both match one real request).

DECISION: two `API` declarations with the same method whose route
**shapes** collide — same segment count, same static-vs-param pattern,
differing only in a param's *name* (`/products/:id` vs `/products/:pid`)
— are a compile-time error (`E-SEM-055`), the same "ambiguous, don't let
it happen" treatment `DUPLICATE_API_ROUTE` (`E-SEM-039`) already gives
two literally-identical routes. Checked with a normalized "shape key"
(every param segment collapsed to the same placeholder before
comparing), kept entirely separate from the *existing* exact-literal
`apiRoutes` map (still keyed by the literal route text, unchanged, since
every other consumer of that map — `CALL API`'s "does this route exist"
check, the `PAGE`/`API GET` collision check, ADR-016 — only ever looks up
a literal, non-parameterized route and must keep doing exactly that).

### `CALL API` is unchanged

DECISION: `CALL API` (ADR-016) stays `GET`/`POST` only, targeting a
literal route string with no interpolation, exactly as ADR-016 shipped
it. Extending it to `DELETE` would only be genuinely useful once its
route can be *dynamic* (a per-record "delete this row" button needs
`"/products/" + product.id`, not a fixed literal) — string interpolation
into a route is a real, separate question this ADR doesn't need to
answer to deliver `curl -X DELETE`-style server-side deletion. A page's
delete button is future work, deliberately deferred.

## Consequences

- New keyword: none. `DELETE` is already active (the `DELETE` statement,
  ADR-006); `API DELETE "/route"` reuses it as an HTTP method exactly the
  way `API GET`/`API POST` already reuse `GET`/`POST`.
- New module `src/apiserver/routePattern.js`: `parseRoutePattern(route)`,
  `isValidParamName(name)`, `routeShapeKey(pattern)`,
  `matchRoutePattern(pattern, pathname)` — shared by the analyzer and
  `src/apiserver/serve.js`.
- `src/parser/parser.js`'s `parseApiDeclaration` accepts `DELETE`
  alongside `GET`/`POST`.
- `src/analyzer/analyzer.js`'s `registerService` validates each route's
  path-parameter names (`E-SEM-053`/`E-SEM-054`) and checks route-shape
  uniqueness (`E-SEM-055`) alongside the existing literal-route check;
  the per-API body-check loop defines each path parameter as `integer`
  in `apiScope` before checking the handler body.
- `src/interpreter/interpreter.js`'s `invokeApiHandler` gains a third
  parameter, `pathParams` (a plain `{ name: number }` object, empty by
  default), bound into the handler's environment the same way a
  procedure's own parameters are.
- `src/apiserver/serve.js`: `collectApiRoutes` is unchanged (still the
  flat exact-match map); a new pass gathers parameterized routes
  separately, consulted only on a flat-map miss.
- New diagnostics: `E-SEM-053` (invalid/reserved path parameter name),
  `E-SEM-054` (duplicate path parameter name within one route),
  `E-SEM-055` (two same-method routes whose shapes collide).
- Still deferred: `PUT`, single-record `GET` by id (both blocked on the
  same "records carry no id" question, see Scope above), query-string
  parsing, and `CALL API DELETE`/route interpolation.
