// v0.14 (ADR-015) - API POST and REQUEST AS <DataType>: reading and
// validating a real JSON request body.
//
// Verification matches the discipline every prior milestone insists on:
// the real-payoff tests actually POST real JSON to a real running server
// and check the real response - not just the parsed AST or an in-process
// return value.
import http from "node:http";
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile } from "../src/nova.js";
import { Interpreter } from "../src/interpreter/interpreter.js";
import { collectApiRoutes, createRequestListener } from "../src/apiserver/serve.js";
import { CODES } from "../src/diagnostics/codes.js";

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

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CATALOG = `DATA Product
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
END`;

// ---- real HTTP verification (the real payoff) ----

test("v0.14: POST with a matching JSON body creates and returns a real record over real HTTP", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await postJSON(port, "/products", { name: "Widget", price: 9.99 });
    assertEqual(res.status, 200);
    assertEqual(await res.json(), { name: "Widget", price: 9.99 });
  } finally {
    await closeServer(server);
  }
});

test("v0.14: a record created by POST is visible to a later GET (SAVE inside REQUEST AS still genuinely live)", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    assertEqual(await (await fetch(`http://localhost:${port}/products`)).json(), []);
    await postJSON(port, "/products", { name: "Gizmo", price: 14.5 });
    assertEqual(await (await fetch(`http://localhost:${port}/products`)).json(), [{ name: "Gizmo", price: 14.5 }]);
  } finally {
    await closeServer(server);
  }
});

test("v0.14: POST with a missing field is a 400 with a JSON error body, not a crash", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await postJSON(port, "/products", { name: "Widget" });
    assertEqual(res.status, 400);
    const body = await res.json();
    assertEqual(typeof body.error, "string");
  } finally {
    await closeServer(server);
  }
});

test("v0.14: POST with a wrong-typed field is a 400", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await postJSON(port, "/products", { name: "Widget", price: "not a number" });
    assertEqual(res.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("v0.14: POST with a non-object JSON body (an array) is a 400", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await postJSON(port, "/products", [1, 2, 3]);
    assertEqual(res.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("v0.14: POST with syntactically invalid JSON is a 400, not a crash", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await fetch(`http://localhost:${port}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    assertEqual(res.status, 400);
    const server2Ok = await fetch(`http://localhost:${port}/products`); // server still alive
    assertEqual(server2Ok.status, 200);
  } finally {
    await closeServer(server);
  }
});

test("v0.14: extra fields in the POST body beyond the DATA shape are ignored, not rejected", async () => {
  const { server, port } = await bootTestServer(CATALOG);
  try {
    const res = await postJSON(port, "/products", { name: "Widget", price: 9.99, sku: "extra-ignored" });
    assertEqual(res.status, 200);
    assertEqual(await res.json(), { name: "Widget", price: 9.99 });
  } finally {
    await closeServer(server);
  }
});

test("v0.14: a genuine runtime error (divide-by-zero) AFTER a valid REQUEST is still 500, not 400", async () => {
  const { server, port } = await bootTestServer(`DATA Product
    name: text
    price: decimal
END
SERVICE
    API POST "/boom"
        SET p = REQUEST AS Product
        RETURN 1 / 0
    END
END`);
  try {
    const res = await postJSON(port, "/boom", { name: "x", price: 1.0 });
    assertEqual(res.status, 500);
  } finally {
    await closeServer(server);
  }
});

// ---- parsing / static checks ----

test("v0.14: REQUEST AS parses inside an API POST handler and round-trips through SAVE", () => {
  compile(CATALOG);
});

test("v0.14: REQUEST used inside a GET handler is E-SEM-042", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
SERVICE
    API GET "/x"
        SET p = REQUEST AS Product
        RETURN p
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.REQUEST_OUTSIDE_POST_HANDLER)
  );
});

test("v0.14: REQUEST used at the top level (outside any API handler) is E-SEM-042", () => {
  assertThrows(
    () => compile('DATA Product\n    name: text\nEND\nSET p = REQUEST AS Product'),
    (e) => assertEqual(e.diagnostic.code, CODES.REQUEST_OUTSIDE_POST_HANDLER)
  );
});

test("v0.14: REQUEST used inside a DO procedure (even one a POST handler calls) is E-SEM-042 - checked at declaration, not call site", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
DO helper
    SET p = REQUEST AS Product
    RETURN p
END
SERVICE
    API POST "/x"
        RETURN helper()
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.REQUEST_OUTSIDE_POST_HANDLER)
  );
});

test("v0.14: REQUEST AS an unknown DATA type reuses UNKNOWN_DATA_TYPE_IN_GET", () => {
  assertThrows(
    () => compile('SERVICE\n    API POST "/x"\n        SET p = REQUEST AS NoSuchType\n        RETURN p\n    END\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_TYPE_IN_GET)
  );
});

test("v0.14: REQUEST AS a DATA type with a non-primitive field is E-SEM-043", () => {
  assertThrows(
    () =>
      compile(`DATA Address
    city: text
END
DATA Customer
    name: text
    home: Address
END
SERVICE
    API POST "/x"
        SET c = REQUEST AS Customer
        RETURN c
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.REQUEST_TYPE_UNSUPPORTED_FIELD)
  );
});

test("v0.14: two API declarations for GET and POST on the SAME route are not a duplicate (different methods)", () => {
  compile(CATALOG); // GET "/products" and POST "/products" coexist
});

test("v0.14: ASK is still rejected inside a POST handler, same as GET (E-SEM-041 unchanged by this ADR)", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
SERVICE
    API POST "/x"
        SET n = ASK "Name? "
        RETURN n
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.API_HANDLER_ASK_NOT_ALLOWED)
  );
});
