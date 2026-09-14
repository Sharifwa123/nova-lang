import { test, assertEqual, assertThrows } from "./harness.js";
import { compile } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";
import { makeList, makeRecord, makeInt, makeText } from "../src/interpreter/values.js";

function compiles(source, hostGlobals = {}) {
  compile(source, "<test>", hostGlobals);
}

function expectCode(source, code, hostGlobals = {}) {
  assertThrows(
    () => compiles(source, hostGlobals),
    (e) => assertEqual(e.diagnostic.code, code),
    `expected ${code} from: ${source}`
  );
}

test("analyzer: undefined name (E-SEM-001)", () => {
  expectCode('SHOW product.name', CODES.UNDEFINED_NAME);
});

test("analyzer: undefined name inside interpolation", () => {
  expectCode('SHOW "Hello {name}"', CODES.UNDEFINED_NAME);
});

test("analyzer: duplicate procedure (E-SEM-002)", () => {
  expectCode(
    "DO calculateTotal\n    RETURN 1\nEND\n\nDO calculateTotal\n    RETURN 2\nEND",
    CODES.DUPLICATE_PROCEDURE
  );
});

test("analyzer: SET reassignment type mismatch (E-SEM-003)", () => {
  expectCode('SET x = 5\nSET x = "hello"', CODES.REASSIGN_TYPE_MISMATCH);
});

test("analyzer: integer -> decimal widening on SET is allowed", () => {
  compiles("SET x = 5\nSET x = 2.5");
});

test("analyzer: operator type error (E-SEM-004)", () => {
  expectCode('SET total = "5" + 5', CODES.OPERATOR_TYPE_ERROR);
});

test("analyzer: RETURN outside procedure (E-SEM-005)", () => {
  expectCode('SHOW "start"\nRETURN 5', CODES.RETURN_OUTSIDE_PROCEDURE);
});

test("analyzer: CHANGE on undefined name (E-SEM-006)", () => {
  expectCode("CHANGE total = total + 5", CODES.CHANGE_UNDEFINED);
});

test("analyzer: CHANGE on a SET-created name succeeds", () => {
  compiles("SET total = 0\nCHANGE total = total + 1");
});

test("analyzer: FOR EACH over non-list (E-SEM-007)", () => {
  expectCode('SET x = "hello"\nFOR EACH c IN x\n    SHOW c\nEND', CODES.FOR_EACH_NOT_LIST);
});

test("analyzer: FOR EACH over a host-provided list is fine", () => {
  compiles("FOR EACH product IN products\n    SHOW product.name\nEND", {
    products: makeList([makeRecord({ name: makeText("Widget") })]),
  });
});

test("analyzer: REPEAT count not integer (E-SEM-008)", () => {
  expectCode('REPEAT 5.5 TIMES\n    SHOW "hi"\nEND', CODES.REPEAT_COUNT_NOT_INTEGER);
});

test("analyzer: call arity mismatch (E-SEM-009)", () => {
  expectCode("DO add\n    INPUT a\n    INPUT b\n    RETURN a + b\nEND\nSET x = add(1)", CODES.ARITY_MISMATCH);
});

test("analyzer: call to undefined procedure (E-SEM-010)", () => {
  expectCode("SET x = doesNotExist(1)", CODES.UNDEFINED_PROCEDURE);
});

test("analyzer: equality between mismatched types (E-SEM-011)", () => {
  expectCode('SHOW 5 == "5"', CODES.EQUALITY_TYPE_MISMATCH);
});

test("analyzer: block scoping — SET inside IF does not leak out", () => {
  expectCode('IF TRUE\n    SET x = 5\nEND\nSHOW x', CODES.UNDEFINED_NAME);
});

test("analyzer: shadowing inside a block is legal and does not affect the outer binding", () => {
  compiles('SET total = 100\nIF TRUE\n    SET total = 5\n    SHOW total\nEND\nSHOW total');
});

test("analyzer: SET never mutates outward, so accumulation needs CHANGE, not SET", () => {
  // This compiles fine (SET just shadows locally each iteration) - it's a
  // *runtime* behavior gap (see interpreter.test.js), not a static error.
  compiles("SET total = 0\nFOR EACH price IN prices\n    SET total = total + price\nEND\nSHOW total", {
    prices: makeList([makeInt(1), makeInt(2)]),
  });
});

test("analyzer: accepts the full v0.1 accumulation test case (ADR-002)", () => {
  compiles("SET total = 0\nFOR EACH price IN prices\n    CHANGE total = total + price\nEND\nSHOW total", {
    prices: makeList([makeInt(1), makeInt(2), makeInt(3)]),
  });
});

test("analyzer: recursion is permitted", () => {
  compiles(
    "DO factorial\n    INPUT n\n    IF n <= 1\n        RETURN 1\n    END\n    RETURN n * factorial(n - 1)\nEND\nSHOW factorial(5)"
  );
});
