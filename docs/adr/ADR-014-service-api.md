# ADR-014: SERVICE / API — a live HTTP server

## Problem

Every prior milestone that touches data (`SAVE`/`GET`/`DELETE`, ADR-006;
data-bound `PAGE`, ADR-012) is either purely in-process (`nova run`) or a
build-time-only static snapshot (`nova build` runs the file once, silently,
then never runs it again — ADR-011/012's own "no server exists yet to make
'live' honest" caveat). HANDOFF.md names the natural next step directly:
a server/API pillar is what would let data-bound content stop being a
static-site-generator snapshot and become genuinely live. `PAGE` itself
is deliberately left alone here — teaching it to talk to a live server is
a separate, later design question (mixing this ADR's server-side surface
into PAGE's already-restricted client-side compiler would conflate two
different sandboxing problems). This ADR's scope is narrower and
foundational: can a `.nova` file define HTTP endpoints backed by the same
persistence store `SAVE`/`GET`/`DELETE` already use, and serve them for
real, across real requests, from a real process that stays running?

## Decision

### SERVICE contains API declarations; only GET, for now

```nova
DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT pr: decimal
    RETURN { name: n, price: pr }
END

SAVE makeProduct("Widget", 9.99)
SAVE makeProduct("Gizmo", 14.5)

SERVICE
    API GET "/products"
        RETURN GET Product
    END

    API GET "/hello"
        RETURN "Hello from NOVA"
    END
END
```

DECISION: smallest correct version, matching the discipline that shipped
every prior milestone — `API` supports only the `GET` HTTP method in
v0.13. Every other verb (`POST`/`PUT`/`DELETE`) is real, useful, and
explicitly deferred, not designed here: a write verb needs a request-body
story (parsing, validation against a `DATA` shape) that's a genuinely
separate design question, the same reasoning ADR-011 used to defer
variables from `PAGE` content until ADR-012. The grammar itself only
accepts the literal keyword `GET` after `API` — this is a parser-level
restriction (any other word is a plain parse error), not a semantic one,
because there's no partial support to report a nicer error about yet.

### Grammar

```
top-level-statement ::= ... | service-declaration
service-declaration ::= "SERVICE" NEWLINE api-declaration* "END"
api-declaration      ::= "API" "GET" string-literal NEWLINE statement* "END"
```

No new keywords: `SERVICE` and `API` graduate from forward-reserved
(§2.6) into real grammar, exactly as `WHEN` did in ADR-013. `GET` is
already active (ADR-006's `GET <DataType>` persistence expression) and is
reused verbatim for the HTTP verb — one keyword, two contexts, disambiguated
by parser position (`API GET` vs. an expression's `GET <DataType>`), the
same economy of keywords every prior ADR in this series has insisted on.

An API's body is parsed as an **ordinary** statement block (the same
generic block parser every other construct uses) — unlike `WHEN CLICKED`
(ADR-013), this is deliberately **not** sandboxed down to a restricted
expression subset. See "What an API handler may do" below for why the two
cases are different problems with different answers.

### Route validation and uniqueness reuse PAGE's exact approach

DECISION: an API route must start with `/` (`E-SEM-040`, the same rule
ADR-011 gave `PAGE`, checked the same way — during phase 1 registration,
before body-checking needs any DATA/procedure resolution). Two `API`
declarations may not share the same method+route pair (`E-SEM-039`,
directly modeled on `DUPLICATE_PAGE_ROUTE`/`E-SEM-028`) — checked globally
across every `SERVICE` block in the file, not just within one block, since
they all end up in the same one process's routing table at `nova serve`
time. A route may not contain string interpolation, for the same reason
`PAGE`'s route can't: it names a fixed endpoint, not a computed one.

### What an API handler may do — deliberately NOT sandboxed like WHEN CLICKED

DECISION: unlike a `WHEN CLICKED` block (ADR-013), an API handler's body
is genuine, unrestricted server-side NOVA code — `SAVE`, `GET`, `DELETE`,
procedure calls, `IF`/`FOR EACH`/`REPEAT`, all of it. This is not an
oversight; it's the entire point of this milestone. `WHEN CLICKED` is
sandboxed because it compiles to JavaScript that runs in a stranger's
browser with no trust boundary NOVA controls. An API handler runs where
`SAVE`/`GET`/`DELETE` already run today (inside the interpreter, in a
process the developer controls) — there is no new trust boundary being
crossed here, so inventing a parallel restricted-expression sandbox for it
would be solving a problem this milestone doesn't have.

DECISION, the one narrow exception: `ASK` is rejected inside an API
handler body (`E-SEM-041`), checked by a dedicated structural walk over
the handler's own statements (not a deep, whole-program call-graph
analysis — see "Known limitation" below). `ASK` blocks on real stdin
(ADR-008); a live HTTP server has no per-request terminal to read from, so
every request against such an endpoint would hang forever waiting on
input nothing will ever supply. This is a real, narrow correctness
footgun (not a sandboxing/trust concern the way `WHEN CLICKED`'s
restrictions are), so it gets a real, narrow static check — the same
proportionate-response principle ADR-013 itself used to justify
`assertNoUnsafeConstructs` as a separate pass from ordinary type-checking.

DECISION: an API handler reuses the exact same RETURN machinery a `DO`
procedure body already has — `checkStatements`/`infer` run against a
scope that's a child of global scope (mirroring `ProcedureDeclaration`'s
`procScope` exactly), with `ctx = { insideProcedure: true,
declaredReturnType: null }` so `RETURN` is valid inside a handler for
free, with zero new logic. There is no `RETURNS` annotation for an API
(no syntax exists to write one) and, matching an *undeclared*-return-type
`DO` procedure exactly, `definitelyReturns` is not required — a handler
that falls off the end without hitting `RETURN` responds with NONE
(serialized as JSON `null`), the same "falls through to NONE" behavior an
untyped procedure already has. This is a deliberate smallest-correct-
version choice, not a gap: requiring every handler to provably return
would need either a `RETURNS`-shaped annotation (real, useful, and a
separate design question) or a blanket unconditional requirement that
doesn't fit how small a "just return a constant" endpoint should have to
be.

