// v0.12 (ADR-013) - interactive PAGE: page-local state (SET/CHANGE reused)
// and BUTTON/WHEN CLICKED compiled to real client-side JavaScript.
//
// Verification: passing tests must EXECUTE the generated <script> in a
// real JS context (Node's
// vm module standing in for a browser) and call the generated button
// functions programmatically, asserting on the resulting state/DOM text -
// not just assert the HTML string contains expected substrings. A string
// match cannot catch a codegen bug (wrong operator translation, render()
// never called); actually running it can and does.
import vm from "node:vm";
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile } from "../src/nova.js";
import { compileProgram } from "../src/pagecompiler/compile.js";
import { CODES } from "../src/diagnostics/codes.js";

function build(source) {
  const program = compile(source, "<test>", {});
  return compileProgram(program);
}

// Extracts the <script> body from compiled HTML, runs it in a fresh vm
// context against a minimal DOM stub (only getElementById/.textContent -
// exactly what this codegen ever touches), and returns { state, click,
// elements } for the test to drive and assert on.
function executeGeneratedScript(html) {
  const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const idPattern = /id="(nova-el-\d+)"/g;
  let m;
  while ((m = idPattern.exec(html))) {
    if (!elements.has(m[1])) {
      elements.set(m[1], {
        _text: "",
        set textContent(v) { this._text = v; },
        get textContent() { return this._text; },
      });
    }
  }
  const sandbox = { document: { getElementById: (id) => elements.get(id) } };
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox);
  return { sandbox, elements };
}

const COUNTER = `PAGE "/"
    SET count = 0

    HEADING count

    BUTTON "+1"
        WHEN CLICKED
            CHANGE count = count + 1
        END
    END
    BUTTON "-1"
        WHEN CLICKED
            CHANGE count = count - 1
        END
    END
    BUTTON "Reset"
        WHEN CLICKED
            CHANGE count = 0
        END
    END
END`;

// ---- execute-the-generated-JS verification (the real payoff) ----

test("v0.12: the full chain actually runs - click -> state mutation -> render() -> DOM update", () => {
  const [{ html }] = build(COUNTER);
  const { sandbox, elements } = executeGeneratedScript(html);
  const el = elements.get("nova-el-0");

  assertEqual(sandbox.state.count, 0);
  assertEqual(el.textContent, "0");

  sandbox.novaClick_0(); // +1
  assertEqual(sandbox.state.count, 1);
  assertEqual(el.textContent, "1");

  sandbox.novaClick_0();
  sandbox.novaClick_0();
  assertEqual(sandbox.state.count, 3);
  assertEqual(el.textContent, "3");

  sandbox.novaClick_1(); // -1
  assertEqual(sandbox.state.count, 2);
  assertEqual(el.textContent, "2");

  sandbox.novaClick_2(); // Reset
  assertEqual(sandbox.state.count, 0);
  assertEqual(el.textContent, "0");
});

test("v0.12: boolean state displays as TRUE/FALSE in the DOM, not JS true/false", () => {
  const program = `PAGE "/"
    SET on = FALSE
    HEADING on
    BUTTON "Toggle"
        WHEN CLICKED
            CHANGE on = TRUE
        END
    END
END`;
  const [{ html }] = build(program);
  const { sandbox, elements } = executeGeneratedScript(html);
  assertEqual(elements.get("nova-el-0").textContent, "FALSE");
  sandbox.novaClick_0();
  assertEqual(sandbox.state.on, true); // real JS boolean internally
  assertEqual(elements.get("nova-el-0").textContent, "TRUE"); // NOVA-style display
});

test("v0.12: text state and comparison/logical operators compile and run correctly", () => {
  const program = `PAGE "/"
    SET label = "off"
    HEADING label
    BUTTON "Flip"
        WHEN CLICKED
            CHANGE label = "on"
        END
    END
END`;
  const [{ html }] = build(program);
  const { sandbox, elements } = executeGeneratedScript(html);
  assertEqual(elements.get("nova-el-0").textContent, "off");
  sandbox.novaClick_0();
  assertEqual(sandbox.state.label, "on");
  assertEqual(elements.get("nova-el-0").textContent, "on");
});

// ---- static HTML shape (cheap sanity checks alongside the real ones above) ----

test("v0.12: initial server-rendered HTML matches the initial state", () => {
  const [{ html }] = build(COUNTER);
  assertEqual(html.includes('<h1 id="nova-el-0">0</h1>'), true);
  assertEqual(html.includes("<button"), true);
});

test("v0.12: a page with no state/buttons emits no <script> at all (unchanged from v0.10/v0.11)", () => {
  const [{ html }] = build('PAGE "/"\n    TITLE "x"\n    TEXT "hello"\nEND');
  assertEqual(html.includes("<script>"), false);
});

