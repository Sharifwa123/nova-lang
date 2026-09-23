// v0.18 (ADR-019) - API DELETE + path parameters. Real end-to-end HTTP
// (a real DELETE against a real spawned server, real path-param routing)
// is covered by test/run-examples.js's api_service.nova block; this file
// covers the route-pattern module, parser/analyzer diagnostics, and
// serve.js's request-matching/param-binding logic at the unit level.
import http from "node:http";
import { test, assertEqual, assertTrue, assertThrows } from "./harness.js";
import { compile } from "../src/nova.js";
import { Interpreter } from "../src/interpreter/interpreter.js";
import { makeRecord, makeText } from "../src/interpreter/values.js";
import {
  collectApiRoutes,
  collectParameterizedApiRoutes,
  createRequestListener,
} from "../src/apiserver/serve.js";
import {
  parseRoutePattern,
  isValidParamName,
  routeHasParams,
  routeShapeKey,
  matchRoutePattern,
} from "../src/apiserver/routePattern.js";
import { CODES } from "../src/diagnostics/codes.js";

// ---- routePattern.js ----

test("v0.19: parseRoutePattern splits a route into static and param segments", () => {
  assertEqual(parseRoutePattern("/products/:id/reviews"), [
    { kind: "static", value: "products" },
    { kind: "param", name: "id" },
    { kind: "static", value: "reviews" },
  ]);
});

test("v0.19: isValidParamName accepts a plain identifier, rejects a keyword or malformed name", () => {
  assertTrue(isValidParamName("id"));
  assertTrue(isValidParamName("productId"));
  assertTrue(!isValidParamName("IF")); // a NOVA keyword
  assertTrue(!isValidParamName("123abc")); // doesn't start with a letter/underscore
  assertTrue(!isValidParamName("has-dash"));
});

test("v0.19: routeHasParams distinguishes a fully static route from a parameterized one", () => {
  assertTrue(!routeHasParams("/products"));
  assertTrue(routeHasParams("/products/:id"));
});

test("v0.19: routeShapeKey collapses param names so differently-named params share a shape", () => {
  assertEqual(routeShapeKey(parseRoutePattern("/products/:id")), routeShapeKey(parseRoutePattern("/products/:pid")));
  assertTrue(routeShapeKey(parseRoutePattern("/products/:id")) !== routeShapeKey(parseRoutePattern("/products")));
});

test("v0.19: matchRoutePattern binds an integer segment and rejects a non-integer one", () => {
  const pattern = parseRoutePattern("/products/:id");
  assertEqual(matchRoutePattern(pattern, "/products/5"), { id: 5 });
  assertEqual(matchRoutePattern(pattern, "/products/not-a-number"), null);
  assertEqual(matchRoutePattern(pattern, "/products"), null); // wrong segment count
  assertEqual(matchRoutePattern(pattern, "/products/5/extra"), null);
});

test("v0.19: matchRoutePattern requires every static segment to match literally", () => {
  const pattern = parseRoutePattern("/products/:id/reviews");
  assertEqual(matchRoutePattern(pattern, "/products/5/reviews"), { id: 5 });
  assertEqual(matchRoutePattern(pattern, "/products/5/photos"), null);
});

// ---- parser/analyzer ----

test("v0.19: API DELETE parses and type-checks a path parameter as an ordinary integer local", () => {
  const program = compile(
    `DATA Product
    name: text
END
SERVICE
    API DELETE "/products/:id"
        DELETE Product id
    END
END`,
    "<test>",
    {}
  );
  assertEqual(program.kind, "Program");
});

test("v0.19: a path parameter used as text is a type error, exactly like any other integer local", () => {
  assertThrows(
    () =>
      compile(
        `SERVICE
    API DELETE "/x/:id"
        SHOW id
        SET t = "prefix" + id
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.OPERATOR_TYPE_ERROR)
  );
});

test("v0.19: a reserved/keyword path parameter name is E-SEM-053", () => {
  // NOVA keywords are case-sensitive, uppercase-only spellings (§2.6) -
  // ":IF" collides with the keyword; ":if" would be an ordinary
  // identifier and is covered by isValidParamName's own unit test above.
  assertThrows(
    () => compile(`SERVICE\n    API DELETE "/x/:IF"\n        RETURN 1\n    END\nEND`, "<test>", {}),
    (e) => assertEqual(e.diagnostic.code, CODES.INVALID_PATH_PARAM_NAME)
  );
});

test("v0.19: a malformed path parameter name is E-SEM-053", () => {
  assertThrows(
    () => compile(`SERVICE\n    API DELETE "/x/:123"\n        RETURN 1\n    END\nEND`, "<test>", {}),
    (e) => assertEqual(e.diagnostic.code, CODES.INVALID_PATH_PARAM_NAME)
  );
});

test("v0.19: a duplicate path parameter name within one route is E-SEM-054", () => {
  assertThrows(
    () => compile(`SERVICE\n    API DELETE "/x/:id/:id"\n        RETURN 1\n    END\nEND`, "<test>", {}),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_PATH_PARAM_NAME)
  );
});

test("v0.19: two same-method routes whose shapes collide (different param names) is E-SEM-055", () => {
  assertThrows(
    () =>
      compile(
        `SERVICE
    API DELETE "/x/:id"
        RETURN 1
    END
    API DELETE "/x/:pid"
        RETURN 1
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.AMBIGUOUS_API_ROUTE_SHAPE)
  );
});

