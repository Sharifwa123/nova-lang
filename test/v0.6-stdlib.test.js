// v0.6 (ADR-007) - a small standard library: UPPER/LOWER/TRIM/LENGTH/
// ROUND/ABS, called with the exact same syntax as a user DO procedure.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

// ---- happy paths ----

test("v0.6: UPPER/LOWER/TRIM on text", () => {
  assertEqual(run('SHOW UPPER("hello")'), ["HELLO"]);
  assertEqual(run('SHOW LOWER("WORLD")'), ["world"]);
  assertEqual(run('SHOW TRIM("  padded  ")'), ["padded"]);
});

test("v0.6: LENGTH on text and on a list", () => {
  assertEqual(run('SHOW LENGTH("hello")'), ["5"]);
  assertEqual(run("SHOW LENGTH([1, 2, 3])"), ["3"]);
  assertEqual(run("SHOW LENGTH([])"), ["0"]);
});

test("v0.6: ROUND to nearest integer", () => {
  assertEqual(run("SHOW ROUND(3.7)"), ["4"]);
  assertEqual(run("SHOW ROUND(3.2)"), ["3"]);
  assertEqual(run("SHOW ROUND(5)"), ["5"]);
});

test("v0.6: ABS always returns decimal, even for an integer input", () => {
  assertEqual(run("SHOW ABS(-5)"), ["5"]);
  assertEqual(run("SHOW ABS(-3.14)"), ["3.14"]);
});

test("v0.6: built-ins compose with ordinary expressions and user procedures", () => {
  const program = `DO shout RETURNS text
    INPUT s: text
    RETURN UPPER(TRIM(s))
END
SHOW shout("  hi  ")`;
  assertEqual(run(program), ["HI"]);
});

// ---- static checking on the typed built-ins ----

test("v0.6: UPPER/LOWER/TRIM's text parameter is statically checked", () => {
  assertThrows(
    () => compile("SHOW UPPER(5)"),
    (e) => assertEqual(e.diagnostic.code, CODES.ARGUMENT_TYPE_MISMATCH)
  );
});

test("v0.6: LENGTH/ROUND/ABS accept any static type (checked at the call, at runtime)", () => {
  // No static error for passing something structurally odd - it's only
  // caught when actually run, per ADR-007.
  compile("SHOW LENGTH(5)");
  compile('SHOW ROUND("x")');
});

// ---- runtime diagnostics ----

test("v0.6: LENGTH on an unsupported type is E-RUN-003", () => {
  assertThrows(
    () => run("SHOW LENGTH(5)"),
    (e) => assertEqual(e.diagnostic.code, CODES.BUILTIN_ARGUMENT_TYPE)
  );
});

test("v0.6: ROUND on an unsupported type is E-RUN-003", () => {
  assertThrows(
    () => run('SHOW ROUND("x")'),
    (e) => assertEqual(e.diagnostic.code, CODES.BUILTIN_ARGUMENT_TYPE)
  );
});

test("v0.6: ABS on an unsupported type is E-RUN-003", () => {
  assertThrows(
    () => run("SHOW ABS(TRUE)"),
    (e) => assertEqual(e.diagnostic.code, CODES.BUILTIN_ARGUMENT_TYPE)
  );
});

// ---- namespace collision ----

test("v0.6: redefining a built-in with DO is a duplicate-procedure error, not silent shadowing", () => {
  assertThrows(
    () => compile("DO UPPER\n    RETURN 1\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_PROCEDURE)
  );
});

test("v0.6: built-in arity is still checked", () => {
  assertThrows(
    () => compile('SHOW UPPER("a", "b")'),
    (e) => assertEqual(e.diagnostic.code, CODES.ARITY_MISMATCH)
  );
});
