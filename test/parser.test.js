import { test, assertEqual, assertThrows } from "./harness.js";
import { Lexer } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";
import { NovaError } from "../src/diagnostics/diagnostic.js";
import { CODES } from "../src/diagnostics/codes.js";

// Strips `span`/token-span info so tests can assert AST *shape* without
// pinning exact source locations.
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "span") continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

function parseSource(source) {
  const tokens = new Lexer(source).tokenize();
  return parse(tokens, source, "<test>");
}

test("parser: SET with binary expression", () => {
  const program = parseSource("SET total = price * quantity");
  assertEqual(strip(program.statements), [
    {
      kind: "SetStatement",
      name: { kind: "Identifier", name: "total" },
      value: {
        kind: "BinaryOp",
        operator: "*",
        left: { kind: "Identifier", name: "price" },
        right: { kind: "Identifier", name: "quantity" },
      },
    },
  ]);
});

test("parser: CHANGE statement", () => {
  const program = parseSource("CHANGE total = total + price");
  assertEqual(strip(program.statements)[0].kind, "ChangeStatement");
});

test("parser: IF/ELSE IF/ELSE is one flat IfStatement node", () => {
  const program = parseSource(
    `IF age >= 65\n    SHOW "Senior"\nELSE IF age >= 18\n    SHOW "Adult"\nELSE\n    SHOW "Child"\nEND`
  );
  const stmt = strip(program.statements)[0];
  assertEqual(stmt.kind, "IfStatement");
  assertEqual(stmt.branches.length, 2);
  assertEqual(stmt.elseBranch.length, 1);
});

test("parser: FOR EACH", () => {
  const program = parseSource('FOR EACH product IN products\n    SHOW product\nEND');
  const stmt = strip(program.statements)[0];
  assertEqual(stmt.kind, "ForEachStatement");
  assertEqual(stmt.loopVariable.name, "product");
  assertEqual(stmt.iterable.name, "products");
});

test("parser: REPEAT", () => {
  const program = parseSource('REPEAT 5 TIMES\n    SHOW "Hi"\nEND');
  const stmt = strip(program.statements)[0];
  assertEqual(stmt.kind, "RepeatStatement");
  assertEqual(stmt.count.value, 5);
});

test("parser: DO / INPUT / RETURN and call expression", () => {
  const program = parseSource(
    `DO calculateTotal\n    INPUT price\n    INPUT quantity\n    RETURN price * quantity\nEND\nSET result = calculateTotal(10, 3)`
  );
  const [proc, set] = strip(program.statements);
  assertEqual(proc.kind, "ProcedureDeclaration");
  assertEqual(proc.parameters.map((p) => p.name.name), ["price", "quantity"]);
  assertEqual(proc.body[0].kind, "ReturnStatement");
  assertEqual(set.value.kind, "CallExpression");
  assertEqual(set.value.arguments.length, 2);
});

test("parser: bare RETURN", () => {
  const program = parseSource("DO nothing\n    RETURN\nEND");
  assertEqual(strip(program.statements)[0].body[0], { kind: "ReturnStatement", value: null });
});

test("parser: comparisons do not chain", () => {
  assertThrows(
    () => parseSource("SHOW a < b < c"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNEXPECTED_TOKEN)
  );
});

test("parser: field access binds tighter than ==", () => {
  const program = parseSource('SHOW product.name == "x"');
  const expr = strip(program.statements)[0].value;
  assertEqual(expr.kind, "BinaryOp");
  assertEqual(expr.left, { kind: "FieldAccess", target: { kind: "Identifier", name: "product" }, field: "name" });
});

test("parser error: missing END reports E-PARSE-001", () => {
  assertThrows(
    () => parseSource('IF age >= 18\n    SHOW "Adult"'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNCLOSED_BLOCK)
  );
});

test("parser error: unexpected END reports E-PARSE-002", () => {
  assertThrows(
    () => parseSource('SHOW "Hello"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNEXPECTED_END)
  );
});

test("parser error: second ELSE reports E-PARSE-003", () => {
  assertThrows(
    () =>
      parseSource(
        'IF age >= 18\n    SHOW "Adult"\nELSE\n    SHOW "Minor"\nELSE\n    SHOW "Unreachable"\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_ELSE)
  );
});

test("parser error: FOR EACH missing IN reports E-PARSE-004", () => {
  assertThrows(
    () => parseSource("FOR EACH product products\n    SHOW product\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.MALFORMED_FOR_EACH)
  );
});

test("parser error: REPEAT missing TIMES reports E-PARSE-005", () => {
  assertThrows(
    () => parseSource('REPEAT 5\n    SHOW "hi"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.MALFORMED_REPEAT)
  );
});

test("parser error: reserved word as identifier", () => {
  assertThrows(
    () => parseSource("SET DATA = 5"),
    (e) => assertEqual(e.diagnostic.code, CODES.RESERVED_WORD_AS_IDENTIFIER)
  );
});

test("parser: empty IF branch is legal", () => {
  const program = parseSource('IF x > 0\nELSE\n    SHOW "not positive"\nEND');
  const stmt = strip(program.statements)[0];
  assertEqual(stmt.branches[0].body, []);
});
