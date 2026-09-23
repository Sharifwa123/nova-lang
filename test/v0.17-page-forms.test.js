// v0.17 (ADR-017) - FORM/INPUT: collecting real, typed user input on a
// page and sending it to a live API via CALL API. Verification follows
// the same discipline as v0.16: test/run-examples.js covers the full
// real-CLI, real-typed-input, real-persisted-record path (guest_book.nova);
// this file covers compiler-output and diagnostic correctness at the
// unit level, plus a compact real-server round trip of its own.
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

const GUESTBOOK = `DATA Message
    author: text
    body: text
END

SERVICE
    API GET "/messages"
        RETURN GET Message
    END

    API POST "/messages"
        SET m = REQUEST AS Message
        SAVE m
        RETURN m
    END
END

PAGE "/"
    FORM
        INPUT author: text "Your name"
        INPUT body: text "Message"
        BUTTON "Post"
            WHEN CLICKED
                CALL API POST "/messages" WITH { author: author, body: body }
            END
        END
    END
END`;

// ---- the real payoff: genuinely typed input reaches a real server ----

test("v0.17: typed FORM input reaches the live API intact, over a real server", async () => {
  const { server, port } = await bootTestServer(GUESTBOOK);
  try {
    const pageHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const scriptSrc = pageHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    for (const m of pageHtml.matchAll(/id="(novaBtn_\d+|novaInput_\d+)"/g)) {
      if (!elements.has(m[1])) {
        elements.set(m[1], {
          value: "",
          checked: false,
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

    elements.get("novaInput_0").value = "Katherine Johnson";
    elements.get("novaInput_1").value = "Trajectory math checks out.";
    await sandbox.novaClick_0();

    assertEqual(elements.get("novaBtn_0").textContent, "Done");

    const messages = await (await fetch(`http://localhost:${port}/messages`)).json();
    assertEqual(messages, [{ author: "Katherine Johnson", body: "Trajectory math checks out." }]);
  } finally {
    await closeServer(server);
  }
});

// ---- compiler-output shape ----

test("v0.17: FORM renders a label + typed input per field, and a submit button", () => {
  const [{ html }] = build(GUESTBOOK);
  assertEqual(html.includes('<label for="novaInput_0">Your name</label>'), true);
  assertEqual(html.includes('<input id="novaInput_0" type="text">'), true);
  assertEqual(html.includes('<label for="novaInput_1">Message</label>'), true);
  assertEqual(html.includes('id="novaBtn_0"'), true);
});

test("v0.17: INPUT type mapping - integer gets step=1, decimal gets step=any, boolean gets a checkbox", () => {
  const [{ html }] = build(`DATA Signup
    age: integer
    price: decimal
    subscribed: boolean
END
SERVICE
    API POST "/signups"
        SET s = REQUEST AS Signup
        RETURN s
    END
END
PAGE "/"
    FORM
        INPUT age: integer
        INPUT price: decimal
        INPUT subscribed: boolean
        BUTTON "Go"
            WHEN CLICKED
                CALL API POST "/signups" WITH { age: age, price: price, subscribed: subscribed }
            END
        END
    END
END`);
  assertEqual(html.includes('<input id="novaInput_0" type="number" step="1">'), true);
  assertEqual(html.includes('<input id="novaInput_1" type="number" step="any">'), true);
  assertEqual(html.includes('<input id="novaInput_2" type="checkbox">'), true);
});

test("v0.17: an omitted INPUT label falls back to the field name", () => {
  const [{ html }] = build(`DATA X
    quantity: integer
END
SERVICE
    API POST "/x"
        SET v = REQUEST AS X
        RETURN v
    END
END
PAGE "/"
    FORM
        INPUT quantity: integer
        BUTTON "Go"
            WHEN CLICKED
                CALL API POST "/x" WITH { quantity: quantity }
            END
        END
    END
END`);
  assertEqual(html.includes('<label for="novaInput_0">quantity</label>'), true);
});

test("v0.17: a CALL API payload field referencing a FORM INPUT compiles to a live, type-converted DOM read", () => {
  const [{ html }] = build(GUESTBOOK);
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assertEqual(scriptSrc.includes('document.getElementById("novaInput_0").value'), true);
});

test("v0.17: a CALL API payload field referencing page-local state compiles to a live `state.x` read (ADR-016's latent bug, fixed)", () => {
  const [{ html }] = build(`DATA Click
    count: integer
END
SERVICE
    API POST "/clicks"
        SET c = REQUEST AS Click
        RETURN c
    END
END
PAGE "/"
    SET count = 0
    BUTTON "Send"
        WHEN CLICKED
            CALL API POST "/clicks" WITH { count: count }
        END
    END
END`);
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assertEqual(scriptSrc.includes('"count": state.count'), true);
});

// ---- diagnostics ----

test("v0.17: INPUT outside a FORM is E-SEM-049", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    INPUT x: text
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.FORM_INPUT_OUTSIDE_FORM)
  );
});

test("v0.17: FORM inside FOR EACH is E-SEM-050", () => {
  assertThrows(
    () =>
      compile(
        `DATA Product
    name: text
END
PAGE "/"
    FOR EACH p IN GET Product
        FORM
            INPUT x: text
        END
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.FORM_NOT_TOP_LEVEL)
  );
});

test("v0.17: a duplicate INPUT name within one FORM is E-SEM-051", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    FORM
        INPUT x: text
        INPUT x: integer
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_FORM_INPUT_NAME)
  );
});

test("v0.17: an INPUT with an unsupported type is E-SEM-052", () => {
  assertThrows(
    () =>
      compile(
        `PAGE "/"
    FORM
        INPUT x: list
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.FORM_INPUT_UNSUPPORTED_TYPE)
  );
});

test("v0.17: CALL API WITH referencing a name that isn't a real FORM INPUT is still E-SEM-047", () => {
  assertThrows(
    () =>
      compile(
        `SERVICE
    API POST "/x"
        RETURN 1
    END
END
PAGE "/"
    FORM
        INPUT x: text
        BUTTON "Go"
            WHEN CLICKED
                CALL API POST "/x" WITH { value: nope }
            END
        END
    END
END`,
        "<test>",
        {}
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.CALL_API_PAYLOAD_NOT_STATIC)
  );
});

test("v0.17: a FORM with no BUTTON is legal (just unusable, not an error)", () => {
  const program = compile(
    `PAGE "/"
    FORM
        INPUT x: text
    END
END`,
    "<test>",
    {}
  );
  assertEqual(program.kind, "Program");
});
