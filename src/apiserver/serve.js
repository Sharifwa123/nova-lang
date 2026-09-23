// ADR-014 — SERVICE/API compiled to a real, live HTTP server (`nova
// serve`): each request runs its API's body fresh against the SAME
// interpreter/store a prior boot run already populated, so SAVE/GET/
// DELETE inside a handler see genuinely live, shared state across
// requests - unlike PAGE's build-time-only snapshot (ADR-012).
import http from "node:http";
import { NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";
import { collectPageRoutes } from "../pagecompiler/compile.js";
import { parseRoutePattern, routeHasParams, matchRoutePattern } from "./routePattern.js";

// ADR-015 — these two are, definitionally, "the client sent a body that
// doesn't match what this endpoint declared it needs" - a client error,
// not a server one, unlike every other NovaError (which stays 500, per
// ADR-014).
const CLIENT_ERROR_CODES = new Set([CODES.REQUEST_BODY_NOT_OBJECT, CODES.REQUEST_BODY_FIELD_MISMATCH]);

// Flattens every SERVICE block's API declarations into one routing table,
// keyed by "<METHOD> <route>" (already validated globally unique by the
// analyzer). Mirrors how pagecompiler/compile.js walks the same
// `program.statements` list for PageDeclaration nodes.
export function collectApiRoutes(program) {
  const routes = new Map();
  for (const stmt of program.statements) {
    if (stmt.kind !== "ServiceDeclaration") continue;
    for (const api of stmt.apis) {
      routes.set(`${api.method} ${api.route}`, api);
    }
  }
  return routes;
}

// ADR-019 — every route containing a ":name" segment, pre-compiled to a
// pattern (routePattern.js), kept separate from the flat exact-match map
// above: a real request tries that map first (unchanged - every static
// route keeps its exact behavior), and only falls back to walking this
// list on a miss. The analyzer has already rejected any two routes whose
// shapes could both match one request (E-SEM-055), so at most one entry
// here can ever match a given (method, pathname).
export function collectParameterizedApiRoutes(program) {
  const routes = [];
  for (const stmt of program.statements) {
    if (stmt.kind !== "ServiceDeclaration") continue;
    for (const api of stmt.apis) {
      if (!routeHasParams(api.route)) continue;
      routes.push({ method: api.method, pattern: parseRoutePattern(api.route), api });
    }
  }
  return routes;
}

// Converts a NOVA runtime value (values.js's { type, value } shape) into a
// plain JSON-serializable JS value - the response-body analogue of
// display() in values.js, for a JSON audience instead of SHOW's text one.
export function valueToJSON(v) {
  switch (v.type) {
    case "integer":
    case "decimal":
    case "text":
    case "boolean":
      return v.value;
    case "list":
      return v.value.map(valueToJSON);
    case "record": {
      const out = {};
      for (const [key, val] of Object.entries(v.value)) out[key] = valueToJSON(val);
      return out;
    }
    case "none":
    default:
      return null;
  }
}

// ADR-015 — buffers a POST body (NOVA's interpreter is synchronous - no
// `await` inside execStatements - so a handler must receive an
// already-parsed value, not a stream) and JSON.parse()s it. A parse
// failure is treated exactly like "no body at all": REQUEST AS <Type>'s
// own runtime shape-check reports the same "not a valid <Type>" story
// either way, so there's no need for a separate diagnostic here.
async function readJsonBody(req) {
  if (req.method !== "POST") return null;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ADR-019 — tries the exact-match flat map first (unchanged for every
// static route), then falls back to walking the parameterized routes for
// the same method. Returns { api, pathParams } or null.
function resolveApiMatch(routes, parameterizedRoutes, method, pathname) {
  const exact = routes.get(`${method} ${pathname}`);
  if (exact) return { api: exact, pathParams: {} };
  for (const { method: routeMethod, pattern, api } of parameterizedRoutes) {
    if (routeMethod !== method) continue;
    const pathParams = matchRoutePattern(pattern, pathname);
    if (pathParams) return { api, pathParams };
  }
  return null;
}

async function handleRequest(req, res, interpreter, routes, pageRoutes, persist, parameterizedRoutes = []) {
  const url = new URL(req.url, "http://localhost");
  // Declared routes are stored under their literal, already-decoded text
  // (e.g. `API GET "/café"` registers the key "GET /café"), but a real
  // client sends non-ASCII/reserved characters percent-encoded on the wire
  // ("/caf%C3%A9"), and url.pathname does NOT decode that back - so the
  // lookup key has to be decoded to match. A malformed percent-sequence
  // (invalid input, not this endpoint's fault) just falls through to the
  // ordinary 404 below rather than crashing the request.
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  const match = resolveApiMatch(routes, parameterizedRoutes, req.method, pathname);
  if (!match) {
    // ADR-016 — a GET request that doesn't match a declared API falls
    // through to a compiled PAGE at the same route, if one exists (both
    // now live on the one server). The analyzer already rejects a PAGE
    // and an API GET sharing a route (E-SEM-048), so this lookup can
    // never be ambiguous.
    if (req.method === "GET" && pageRoutes.has(pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageRoutes.get(pathname));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No API endpoint for ${req.method} ${pathname}` }));
    return;
  }
  const { api, pathParams } = match;
  const requestBody = await readJsonBody(req);
  try {
    let result;
    try {
      result = interpreter.invokeApiHandler(api.body, requestBody, pathParams);
    } finally {
      // ADR-018 — a handler reaching this point may have already run
      // SAVE/DELETE before erroring (e.g. a mismatched second REQUEST AS
      // call after a first SAVE succeeded), so this persists on either
      // path below, not just the success one - matching the pre-existing
      // in-memory behavior, where whatever mutations happened, happened,
      // regardless of the handler's eventual outcome.
      persist?.();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(valueToJSON(result)));
  } catch (e) {
    // A NovaError from a handler body (a genuine NOVA runtime error) never
    // takes the server down - the one place this ADR departs from "let a
    // NovaError propagate untouched", because one bad request killing
    // every other in-flight/future request would defeat the point of a
    // long-running server. A body-shape mismatch (ADR-015) is the client's
    // fault (400); everything else stays 500, as ADR-014 established. Any
    // OTHER exception (a genuine interpreter bug, not a NOVA-level error)
    // is left to propagate, matching TryStatement's own rule (ADR-010).
    if (e instanceof NovaError) {
      const status = CLIENT_ERROR_CODES.has(e.diagnostic.code) ? 400 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.diagnostic.message }));
      return;
    }
    throw e;
  }
}

// The actual (req, res) => void handler passed to http.createServer.
// `persist`, if given (ADR-018 — `nova serve` only; every existing/
// in-process caller omits it and stays purely in-memory, unchanged), is
// called once after every request that reached a declared API handler.
// `parameterizedRoutes` (ADR-019) defaults to none - every existing/
// in-process caller that omits it keeps its exact prior behavior.
export function createRequestListener(interpreter, routes, pageRoutes = new Map(), persist = null, parameterizedRoutes = []) {
  return (req, res) => {
    handleRequest(req, res, interpreter, routes, pageRoutes, persist, parameterizedRoutes).catch((e) => {
      // An actual interpreter bug reaching here, already past the
      // NovaError handling above - crash loudly rather than hide it
      // (Node's default for an uncaught exception in a request handler).
      process.nextTick(() => {
        throw e;
      });
    });
  };
}

// Starts listening and returns the live http.Server (so `nova serve` can
// just start it, and tests can close it). `port: 0` asks the OS for an
// ephemeral port - the actual bound port (not necessarily `port`) is what
// gets logged, read back from the server itself once it's listening.
export function startServer(interpreter, program, { port = 3000, log = console.log, persist = null } = {}) {
  const routes = collectApiRoutes(program);
  const parameterizedRoutes = collectParameterizedApiRoutes(program); // ADR-019
  // ADR-016 — PAGE routes are compiled once here, against the same
  // already-populated store `nova build` uses (ADR-012's snapshot model
  // is unchanged: pages do not recompile per request).
  const pageRoutes = collectPageRoutes(program, interpreter.store);
  const server = http.createServer(createRequestListener(interpreter, routes, pageRoutes, persist, parameterizedRoutes));
  server.listen(port, () => {
    log(`NOVA service listening on http://localhost:${server.address().port}`);
  });
  return server;
}
