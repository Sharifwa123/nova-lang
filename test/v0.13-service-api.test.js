// v0.13 (ADR-014) - SERVICE/API: a live HTTP server for GET endpoints,
// sharing the same interpreter/store across requests.
//
// Verification matches the discipline every prior milestone in this repo
// insists on: the real-payoff tests actually start a real Node http
// server and issue real HTTP requests against it (Node's global fetch),
// asserting on the real JSON response - not just on the parsed AST or the
// in-process interpreter return value. A string/shape match on the AST
// alone cannot catch a routing bug, a wrong status code, or a JSON
// encoding bug; actually serving and fetching can and does.
import http from "node:http";
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile } from "../src/nova.js";
import { Interpreter } from "../src/interpreter/interpreter.js";
import { collectApiRoutes, createRequestListener, valueToJSON } from "../src/apiserver/serve.js";
import { CODES } from "../src/diagnostics/codes.js";

// Compiles + boots an interpreter (running top-level statements once,
// silently, exactly like `nova serve` does) and starts a real server on
// an OS-assigned ephemeral port. Returns { server, port }; caller closes.
function bootTestServer(source) {
  const program = compile(source, "<test>", {});
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  interpreter.run();
  const routes = collectApiRoutes(program);
  const server = http.createServer(createRequestListener(interpreter, routes));
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const CATALOG = `DATA Product
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
END`;

// ---- real HTTP verification (the real payoff) ----

test("v0.13: a GET API returns its RETURN value as real JSON over real HTTP", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await fetch(`http://localhost:${port}/hello`);
    assertEqual(res.status, 200);
    assertEqual(res.headers.get("content-type"), "application/json");
    assertEqual(await res.json(), "Hello from NOVA");
  } finally {
    await closeServer(server);
  }
});

