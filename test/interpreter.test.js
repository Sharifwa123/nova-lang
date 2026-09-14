import { test, assertEqual, assertThrows } from "./harness.js";
import { runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";
import { makeList, makeInt, makeRecord, makeText, makeDec } from "../src/interpreter/values.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

test("interpreter: hello world", () => {
  assertEqual(run('SHOW "Hello, World!"'), ["Hello, World!"]);
});

test("interpreter: SET + SHOW with interpolation", () => {
  assertEqual(run('SET name = "World"\nSHOW "Hello {name}"'), ["Hello World"]);
});

test("interpreter: dotted-field interpolation on a host record", () => {
  assertEqual(
    run('SHOW "Price: {product.price}"', { product: makeRecord({ price: makeDec(9.99) }) }),
    ["Price: 9.99"]
  );
});

test("interpreter: IF / ELSE IF / ELSE picks the first true branch", () => {
  const program = `SET age = 15
IF age >= 65
    SHOW "Senior"
ELSE IF age >= 18
    SHOW "Adult"
ELSE IF age >= 13
    SHOW "Teen"
ELSE
    SHOW "Child"
END`;
  assertEqual(run(program), ["Teen"]);
});

test("interpreter: FOR EACH over a host list", () => {
  assertEqual(
    run("FOR EACH product IN products\n    SHOW product\nEND", {
      products: makeList([makeText("Widget"), makeText("Gadget")]),
    }),
    ["Widget", "Gadget"]
  );
});

test("interpreter: FOR EACH loop variable does not leak outside the loop", () => {
  assertThrows(() =>
    run("FOR EACH x IN xs\n    SHOW x\nEND\nSHOW x", { xs: makeList([makeInt(1)]) })
  );
});

test("interpreter: REPEAT N TIMES", () => {
  assertEqual(run('REPEAT 3 TIMES\n    SHOW "Hi"\nEND'), ["Hi", "Hi", "Hi"]);
});

test("interpreter: REPEAT with zero/negative count runs zero times", () => {
  assertEqual(run('REPEAT 0 TIMES\n    SHOW "never"\nEND\nSHOW "after"'), ["after"]);
});

test("interpreter: DO / INPUT / RETURN and call expressions", () => {
  const program = `DO calculateTotal
    INPUT price
    INPUT quantity
    SET total = price * quantity
    RETURN total
END
SHOW calculateTotal(10, 3)`;
  assertEqual(run(program), ["30"]);
});

test("interpreter: recursion works", () => {
  const program = `DO factorial
    INPUT n
    IF n <= 1
        RETURN 1
    END
    RETURN n * factorial(n - 1)
END
SHOW factorial(5)`;
  assertEqual(run(program), ["120"]);
});

test("interpreter: falling off a DO body without RETURN yields NONE", () => {
  assertEqual(run('DO doNothing\n    SHOW "ran"\nEND\nSHOW doNothing()'), ["ran", "NONE"]);
});

test("interpreter: ADR-002 accumulation test case (CHANGE)", () => {
  const lines = run(
    "SET total = 0\nFOR EACH price IN prices\n    CHANGE total = total + price\nEND\nSHOW total",
    { prices: makeList([makeInt(10), makeInt(20), makeInt(30)]) }
  );
  assertEqual(lines, ["60"]);
});

test("interpreter: SET inside a loop shadows and does NOT accumulate (the gap CHANGE fixes)", () => {
  const lines = run(
    "SET total = 0\nFOR EACH price IN prices\n    SET total = total + price\nEND\nSHOW total",
    { prices: makeList([makeInt(10), makeInt(20), makeInt(30)]) }
  );
  assertEqual(lines, ["0"]);
});

test("interpreter: shadowing — outer binding is restored after the inner block ends", () => {
  const lines = run('SET total = 100\nIF TRUE\n    SET total = 5\n    SHOW total\nEND\nSHOW total');
  assertEqual(lines, ["5", "100"]);
});

test("interpreter: integer/decimal arithmetic and widening", () => {
  assertEqual(run("SHOW 5 + 2.5"), ["7.5"]);
  assertEqual(run("SHOW 2 * 3"), ["6"]);
});

test("interpreter: division by zero is a runtime error", () => {
  assertThrows(
    () => run("SHOW 5 / 0"),
    (e) => assertEqual(e.diagnostic.code, CODES.DIVIDE_BY_ZERO)
  );
});

test("interpreter: AND/OR short-circuit", () => {
  const calls = [];
  const program = `DO sideEffect
    SHOW "called"
    RETURN TRUE
END
SHOW FALSE AND sideEffect()
SHOW TRUE OR sideEffect()`;
  assertEqual(run(program), ["FALSE", "TRUE"]);
});

test("interpreter: NOT and boolean display", () => {
  assertEqual(run("SHOW NOT TRUE"), ["FALSE"]);
  assertEqual(run("SHOW TRUE"), ["TRUE"]);
});

test("interpreter: equality by value", () => {
  assertEqual(run('SHOW 5 == 5\nSHOW "a" == "b"'), ["TRUE", "FALSE"]);
});
