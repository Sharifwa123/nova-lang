// v0.8 (ADR-009) - list indexing (read) and CHANGE-based mutation.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

// ---- read access ----

test("v0.8: basic list indexing", () => {
  assertEqual(run('SET a = ["x", "y", "z"]\nSHOW a[0]\nSHOW a[2]'), ["x", "z"]);
});

test("v0.8: indexing a call/literal result directly (postfix on any primary)", () => {
  assertEqual(run("SHOW [10, 20, 30][1]"), ["20"]);
});

test("v0.8: nested list indexing", () => {
  assertEqual(run("SET m = [[1, 2], [3, 4]]\nSHOW m[1][0]"), ["3"]);
});

test("v0.8: index expression can be any integer-valued expression", () => {
  assertEqual(run("SET a = [10, 20, 30]\nSET i = 1\nSHOW a[i + 1]"), ["30"]);
});

// ---- mutation ----

test("v0.8: CHANGE list[i] = value mutates in place", () => {
  assertEqual(
    run('SET a = ["x", "y", "z"]\nCHANGE a[1] = "Y"\nSHOW a[0]\nSHOW a[1]\nSHOW a[2]'),
    ["x", "Y", "z"]
  );
});

test("v0.8: CHANGE with a chained index mutates a nested list", () => {
  const lines = run("SET m = [[1, 2], [3, 4]]\nCHANGE m[1][0] = 99\nSHOW m[1][0]\nSHOW m[0][0]");
  assertEqual(lines, ["99", "1"]);
});

test("v0.8: lists are reference types - mutation is visible through an alias", () => {
  const lines = run("SET a = [1, 2, 3]\nSET b = a\nCHANGE a[0] = 100\nSHOW b[0]");
  assertEqual(lines, ["100"]);
});

test("v0.8: CHANGE list[i] can assign a mixed type (no element-type tracking)", () => {
  const lines = run('SET a = [1, "two", TRUE]\nCHANGE a[0] = "now text"\nSHOW a[0]');
  assertEqual(lines, ["now text"]);
});

// ---- diagnostics: static ----

test("v0.8: indexing a definitely-non-list value is E-SEM-026", () => {
  assertThrows(
    () => compile('SET s = "hello"\nSHOW s[0]'),
    (e) => assertEqual(e.diagnostic.code, CODES.INDEX_ON_NON_LIST)
  );
});

test("v0.8: a non-integer index is E-SEM-027", () => {
  assertThrows(
    () => compile('SET a = [1, 2, 3]\nSHOW a["x"]'),
    (e) => assertEqual(e.diagnostic.code, CODES.INDEX_NOT_INTEGER)
  );
});

test("v0.8: CHANGE indexing a definitely-non-list value is E-SEM-026", () => {
  assertThrows(
    () => compile('SET s = "hello"\nCHANGE s[0] = "x"'),
    (e) => assertEqual(e.diagnostic.code, CODES.INDEX_ON_NON_LIST)
  );
});

// ---- diagnostics: runtime ----

test("v0.8: out-of-bounds read is E-RUN-005", () => {
  assertThrows(
    () => run("SET a = [1, 2, 3]\nSHOW a[5]"),
    (e) => assertEqual(e.diagnostic.code, CODES.INDEX_OUT_OF_BOUNDS)
  );
});

test("v0.8: negative index is out of bounds, not from-the-end (deferred, per ADR-009)", () => {
  assertThrows(
    () => run("SET a = [1, 2, 3]\nSHOW a[-1]"),
    (e) => assertEqual(e.diagnostic.code, CODES.INDEX_OUT_OF_BOUNDS)
  );
});

test("v0.8: out-of-bounds CHANGE is E-RUN-005", () => {
  assertThrows(
    () => run("SET a = [1, 2, 3]\nCHANGE a[5] = 0"),
    (e) => assertEqual(e.diagnostic.code, CODES.INDEX_OUT_OF_BOUNDS)
  );
});

test("v0.8: indexing something 'unknown'-typed that turns out not to be a list is a runtime error (E-RUN-006)", () => {
  const program = `DO getAnything
    RETURN "not a list"
END
SHOW getAnything()[0]`;
  assertThrows(
    () => run(program),
    (e) => assertEqual(e.diagnostic.code, CODES.RUNTIME_INDEX_ON_NON_LIST)
  );
});
