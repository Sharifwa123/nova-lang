// v0.3 (ADR-004) - typed procedures: optional parameter/return type
// annotations, checked by the analyzer, fully backward compatible with
// untyped v0.1/v0.2 procedures.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

// ---- backward compatibility ----

test("v0.3: untyped procedures still compile and run exactly as before", () => {
  const lines = run(
    "DO add\n    INPUT a\n    INPUT b\n    RETURN a + b\nEND\nSHOW add(1, 2)"
  );
  assertEqual(lines, ["3"]);
});

// ---- happy paths ----

test("v0.3: typed parameters and return type, integer->decimal widening on the argument", () => {
  const program = `DO calculateTotal RETURNS decimal
    INPUT price: decimal
    INPUT quantity: integer

    RETURN price * quantity
END
SHOW calculateTotal(10, 3)`;
  // 10 is an integer literal but the parameter is declared decimal - widening applies.
  assertEqual(run(program), ["30"]);
});

test("v0.3: parameter type is used for checks inside the procedure body", () => {
  assertThrows(
    () =>
      compile(
        'DO shout\n    INPUT message: text\n    SHOW message + 1\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.OPERATOR_TYPE_ERROR)
  );
});

test("v0.3: RETURNS integer accepted for an integer RETURN", () => {
  assertEqual(
    run("DO one RETURNS integer\n    RETURN 1\nEND\nSHOW one()"),
    ["1"]
  );
});

test("v0.3: IF/ELSE with every branch returning satisfies RETURNS", () => {
  const program = `DO classify RETURNS text
    INPUT age: integer
    IF age >= 18
        RETURN "adult"
    ELSE
        RETURN "minor"
    END
END
SHOW classify(20)
SHOW classify(10)`;
  assertEqual(run(program), ["adult", "minor"]);
});

test("v0.3: call result's declared return type feeds further type checking", () => {
  // calculateTotal's inferred type is now 'decimal' (not 'unknown'), so
  // adding text to it must be caught, same as any other decimal value.
  assertThrows(
    () =>
      compile(
        'DO getPrice RETURNS decimal\n    RETURN 9.99\nEND\nSHOW getPrice() + "oops"'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.OPERATOR_TYPE_ERROR)
  );
});

// ---- diagnostics ----

test("v0.3: unknown type name is E-SEM-016", () => {
  assertThrows(
    () => compile("DO f\n    INPUT x: banana\n    RETURN x\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_TYPE_NAME)
  );
  assertThrows(
    () => compile("DO f RETURNS banana\n    RETURN 1\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_TYPE_NAME)
  );
});

test("v0.3: argument type mismatch is E-SEM-015", () => {
  assertThrows(
    () =>
      compile(
        'DO greet\n    INPUT name: text\n    SHOW "Hello {name}"\nEND\nSHOW greet(5)'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.ARGUMENT_TYPE_MISMATCH)
  );
});

test("v0.3: RETURN value type mismatch is E-SEM-013", () => {
  assertThrows(
    () => compile('DO f RETURNS integer\n    RETURN "not a number"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.RETURN_TYPE_MISMATCH)
  );
});

test("v0.3: bare RETURN with a declared return type is E-SEM-013", () => {
  assertThrows(
    () => compile("DO f RETURNS integer\n    RETURN\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.RETURN_TYPE_MISMATCH)
  );
});

test("v0.3: falling off the end with a declared return type is E-SEM-014", () => {
  assertThrows(
    () => compile('DO f RETURNS integer\n    SHOW "no return here"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.NOT_ALL_PATHS_RETURN)
  );
});

test("v0.3: IF without ELSE does not satisfy RETURNS (loop-free case)", () => {
  assertThrows(
    () =>
      compile(
        'DO f RETURNS integer\n    INPUT x: integer\n    IF x > 0\n        RETURN x\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.NOT_ALL_PATHS_RETURN)
  );
});

test("v0.3: a RETURN inside REPEAT never counts as a guaranteed return (conservative by design)", () => {
  assertThrows(
    () =>
      compile(
        'DO f RETURNS integer\n    REPEAT 5 TIMES\n        RETURN 1\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.NOT_ALL_PATHS_RETURN)
  );
});

test("v0.3: unannotated parameters/return stay fully permissive ('unknown')", () => {
  // No RETURNS declared - a text RETURN is fine, matching v0.1/v0.2 behavior.
  compile('DO f\n    RETURN "any type is fine"\nEND');
});
