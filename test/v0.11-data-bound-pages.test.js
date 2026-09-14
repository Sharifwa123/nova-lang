// v0.11 (ADR-012) - data-bound PAGE: FOR EACH...IN GET rendered at
// `nova build` time from an interpreter's populated store. compileProgram
// takes the store directly (bypassing the CLI) so these stay fast,
// in-process unit tests - test/run-examples.js separately verifies the
// real `nova build` CLI path end to end.
import { test, assertEqual, assertThrows, assertTrue } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { Interpreter } from "../src/interpreter/interpreter.js";
import { compileProgram } from "../src/pagecompiler/compile.js";
import { CODES } from "../src/diagnostics/codes.js";

// Mirrors what `nova build` does: compile, run once silently to populate
// the store, then compile pages against it.
function build(source) {
  const program = compile(source, "<test>", {});
  const interpreter = new Interpreter(program, {}, { write: () => {}, writePrompt: () => {} });
  interpreter.run();
  return compileProgram(program, interpreter.store);
}

const PRODUCT_SETUP = `DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT p: decimal
    RETURN { name: n, price: p }
END
`;

// ---- happy paths ----

test("v0.11: FOR EACH...IN GET renders one HEADING/TEXT pair per saved record", () => {
  const program = `${PRODUCT_SETUP}
SAVE makeProduct("Widget", 9.99)
SAVE makeProduct("Gadget", 19.99)

PAGE "/"
    FOR EACH product IN GET Product
        HEADING product.name
        TEXT product.price
    END
END`;
  const [{ html }] = build(program);
  assertTrue(html.includes("<h1>Widget</h1>"));
  assertTrue(html.includes("<p>9.99</p>"));
  assertTrue(html.includes("<h1>Gadget</h1>"));
  assertTrue(html.includes("<p>19.99</p>"));
});

test("v0.11: records render in save order", () => {
  const program = `${PRODUCT_SETUP}
SAVE makeProduct("First", 1)
SAVE makeProduct("Second", 2)
PAGE "/"
    FOR EACH p IN GET Product
        HEADING p.name
    END
END`;
  const [{ html }] = build(program);
  assertTrue(html.indexOf("First") < html.indexOf("Second"));
});

test("v0.11: FOR EACH over an empty collection renders nothing, not an error", () => {
  const program = `DATA Product
    name: text
END
PAGE "/"
    HEADING "Catalog"
    FOR EACH p IN GET Product
        HEADING p.name
    END
    TEXT "done"
END`;
  const [{ html }] = build(program);
  assertTrue(html.includes("<h1>Catalog</h1>"));
  assertTrue(html.includes("<p>done</p>"));
});

test("v0.11: TITLE/STYLE/HEADING/TEXT still work at the PAGE top level alongside FOR EACH", () => {
  const program = `${PRODUCT_SETUP}
SAVE makeProduct("Widget", 9.99)
PAGE "/"
    TITLE "Catalog"
    STYLE "body { margin: 0; }"
    HEADING "Products"
    FOR EACH p IN GET Product
        TEXT p.name
    END
END`;
  const [{ html }] = build(program);
  assertTrue(html.includes("<title>Catalog</title>"));
  assertTrue(html.includes("<style>body { margin: 0; }</style>"));
  assertTrue(html.includes("<h1>Products</h1>"));
  assertTrue(html.includes("<p>Widget</p>"));
});

test("v0.11: compileProgram without a store renders FOR EACH as zero records (backward compatible with v0.10)", () => {
  const program = compile(`DATA Product\n    name: text\nEND\nPAGE "/"\n    FOR EACH p IN GET Product\n        HEADING p.name\n    END\nEND`);
  const [{ html }] = compileProgram(program); // no store argument
  assertTrue(!html.includes("<h1>"));
});

// ---- PAGE stays inert during `nova run` even with FOR EACH/GET ----

test("v0.11: nova run still ignores PAGE (FOR EACH inside it doesn't execute either)", () => {
  const lines = [];
  runSource(
    `${PRODUCT_SETUP}
PAGE "/"
    FOR EACH p IN GET Product
        HEADING p.name
    END
END
SHOW "only this runs"`,
    "<test>",
    {},
    { write: (s) => lines.push(s) }
  );
  assertEqual(lines, ["only this runs"]);
});

// ---- diagnostics ----

test("v0.11: FOR EACH...IN GET with an unknown DATA type is E-SEM-023 (reused)", () => {
  assertThrows(
    () => compile('PAGE "/"\n    FOR EACH p IN GET NotAType\n        TEXT "x"\n    END\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_TYPE_IN_GET)
  );
});

test("v0.11: referencing a field the DATA type doesn't have is E-SEM-021 (reused)", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nPAGE "/"\n    FOR EACH p IN GET Product\n        TEXT p.price\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_FIELD_ACCESS)
  );
});

test("v0.11: TITLE inside a PAGE-level FOR EACH is E-SEM-032", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nPAGE "/"\n    FOR EACH p IN GET Product\n        TITLE p.name\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_TITLE_STYLE_NOT_TOP_LEVEL)
  );
});

test("v0.11: STYLE inside a PAGE-level FOR EACH is E-SEM-032", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nPAGE "/"\n    FOR EACH p IN GET Product\n        STYLE "x"\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_TITLE_STYLE_NOT_TOP_LEVEL)
  );
});

test("v0.11: a loop variable used bare (no field) is still E-SEM-030", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nPAGE "/"\n    FOR EACH p IN GET Product\n        TEXT p\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_CONTENT_NOT_STATIC)
  );
});

test("v0.11: a name that isn't any enclosing loop variable is still E-SEM-030", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nSET other = 5\nPAGE "/"\n    FOR EACH p IN GET Product\n        TEXT other.name\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_CONTENT_NOT_STATIC)
  );
});
