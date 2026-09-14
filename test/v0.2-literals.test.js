// v0.2 (ADR-003) - list and record literal syntax.
import { test, assertEqual, assertThrows } from "./harness.js";
import { Lexer } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";
import { compile } from "../src/nova.js";
import { runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "span" || k === "nameSpan") continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

function parseSource(source) {
  return parse(new Lexer(source).tokenize(), source, "<test>");
}

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

// ---- lexer ----

test("v0.2 lexer: bracket tokens", () => {
  const tokens = new Lexer("[ ] { }").tokenize().map((t) => t.value);
  assertEqual(tokens.slice(0, 4), ["[", "]", "{", "}"]);
});

// ---- parser ----

test("v0.2 parser: empty list and record literals", () => {
  const program = parseSource("SET a = []\nSET b = {}");
  const [a, b] = strip(program.statements);
  assertEqual(a.value, { kind: "ListLiteral", elements: [] });
  assertEqual(b.value, { kind: "RecordLiteral", fields: [] });
});

test("v0.2 parser: list literal with mixed-type elements", () => {
  const program = parseSource('SET a = [1, "two", TRUE]');
  const list = strip(program.statements)[0].value;
  assertEqual(list.kind, "ListLiteral");
  assertEqual(list.elements.map((e) => e.kind), ["IntegerLiteral", "StringLiteral", "BooleanLiteral"]);
});

test("v0.2 parser: record literal fields", () => {
  const program = parseSource("SET p = { x: 1, y: 2 }");
  const record = strip(program.statements)[0].value;
  assertEqual(record.kind, "RecordLiteral");
  assertEqual(record.fields.map((f) => f.name), ["x", "y"]);
});

test("v0.2 parser: trailing comma is allowed", () => {
  const program = parseSource("SET a = [1, 2, 3,]\nSET b = { x: 1, }");
  assertEqual(strip(program.statements)[0].value.elements.length, 3);
  assertEqual(strip(program.statements)[1].value.fields.length, 1);
});

test("v0.2 parser: field access chains off any primary, not just identifiers", () => {
  const program = parseSource("SHOW { x: 1 }.x");
  const expr = strip(program.statements)[0].value;
  assertEqual(expr.kind, "FieldAccess");
  assertEqual(expr.target.kind, "RecordLiteral");
});

test("v0.2 parser: nested list of records", () => {
  const program = parseSource('SET products = [{ name: "Widget" }, { name: "Gadget" }]');
  const list = strip(program.statements)[0].value;
  assertEqual(list.elements.length, 2);
  assertEqual(list.elements[0].kind, "RecordLiteral");
});

// ---- analyzer ----

test("v0.2 analyzer: duplicate field name is E-SEM-012", () => {
  assertThrows(
    () => compile("SET x = { a: 1, a: 2 }"),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_FIELD)
  );
});

test("v0.2 analyzer: FOR EACH over a list literal needs no host injection", () => {
  compile("FOR EACH n IN [1, 2, 3]\n    SHOW n\nEND");
});

test("v0.2 analyzer: nested errors inside literals are still caught", () => {
  assertThrows(
    () => compile("SHOW [1, undefinedName, 3]"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNDEFINED_NAME)
  );
  assertThrows(
    () => compile('SHOW { a: 1, b: "x" + 1 }'),
    (e) => assertEqual(e.diagnostic.code, CODES.OPERATOR_TYPE_ERROR)
  );
});

// ---- interpreter ----

test("v0.2 interpreter: FOR EACH over a list literal, fully self-contained", () => {
  assertEqual(run("FOR EACH n IN [1, 2, 3]\n    SHOW n\nEND"), ["1", "2", "3"]);
});

test("v0.2 interpreter: record literal field access and interpolation", () => {
  assertEqual(
    run('SET product = { name: "Widget", price: 9.99 }\nSHOW "{product.name}: {product.price}"'),
    ["Widget: 9.99"]
  );
});

test("v0.2 interpreter: list of records, classic catalog example", () => {
  const program = `SET products = [
    { name: "Widget", price: 9.99 },
    { name: "Gadget", price: 19.99 }
]

FOR EACH product IN products
    SHOW "{product.name}: {product.price}"
END`;
  assertEqual(run(program), ["Widget: 9.99", "Gadget: 19.99"]);
});

test("v0.2 interpreter: list equality is structural", () => {
  assertEqual(run("SHOW [1, 2, 3] == [1, 2, 3]"), ["TRUE"]);
  assertEqual(run("SHOW [1, 2, 3] == [1, 2]"), ["FALSE"]);
});

test("v0.2 interpreter: record equality is structural, order-independent", () => {
  assertEqual(run("SHOW { x: 1, y: 2 } == { y: 2, x: 1 }"), ["TRUE"]);
  assertEqual(run("SHOW { x: 1 } == { x: 2 }"), ["FALSE"]);
});

test("v0.2 interpreter: field access on a direct call result", () => {
  const program = `DO makePoint
    RETURN { x: 1, y: 2 }
END
SHOW makePoint().x`;
  assertEqual(run(program), ["1"]);
});