test("v0.19: a literally-identical route is still the existing E-SEM-039, not the new shape check", () => {
  assertThrows(
    () =>
      compile(
        `SERVICE
    API DELETE "/x/:id"
        RETURN 1
    END
    API DELETE "/x/:id"
        RETURN 1
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_API_ROUTE)
  );
});

test("v0.19: different methods with the same param-route shape do NOT collide", () => {
  const program = compile(
    `SERVICE
    API GET "/x/:id"
        RETURN 1
    END
    API DELETE "/x/:id"
        RETURN 1
    END
END`,
    "<test>",
    {}
  );
  assertEqual(program.kind, "Program");
});

test("v0.19: REQUEST is still rejected inside a DELETE handler (POST-only, ADR-015, unaffected by path params)", () => {
  assertThrows(
    () =>
      compile(
        `DATA X
    n: integer
END
SERVICE
    API DELETE "/x/:id"
        SET v = REQUEST AS X
        RETURN v
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.REQUEST_OUTSIDE_POST_HANDLER)
  );
});

// ---- interpreter / serve.js wiring ----

const PRODUCT_SERVICE = `DATA Product
    name: text
END

SERVICE
    API GET "/products"
        RETURN GET Product
    END

    API DELETE "/products/:id"
        DELETE Product id
    END
END`;

function bootServer(source) {
  const program = compile(source, "<test>", {});
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  interpreter.run();
  const routes = collectApiRoutes(program);
  const parameterizedRoutes = collectParameterizedApiRoutes(program);
  return { interpreter, routes, parameterizedRoutes };
}

function startTestServer(interpreter, routes, parameterizedRoutes) {
  const server = http.createServer(createRequestListener(interpreter, routes, new Map(), null, parameterizedRoutes));
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

test("v0.19: collectParameterizedApiRoutes only returns routes with a param segment", () => {
  const program = compile(
    `SERVICE
    API GET "/products"
        RETURN 1
    END
    API DELETE "/products/:id"
        RETURN 1
    END
END`,
    "<test>",
    {}
  );
  const routes = collectParameterizedApiRoutes(program);
  assertEqual(routes.length, 1);
  assertEqual(routes[0].method, "DELETE");
});

test("v0.19: DELETE against a real in-process server removes exactly the matched record", async () => {
  const { interpreter, routes, parameterizedRoutes } = bootServer(PRODUCT_SERVICE);
  // Two SAVEs via a plain SET/RETURN-less program aren't available here,
  // so seed through the store directly - equivalent to what a boot run's
  // own SAVE statements would populate.
  const { server, port } = await startTestServer(interpreter, routes, parameterizedRoutes);
  try {
    await fetch(`http://localhost:${port}/products`); // sanity: route resolves
    // Seed two products the same way a real program's own SAVE would.
    const collection = interpreter.getCollection("Product");
    const id1 = collection.nextId++;
    collection.records.set(id1, makeRecord({ name: makeText("Widget") }));
    const id2 = collection.nextId++;
    collection.records.set(id2, makeRecord({ name: makeText("Gizmo") }));

    const del = await fetch(`http://localhost:${port}/products/${id1}`, { method: "DELETE" });
    assertEqual(del.status, 200);
    const remaining = await (await fetch(`http://localhost:${port}/products`)).json();
    assertEqual(remaining, [{ name: "Gizmo" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("v0.19: a non-integer path segment doesn't match the route at all - a plain 404, not a 500", async () => {
  const { interpreter, routes, parameterizedRoutes } = bootServer(PRODUCT_SERVICE);
  const { server, port } = await startTestServer(interpreter, routes, parameterizedRoutes);
  try {
    const res = await fetch(`http://localhost:${port}/products/not-a-number`, { method: "DELETE" });
    assertEqual(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("v0.19: an exact static route is still matched via the flat map, not the pattern fallback", async () => {
  const { interpreter, routes, parameterizedRoutes } = bootServer(PRODUCT_SERVICE);
  const { server, port } = await startTestServer(interpreter, routes, parameterizedRoutes);
  try {
    const res = await fetch(`http://localhost:${port}/products`);
    assertEqual(res.status, 200);
    assertEqual(await res.json(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
