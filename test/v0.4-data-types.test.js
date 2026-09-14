// v0.4 (ADR-005) - DATA named types: a pure compile-time naming layer over
// the existing structural record/list runtime, with exact-match literal
// checking and static field-type tracking as the payoff.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

// ---- happy paths ----

test("v0.4: DATA type as a parameter annotation, checked against a record literal", () => {
  const program = `DATA Product
    name: text
    price: decimal
END

DO describe RETURNS text
    INPUT p: Product
    RETURN "{p.name}: {p.price}"
END

SHOW describe({ name: "Widget", price: 9.99 })`;
  assertEqual(run(program), ["Widget: 9.99"]);
});

test("v0.4: DATA type as a RETURNS type, checked against a record literal", () => {
  const program = `DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT pr: decimal
    RETURN { name: n, price: pr }
END

SET gadget = makeProduct("Gadget", 19.99)
SHOW gadget.name
SHOW gadget.price`;
  assertEqual(run(program), ["Gadget", "19.99"]);
});

test("v0.4: static field access on a DATA-typed parameter returns the field's declared type", () => {
  // p.price is a decimal per DATA Product - adding text to it must be
  // caught, exactly as it would for any other decimal value.
  assertThrows(
    () =>
      compile(
        'DATA Product\n    price: decimal\nEND\nDO f\n    INPUT p: Product\n    SHOW p.price + "oops"\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.OPERATOR_TYPE_ERROR)
  );
});

test("v0.4: self-referencing DATA type (linked structure)", () => {
  compile("DATA Node\n    value: integer\n    next: Node\nEND");
});

test("v0.4: forward-referencing DATA types (declared in either order)", () => {
  compile("DATA Order\n    product: Product\nEND\nDATA Product\n    name: text\nEND");
});

test("v0.4: DATA type name and procedure name are separate namespaces", () => {
  compile("DATA Product\n    name: text\nEND\nDO Product\n    RETURN 1\nEND");
});

test("v0.4: untyped/unannotated code is completely unaffected", () => {
  compile('DATA Product\n    name: text\nEND\nSET x = { anything: "goes" }\nSHOW x.anything');
});

// ---- diagnostics ----

test("v0.4: duplicate DATA type name is E-SEM-017", () => {
  assertThrows(
    () => compile("DATA Product\n    name: text\nEND\nDATA Product\n    price: decimal\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_DATA_TYPE)
  );
});

test("v0.4: duplicate field within one DATA declaration is E-SEM-012 (shared with record literals)", () => {
  assertThrows(
    () => compile("DATA Product\n    name: text\n    name: integer\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_FIELD)
  );
});

test("v0.4: missing field on a literal checked against a DATA type is E-SEM-018", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\n    price: decimal\nEND\nDO f\n    INPUT p: Product\n    RETURN p\nEND\nSHOW f({ name: "x" })'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.MISSING_DATA_FIELD)
  );
});

test("v0.4: wrong field type on a literal checked against a DATA type is E-SEM-019", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    price: decimal\nEND\nDO f\n    INPUT p: Product\n    RETURN p\nEND\nSHOW f({ price: "not a number" })'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.DATA_FIELD_TYPE_MISMATCH)
  );
});

test("v0.4: extra field on a literal checked against a DATA type is E-SEM-020", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nDO f\n    INPUT p: Product\n    RETURN p\nEND\nSHOW f({ name: "x", extra: 1 })'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.UNEXPECTED_DATA_FIELD)
  );
});

test("v0.4: unknown type name (not a primitive or a DATA type) is E-SEM-016", () => {
  assertThrows(
    () => compile("DATA Product\n    name: banana\nEND"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_TYPE_NAME)
  );
});

test("v0.4: static field access naming a nonexistent field on a known DATA type is E-SEM-021", () => {
  assertThrows(
    () =>
      compile(
        "DATA Product\n    name: text\nEND\nDO f\n    INPUT p: Product\n    SHOW p.price\nEND"
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_FIELD_ACCESS)
  );
});

test("v0.4: same check applies through string interpolation's dotted path", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nDO f\n    INPUT p: Product\n    SHOW "{p.price}"\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_FIELD_ACCESS)
  );
});

test("v0.4: two different DATA types remain incompatible with each other", () => {
  assertThrows(
    () =>
      compile(
        "DATA Product\n    name: text\nEND\nDATA Order\n    id: integer\nEND\nDO f\n    INPUT p: Product\n    RETURN p\nEND\nDO g RETURNS Order\n    INPUT o: Order\n    RETURN o\nEND\nSHOW f(g({ id: 1 }))"
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.ARGUMENT_TYPE_MISMATCH)
  );
});

test("v0.4: a plain 'record'-typed value flows permissively into a DATA-typed slot when shape isn't statically visible", () => {
  // p comes back from a generic (unannotated) procedure, so its static
  // type is 'unknown' -> always compatible, no exact-shape check applies
  // (that only happens for a literal used directly at the point of use).
  compile(
    'DO getAnything\n    RETURN { name: "x", price: 9.99 }\nEND\nDATA Product\n    name: text\n    price: decimal\nEND\nDO f\n    INPUT p: Product\n    RETURN p\nEND\nSHOW f(getAnything())'
  );
});
