// v0.16 (ADR-016) - PAGE/SERVICE integration: BUTTON inside FOR EACH,
// CALL API as a new click-handler statement, and nova serve serving PAGE
// routes alongside API routes from one server.
//
// Verification follows the same discipline v0.12/v0.13/v0.14 established:
// the real payoff tests EXECUTE the generated <script> in a real JS
// context (vm) with a fetch shim pointed at a genuinely live, spawned
// server (test/run-examples.js covers the full real-CLI, real-click,
// real-persisted-reservation path; this file covers compiler-output and
// diagnostic correctness at the unit level).
import vm from "node:vm";
import http from "node:http";
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile } from "../src/nova.js";
import { Interpreter } from "../src/interpreter/interpreter.js";
import { compileProgram, collectPageRoutes } from "../src/pagecompiler/compile.js";
import { collectApiRoutes, createRequestListener } from "../src/apiserver/serve.js";
import { CODES } from "../src/diagnostics/codes.js";

function build(source) {
  const program = compile(source, "<test>", {});
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  interpreter.run();
  return compileProgram(program, interpreter.store);
}

function bootTestServer(source) {
  const program = compile(source, "<test>", {});
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  interpreter.run();
  const routes = collectApiRoutes(program);
  const pageRoutes = collectPageRoutes(program, interpreter.store);
  const server = http.createServer(createRequestListener(interpreter, routes, pageRoutes));
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Executes a compiled page's generated <script> in a vm sandbox whose
// `fetch` rewrites a relative path against a real spawned server's port
// before delegating to Node's real global fetch - so calling the
// generated (now-async) button function issues a genuinely real HTTP
// request, exactly like a real click in a real browser would.
function executeGeneratedScript(html, port) {
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  for (const m of html.matchAll(/id="(novaBtn_\d+)"/g)) {
    if (!elements.has(m[1])) {
      elements.set(m[1], {
        disabled: false,
        _text: "",
        set textContent(v) { this._text = v; },
        get textContent() { return this._text; },
      });
    }
  }
  const sandbox = {
    document: { getElementById: (id) => elements.get(id) },
    fetch: (url, opts) => fetch(`http://localhost:${port}${url}`, opts),
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox);
  return { sandbox, elements };
}

const BOOKING_APP = `DATA Room
    number: integer
    roomType: text
END

DATA Reservation
    roomNumber: integer
END

DO makeRoom RETURNS Room
    INPUT n: integer
    INPUT t: text
    RETURN { number: n, roomType: t }
END

SAVE makeRoom(101, "Single")
SAVE makeRoom(201, "Double")

PAGE "/"
    FOR EACH room IN GET Room
        HEADING room.roomType
        BUTTON "Book Now"
            WHEN CLICKED
                CALL API POST "/reservations" WITH { roomNumber: room.number }
            END
        END
    END
END

SERVICE
    API GET "/reservations"
        RETURN GET Reservation
    END

    API POST "/reservations"
        SET r = REQUEST AS Reservation
        SAVE r
        RETURN r
    END
END`;

// ---- the real payoff: a real click really books a room ----

test("v0.16: a per-record BUTTON's CALL API really books the right room on a real server", async () => {
  const { server, port } = await bootTestServer(BOOKING_APP);
  try {
    const before = await (await fetch(`http://localhost:${port}/reservations`)).json();
    assertEqual(before.length, 0);

    const pageHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const { sandbox, elements } = executeGeneratedScript(pageHtml, port);
    const btn = elements.get("novaBtn_1"); // second room -> roomNumber 201
    await sandbox.novaClick_1();

    assertEqual(btn.textContent, "Done");
    assertEqual(btn.disabled, true);

    const after = await (await fetch(`http://localhost:${port}/reservations`)).json();
    assertEqual(after.length, 1);
    assertEqual(after[0].roomNumber, 201);
  } finally {
    await closeServer(server);
  }
});

test("v0.16: nova serve's PAGE route and API routes coexist on one server", async () => {
  const { server, port } = await bootTestServer(BOOKING_APP);
  try {
    const page = await fetch(`http://localhost:${port}/`);
    assertEqual(page.status, 200);
    assertEqual((await page.text()).includes("<!DOCTYPE html>"), true);
    const rooms = await fetch(`http://localhost:${port}/reservations`);
    assertEqual(rooms.status, 200);
  } finally {
    await closeServer(server);
  }
});

// ---- compiler-output shape ----

test("v0.16: a CHANGE-only button stays synchronous (no behavior change)", () => {
  const [{ html }] = build(`PAGE "/"
    SET count = 0
    BUTTON "+1"
        WHEN CLICKED
            CHANGE count = count + 1
        END
    END
END`);
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assertEqual(scriptSrc.includes("async function novaClick_0"), false);
  assertEqual(scriptSrc.includes("function novaClick_0() {"), true);
});

test("v0.16: a CALL API button compiles to an async function with a stable button id", () => {
  const [{ html }] = build(BOOKING_APP);
  assertEqual(html.includes('id="novaBtn_0"'), true);
  assertEqual(html.includes('id="novaBtn_1"'), true);
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assertEqual(scriptSrc.includes("async function novaClick_0"), true);
  assertEqual(scriptSrc.includes('await fetch("/reservations"'), true);
  assertEqual(scriptSrc.includes('"roomNumber": 101'), true);
  assertEqual(scriptSrc.includes('"roomNumber": 201'), true);
});

// ---- diagnostics ----

test("v0.16: CALL API outside a click handler is E-SEM-045 (top level)", () => {
  assertThrows(
    () => compile('CALL API GET "/x"', "<test>", {}),
    (e) => assertEqual(e.diagnostic.code, CODES.CALL_API_OUTSIDE_CLICK_HANDLER)
  );
});

test("v0.16: CALL API outside a click handler is E-SEM-045 (inside a DO body)", () => {
  assertThrows(
    () =>
      compile(
        `DO thing
    CALL API GET "/x"
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.CALL_API_OUTSIDE_CLICK_HANDLER)
  );
});

test("v0.16: CALL API referencing an undeclared route is E-SEM-046", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    SET x = 0
    BUTTON "Go"
        WHEN CLICKED
            CALL API POST "/nope"
        END
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.CALL_API_UNKNOWN_ROUTE)
  );
});

test("v0.16: CALL API method mismatch against a declared route is also E-SEM-046", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    SET x = 0
    BUTTON "Go"
        WHEN CLICKED
            CALL API GET "/reservations"
        END
    END
END

SERVICE
    API POST "/reservations"
        RETURN 1
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.CALL_API_UNKNOWN_ROUTE)
  );
});

test("v0.16: a CALL API WITH payload field that isn't a literal/loopVar/state ref is E-SEM-047", () => {
  assertThrows(
    () =>
      compile(
        `SET outside = 5
PAGE "/"
    SET x = 0
    BUTTON "Go"
        WHEN CLICKED
            CALL API POST "/reservations" WITH { roomNumber: outside }
        END
    END
END

SERVICE
    API POST "/reservations"
        RETURN 1
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.CALL_API_PAYLOAD_NOT_STATIC)
  );
});

test("v0.16: a CALL API WITH payload field CAN reference the loop variable's own field", () => {
  const program = compile(BOOKING_APP, "<test>", {});
  assertEqual(program.kind, "Program");
});

test("v0.16: a PAGE route colliding with an API GET route is E-SEM-048", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    HEADING "hi"
END

SERVICE
    API GET "/"
        RETURN 1
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_ROUTE_COLLIDES_WITH_API)
  );
});

test("v0.16: a PAGE route does NOT collide with an API POST route at the same path", () => {
  const program = compile(
    `PAGE "/"
    HEADING "hi"
END

SERVICE
    API POST "/"
        RETURN 1
    END
END`,
    "<test>",
    {}
  );
  assertEqual(program.kind, "Program");
});

test("v0.16: only CHANGE or CALL API are allowed inside WHEN CLICKED (E-SEM-034)", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    SET x = 0
    BUTTON "Go"
        WHEN CLICKED
            SHOW "nope"
        END
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.BUTTON_ACTION_NOT_CHANGE)
  );
});
