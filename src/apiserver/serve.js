// ADR-014 — SERVICE/API compiled to a real, live HTTP server (`nova
// serve`): each request runs its API's body fresh against the SAME
// interpreter/store a prior boot run already populated, so SAVE/GET/
// DELETE inside a handler see genuinely live, shared state across
// requests - unlike PAGE's build-time-only snapshot (ADR-012).
import http from "node:http";
import { NovaError } from "../diagnostics/diagnostic.js";

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

// The actual (req, res) => void handler. A NovaError from a handler body
// (a genuine NOVA runtime error, e.g. divide-by-zero) becomes a 500 with
// the diagnostic message as JSON, without taking the server down - the
// one place this ADR departs from "let a NovaError propagate untouched",
// because one bad request killing every other in-flight/future request
// would defeat the point of a long-running server. Any other exception (a
// genuine interpreter bug, not a NOVA-level error) is left to propagate,
// matching TryStatement's own existing rule (ADR-010).
export function createRequestListener(interpreter, routes) {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const api = routes.get(`${req.method} ${url.pathname}`);
    if (!api) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `No API endpoint for ${req.method} ${url.pathname}` }));
      return;
    }
    try {
      const result = interpreter.invokeApiHandler(api.body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(valueToJSON(result)));
    } catch (e) {
      if (e instanceof NovaError) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.diagnostic.message }));
        return;
      }
      throw e;
    }
  };
}

// Starts listening and returns the live http.Server (so `nova serve` can
// just start it, and tests can close it). `port: 0` asks the OS for an
// ephemeral port - the actual bound port (not necessarily `port`) is what
// gets logged, read back from the server itself once it's listening.
export function startServer(interpreter, program, { port = 3000, log = console.log } = {}) {
  const routes = collectApiRoutes(program);
  const server = http.createServer(createRequestListener(interpreter, routes));
  server.listen(port, () => {
    log(`NOVA service listening on http://localhost:${server.address().port}`);
  });
  return server;
}