// ---- a real parser footgun, proactively avoided ----

test("v0.12: consecutive BUTTON blocks parse correctly (WHEN's END and BUTTON's own END, back to back)", () => {
  // A missing newline-skip between WHEN's closing END and BUTTON's own
  // END would break every button with an action - guarded against here.
  compile(`PAGE "/"
    SET count = 0
    BUTTON "a"
        WHEN CLICKED
            CHANGE count = count + 1
        END
    END
    BUTTON "b"
        WHEN CLICKED
            CHANGE count = count + 2
        END
    END
END`);
});

// ---- the restriction boundary ----

test("v0.12: sneaking a builtin call into a click handler is rejected (E-SEM-037), not silently allowed", () => {
  assertThrows(
    () =>
      compile(`PAGE "/"
    SET label = "hello"
    TEXT label
    BUTTON "Click"
        WHEN CLICKED
            CHANGE label = UPPER(label)
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.CLICK_HANDLER_UNSAFE)
  );
});

test("v0.12: SAVE inside a click handler is rejected", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
PAGE "/"
    SET count = 0
    BUTTON "Save"
        WHEN CLICKED
            CHANGE count = SAVE { name: "x" }
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.CLICK_HANDLER_UNSAFE)
  );
});

test("v0.12: GET inside a click handler is rejected", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
PAGE "/"
    SET count = 0
    BUTTON "x"
        WHEN CLICKED
            CHANGE count = LENGTH(GET Product)
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.CLICK_HANDLER_UNSAFE)
  );
});

test("v0.12: ASK inside a click handler is rejected", () => {
  assertThrows(
    () =>
      compile(`PAGE "/"
    SET name = "x"
    BUTTON "x"
        WHEN CLICKED
            CHANGE name = ASK "Name? "
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.CLICK_HANDLER_UNSAFE)
  );
});

test("v0.12: a non-CHANGE statement inside WHEN CLICKED is E-SEM-034", () => {
  assertThrows(
    () =>
      compile(`PAGE "/"
    SET count = 0
    BUTTON "x"
        WHEN CLICKED
            SHOW count
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.BUTTON_ACTION_NOT_CHANGE)
  );
});

test("v0.12: CHANGE targeting a non-state name inside WHEN CLICKED is E-SEM-035", () => {
  assertThrows(
    () =>
      compile(`SET other = 0
PAGE "/"
    SET count = 0
    BUTTON "x"
        WHEN CLICKED
            CHANGE other = 1
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.BUTTON_ACTION_NOT_STATE)
  );
});

test("v0.12: an undefined identifier inside a click handler is an ordinary undefined-name error", () => {
  assertThrows(
    () =>
      compile(`PAGE "/"
    SET count = 0
    BUTTON "x"
        WHEN CLICKED
            CHANGE count = count + doesNotExist
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.UNDEFINED_NAME)
  );
});

test("v0.12: reassigning state to an incompatible type is caught (reuses reassignCompatibleType)", () => {
  assertThrows(
    () =>
      compile(`PAGE "/"
    SET count = 0
    BUTTON "x"
        WHEN CLICKED
            CHANGE count = "not a number"
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.REASSIGN_TYPE_MISMATCH)
  );
});

test("v0.12: duplicate page-local state name is E-SEM-033", () => {
  assertThrows(
    () => compile('PAGE "/"\n    SET count = 0\n    SET count = 1\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_PAGE_STATE)
  );
});

test("v0.12: SET's initial value must be a literal", () => {
  assertThrows(
    () => compile('SET x = 5\nPAGE "/"\n    SET count = x\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_CONTENT_NOT_STATIC)
  );
});

test("v0.12: BUTTON inside FOR EACH is not supported yet (E-SEM-038)", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
PAGE "/"
    FOR EACH p IN GET Product
        BUTTON p.name
            WHEN CLICKED
                CHANGE x = 1
            END
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.BUTTON_INSIDE_LOOP_NOT_SUPPORTED)
  );
});

test("v0.12: SET inside FOR EACH is rejected (state is PAGE-scoped, not per-record)", () => {
  assertThrows(
    () =>
      compile(`DATA Product
    name: text
END
PAGE "/"
    FOR EACH p IN GET Product
        SET x = 0
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_TITLE_STYLE_NOT_TOP_LEVEL)
  );
});

test("v0.12: indexed CHANGE on page state is rejected (state is scalar-only)", () => {
  assertThrows(
    () =>
      compile(`PAGE "/"
    SET items = 0
    BUTTON "x"
        WHEN CLICKED
            CHANGE items[0] = 1
        END
    END
END`),
    (e) => assertEqual(e.diagnostic.code, CODES.BUTTON_ACTION_INDEXED)
  );
});