### Runtime: nova serve starts a real process that stays live

DECISION: `nova serve <file>.nova [port]` (default port 3000) is a **new**
CLI command, structurally close to `nova build` but ending differently: it
compiles the file, runs its top-level statements once, silently — this
half is identical to `nova build`'s existing "run once to populate SAVE'd
data" step (ADR-011/012) — and then, instead of writing files and exiting,
starts a real Node `http` server (`src/apiserver/serve.js`, zero
dependencies, matching HANDOFF.md's own stated reason for the whole
project being dependency-free) and keeps the **same interpreter instance**
alive across every subsequent request. This is the one genuinely new
runtime idea in this milestone: every request runs its matched API's body
against `interpreter.globalEnv.child()` (via a new `invokeApiHandler`
method, refactored out of `callProcedure`'s existing try/catch-for-RETURN
logic so both share it) but all requests share the **same**
`interpreter.store` — a `SAVE` from one request is visible to a `GET` in
the next, and to every request after that, for as long as the process
keeps running. This is what makes the response to HANDOFF.md's own framing
honest: `PAGE` stays a build-time snapshot (ADR-012's model is unchanged,
deliberately not touched by this ADR); `SERVICE`/`API` is where "live"
first becomes real.

Routing is a flat `Map<"<METHOD> <route>", api>` built by walking
`program.statements` for every `ServiceDeclaration` (mirroring how
`pagecompiler/compile.js` already walks the same list for
`PageDeclaration` nodes) — no path parameters, no query-string parsing,
exact-match only. An unmatched method+path returns `404` with a small
JSON error body. A handler whose body raises a genuine NOVA runtime error
(e.g. `E-RUN-001` divide-by-zero) returns `500` with the diagnostic's
message as JSON, without crashing the server — the one place this ADR
departs from "let a NovaError propagate exactly like everywhere else",
because a single bad request killing every other in-flight and future
request would make the "live, long-running process" idea this whole ADR
exists for pointless. Any *other*, non-`NovaError` exception (a genuine
interpreter bug, not a NOVA-level runtime error) is intentionally left
to propagate and crash the process — matching `TryStatement`'s own
existing rule (ADR-010: "any plain, non-NovaError exception ... an actual
interpreter bug ... propagates untouched") rather than papering over it.

### Response encoding

DECISION: a NOVA runtime value becomes a JSON HTTP response body via a
small, total `valueToJSON` mapping (`integer`/`decimal`/`text`/`boolean`
pass through as JS `number`/`string`/`boolean`; `list` maps element-wise;
`record` maps its fields, recursively; `none` becomes JSON `null`) — the
direct runtime analogue of `display()` in `values.js`, serving the same
role (one canonical value → external-representation mapping) for a JSON
audience instead of `SHOW`'s text audience.

### Known limitation: the ASK check is shallow by design

The `E-SEM-041` check above only inspects an API handler's own statement
list — an `ASK` inside a `DO` procedure the handler *calls* is not caught
statically. A sound whole-program call-graph analysis (does any
transitive callee reachable from this handler ever hit `ASK`?) is a real,
larger feature (it would need to handle recursion, procedures defined
after the `SERVICE` block, etc.) genuinely out of scope for a
smallest-correct-version milestone. This is named here explicitly, the
same honesty ADR-010 already applied to `TRY`/`CATCH` only catching
runtime errors: a real but bounded gap, not a silent one.

## Consequences

- `SERVICE`/`API` graduate from forward-reserved to real grammar; no new
  keywords (`GET` is reused for the HTTP verb exactly as it already is for
  the persistence expression).
- New AST node `ServiceDeclaration(apis, span)`; `apis` is `[{ method:
  'GET', route: string, routeSpan, body: Statement[], span }]` — plain
  objects, the same shape convention `PageDeclaration.elements` already
  uses, not a new per-element AST node family.
- `Interpreter.callProcedure`'s RETURN-catching logic is factored into a
  shared `runBlockForValue` helper, reused by both procedure calls and the
  new `invokeApiHandler` — no duplicated control flow.
- New module `src/apiserver/serve.js`: route collection, `valueToJSON`,
  and the real Node `http` server (`startServer`/`createRequestListener`).
- New CLI command: `nova serve <file>.nova [port]`.
- Three new diagnostics: `E-SEM-039` (duplicate method+route),
  `E-SEM-040` (route not starting with `/`), `E-SEM-041` (`ASK` inside an
  API handler body).
- `PAGE`/`nova build` are completely unchanged by this ADR — the two
  pillars (static/data-bound UI vs. a live server) stay independent until
  a later milestone deliberately connects them.

## Post-launch fixes (found in code review, before this ADR's PR merged)

Two real bugs surfaced by automated review of the initial implementation,
fixed before merge rather than left as follow-ups:

1. **Nested `SERVICE` silently registered no route.** `parseStatement`
   doesn't distinguish nesting position, so `SERVICE` inside `IF`/`DO`/
   `FOR EACH`/`REPEAT`/`TRY` parsed and type-checked without error — but
   `registerService` (phase 1) and `collectApiRoutes`
   (`src/apiserver/serve.js`) both only ever walk genuine top-level
   statements. A nested `SERVICE` compiled cleanly, `nova serve` booted
   without complaint, and every request against it just 404'd — a
   confusing trap with zero compile-time signal about why. Fixed by
   `E-SEM-044`: the analyzer now tracks exactly which `ServiceDeclaration`
   nodes it saw at genuine top level (phase 1) and rejects any other one
   it encounters during the main traversal, the same "must be top level"
   treatment `PAGE_TITLE_STYLE_NOT_TOP_LEVEL` already gives `TITLE`/
   `STYLE`/`SET` inside a `PAGE`-level `FOR EACH` — not a new kind of
   check, the established one applied to a fourth construct.
2. **Route matching didn't decode percent-encoding.** A route literal is
   stored under its literal, already-decoded text (`API GET "/café"`
   registers the key `"GET /café"`), but a real HTTP client percent-encodes
   non-ASCII/reserved path characters on the wire (`/caf%C3%A9`), and
   `url.pathname` does not decode that back — so such a route could never
   actually be reached by a standards-compliant client. Fixed by decoding
   the incoming request's pathname (`decodeURIComponent`) before the
   routing-table lookup; a malformed percent-sequence in the request
   falls through to the ordinary 404 rather than crashing the request.