test("v0.13: RETURN GET <DataType> serializes saved records to a real JSON array", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await fetch(`http://localhost:${port}/products`);
    assertEqual(res.status, 200);
    assertEqual(await res.json(), [
      { name: "Widget", price: 9.99 },
      { name: "Gizmo", price: 14.5 },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("v0.13: an unmatched method+path is a real 404 with a JSON error body", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await fetch(`http://localhost:${port}/nope`);
    assertEqual(res.status, 404);
    const body = await res.json();
    assertEqual(typeof body.error, "string");
  } finally {
    await closeServer(server);
  }
});

test("v0.13: SAVE inside one request is visible to GET in a LATER, separate request (genuinely live, not a build-time snapshot)", async () => {
  const { server, port } = await bootTestServer(`DATA Note
    text: text
END

DO makeNote RETURNS Note
    INPUT t: text
    RETURN { text: t }
END

SERVICE
    API GET "/add"
        SAVE makeNote("added live")
        RETURN "ok"
    END

    API GET "/notes"
        RETURN GET Note
    END
END`);
  try {
    assertEqual(await (await fetch(`http://localhost:${port}/notes`)).json(), []);
    assertEqual(await (await fetch(`http://localhost:${port}/add`)).json(), "ok");
    // A brand-new request, same process, same store - sees the mutation
    // the earlier request made. PAGE/`nova build` could never do this
    // (ADR-012's model is a one-shot build-time snapshot); this is the
    // thing ADR-014 exists to make possible.
    assertEqual(await (await fetch(`http://localhost:${port}/notes`)).json(), [{ text: "added live" }]);
  } finally {
    await closeServer(server);
  }
});

test("v0.13: a handler that falls off the end without RETURN responds with JSON null", async () => {
  const { server, port } = await bootTestServer(`SERVICE
    API GET "/nothing"
        SET x = 1
    END
END`);
  try {
    const res = await fetch(`http://localhost:${port}/nothing`);
    assertEqual(res.status, 200);
    assertEqual(await res.json(), null);
  } finally {
    await closeServer(server);
  }
});

test("v0.13: a genuine runtime error inside a handler is a 500 with the diagnostic message, and does not crash the server", async () => {
  const { server, port } = await bootTestServer(`SERVICE
    API GET "/boom"
        RETURN 1 / 0
    END
    API GET "/ok"
        RETURN "still alive"
    END
END`);
  try {
    const boom = await fetch(`http://localhost:${port}/boom`);
    assertEqual(boom.status, 500);
    const body = await boom.json();
    assertEqual(typeof body.error, "string");
    // the server is still up for a completely different request afterward
    const ok = await fetch(`http://localhost:${port}/ok`);
    assertEqual(ok.status, 200);
    assertEqual(await ok.json(), "still alive");
  } finally {
    await closeServer(server);
  }
});

// ---- valueToJSON, directly ----

test("v0.13: valueToJSON maps every NOVA runtime type to its JSON equivalent", () => {
  assertEqual(valueToJSON({ type: "integer", value: 3 }), 3);
  assertEqual(valueToJSON({ type: "decimal", value: 3.5 }), 3.5);
  assertEqual(valueToJSON({ type: "text", value: "hi" }), "hi");
  assertEqual(valueToJSON({ type: "boolean", value: true }), true);
  assertEqual(valueToJSON({ type: "none", value: null }), null);
  assertEqual(
    valueToJSON({ type: "list", value: [{ type: "integer", value: 1 }, { type: "integer", value: 2 }] }),
    [1, 2]
  );
  assertEqual(
    valueToJSON({ type: "record", value: { a: { type: "integer", value: 1 }, b: { type: "text", value: "x" } } }),
    { a: 1, b: "x" }
  );
});

// ---- parsing / static checks ----

test("v0.13: SERVICE/API parses and the handler body can use ordinary NOVA statements", () => {
  compile(`DATA Item
    name: text
END
SERVICE
    API GET "/items"
        SET count = 0
        FOR EACH i IN GET Item
            CHANGE count = count + 1
        END
        RETURN count
    END
END`);
});

test("v0.13: only GET/POST are accepted after API (ADR-015 adds POST) - any other word is a plain parse error", () => {
  assertThrows(
    () => compile('SERVICE\n    API DELETE "/x"\n        RETURN 1\n    END\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNEXPECTED_TOKEN)
  );
});

test("v0.13: an API route not starting with / is E-SEM-040", () => {
  assertThrows(
    () => compile('SERVICE\n    API GET "products"\n        RETURN 1\n    END\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.INVALID_API_ROUTE)
  );
});

test("v0.13: two API declarations sharing a method+route is E-SEM-039", () => {
  assertThrows(
    () =>
      compile(`SERVICE
    API GET "/x"
        RETURN 1
    END
    API GET "/x"
        RETURN 2
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_API_ROUTE)
  );
});

test("v0.13: the same route across two separate SERVICE blocks is still caught (checked globally)", () => {
  assertThrows(
    () =>
      compile(`SERVICE
    API GET "/x"
        RETURN 1
    END
END
SERVICE
    API GET "/x"
        RETURN 2
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_API_ROUTE)
  );
});

test("v0.13: ASK directly inside an API handler is E-SEM-041 (would hang the server on every request)", () => {
  assertThrows(
    () =>
      compile(`SERVICE
    API GET "/ask"
        SET name = ASK "Name? "
        RETURN name
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.API_HANDLER_ASK_NOT_ALLOWED)
  );
});

test("v0.13: unlike WHEN CLICKED, a handler CAN call procedures, SAVE, and GET - it is not sandboxed", () => {
  compile(`DATA Product
    name: text
    price: decimal
END
DO makeProduct RETURNS Product
    INPUT n: text
    INPUT pr: decimal
    RETURN { name: n, price: pr }
END
SERVICE
    API GET "/seed"
        SAVE makeProduct("Widget", 9.99)
        RETURN GET Product
    END
END`);
});

test("v0.13: an undefined name inside a handler is an ordinary undefined-name error, reusing infer()", () => {
  assertThrows(
    () => compile('SERVICE\n    API GET "/x"\n        RETURN doesNotExist\n    END\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNDEFINED_NAME)
  );
});

test("v0.13: SERVICE/API is inert during nova run's ordinary interpretation - no crash, nothing executes", () => {
  const program = compile(`SERVICE
    API GET "/x"
        RETURN 1 / 0
    END
END
SHOW "still runs"`);
  const output = [];
  const interpreter = new Interpreter(program, {}, { write: (s) => output.push(s) });
  interpreter.run();
  assertEqual(output, ["still runs"]);
});

// ---- review fixes: nested SERVICE, and percent-encoded routes ----

test("v0.13: a SERVICE nested inside DO is rejected at compile time (E-SEM-044), not silently accepted as an unreachable route", () => {
  // Before this check: registerService (phase 1) only walks genuine
  // top-level statements, so a nested SERVICE compiled cleanly but
  // collectApiRoutes (src/apiserver/serve.js) found no route for it at
  // all - `nova serve` would boot fine and every request against it would
  // just 404, with zero compile-time signal about why.
  assertThrows(
    () =>
      compile(`DO setup
    SERVICE
        API GET "/nested"
            RETURN "hi"
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.SERVICE_NOT_TOP_LEVEL)
  );
});

test("v0.13: a SERVICE nested inside IF is also rejected (E-SEM-044)", () => {
  assertThrows(
    () =>
      compile(`IF TRUE
    SERVICE
        API GET "/x"
            RETURN 1
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.SERVICE_NOT_TOP_LEVEL)
  );
});

test("v0.13: a real percent-encoded HTTP request matches a route literal with non-ASCII characters", async () => {
  const { server, port } = await bootTestServer(`SERVICE
    API GET "/café"
        RETURN "bonjour"
    END
END`);
  try {
    // A real client percent-encodes non-ASCII path characters on the wire
    // ("/caf%C3%A9") - url.pathname does NOT decode that back, so the
    // route table has to be looked up against the decoded form to match
    // the literal, already-decoded route NOVA parsed from source.
    const res = await fetch(`http://localhost:${port}/caf%C3%A9`);
    assertEqual(res.status, 200);
    assertEqual(await res.json(), "bonjour");
  } finally {
    await closeServer(server);
  }
});

test("v0.13: a malformed percent-encoded request path falls through to an ordinary 404, not a crash", async () => {
  const { server, port } = await bootTestServer(`SERVICE
    API GET "/x"
        RETURN 1
    END
END`);
  try {
    const res = await fetch(`http://localhost:${port}/caf%zz`);
    assertEqual(res.status, 404);
  } finally {
    await closeServer(server);
  }
});
