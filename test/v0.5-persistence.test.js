// v0.5 (ADR-006) - in-memory persistence: SAVE / GET / DELETE, one
// collection per DATA type, integer ids, no durability yet.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

const PRODUCT_SETUP = `DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT pr: decimal
    RETURN { name: n, price: pr }
END
`;

// ---- happy paths ----

test("v0.5: SAVE returns a fresh integer id, starting at 1", () => {
  const program = `${PRODUCT_SETUP}
SET id1 = SAVE makeProduct("Widget", 9.99)
SET id2 = SAVE makeProduct("Gadget", 19.99)
SHOW id1
SHOW id2`;
  assertEqual(run(program), ["1", "2"]);
});

test("v0.5: GET returns all saved records, in insertion order, as a plain list", () => {
  const program = `${PRODUCT_SETUP}
SAVE makeProduct("Widget", 9.99)
SAVE makeProduct("Gadget", 19.99)
FOR EACH product IN GET Product
    SHOW "{product.name}: {product.price}"
END`;
  assertEqual(run(program), ["Widget: 9.99", "Gadget: 19.99"]);
});

test("v0.5: GET on a type with nothing saved yet returns an empty list", () => {
  const program = `DATA Product\n    name: text\nEND\nFOR EACH p IN GET Product\n    SHOW p\nEND\nSHOW "done"`;
  assertEqual(run(program), ["done"]);
});

test("v0.5: DELETE removes exactly the record with that id", () => {
  const program = `${PRODUCT_SETUP}
SET id1 = SAVE makeProduct("Widget", 9.99)
SET id2 = SAVE makeProduct("Gadget", 19.99)
DELETE Product id1
FOR EACH product IN GET Product
    SHOW product.name
END`;
  assertEqual(run(program), ["Gadget"]);
});

test("v0.5: DELETE on an id that doesn't exist is a silent no-op (idempotent)", () => {
  const program = `${PRODUCT_SETUP}
DELETE Product 999
SHOW "still fine"`;
  assertEqual(run(program), ["still fine"]);
});

test("v0.5: separate DATA types get separate collections, ids independent", () => {
  const program = `DATA Product
    name: text
END
DATA Order
    total: integer
END
DO makeProduct RETURNS Product
    INPUT n: text
    RETURN { name: n }
END
DO makeOrder RETURNS Order
    INPUT t: integer
    RETURN { total: t }
END
SET p1 = SAVE makeProduct("Widget")
SET o1 = SAVE makeOrder(100)
SET p2 = SAVE makeProduct("Gadget")
SHOW p1
SHOW o1
SHOW p2`;
  // Product's ids and Order's ids are independent counters.
  assertEqual(run(program), ["1", "1", "2"]);
});

test("v0.5: SAVE record shape is preserved exactly - no injected id field", () => {
  const program = `DATA Product
    name: text
END
DO makeProduct RETURNS Product
    INPUT n: text
    RETURN { name: n }
END
SAVE makeProduct("Widget")
FOR EACH p IN GET Product
    SHOW p == { name: "Widget" }
END`;
  assertEqual(run(program), ["TRUE"]);
});

// ---- diagnostics ----

test("v0.5: SAVE on a plain untyped record literal is E-SEM-022", () => {
  assertThrows(
    () => compile('DATA Product\n    name: text\nEND\nSHOW SAVE { name: "x" }'),
    (e) => assertEqual(e.diagnostic.code, CODES.SAVE_REQUIRES_DATA_TYPE)
  );
});

test("v0.5: SAVE on a generic 'unknown'-typed value is still rejected (no runtime fallback)", () => {
  assertThrows(
    () =>
      compile(
        'DATA Product\n    name: text\nEND\nDO getAnything\n    RETURN { name: "x" }\nEND\nSHOW SAVE getAnything()'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.SAVE_REQUIRES_DATA_TYPE)
  );
});

test("v0.5: GET on an unknown DATA type is E-SEM-023", () => {
  assertThrows(
    () => compile("SHOW GET NotAType"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_TYPE_IN_GET)
  );
});

test("v0.5: DELETE on an unknown DATA type is E-SEM-024", () => {
  assertThrows(
    () => compile("DELETE NotAType 1"),
    (e) => assertEqual(e.diagnostic.code, CODES.UNKNOWN_DATA_TYPE_IN_DELETE)
  );
});

test("v0.5: DELETE with a non-integer id is E-SEM-025", () => {
  assertThrows(
    () => compile('DATA Product\n    name: text\nEND\nDELETE Product "one"'),
    (e) => assertEqual(e.diagnostic.code, CODES.DELETE_ID_NOT_INTEGER)
  );
});

test("v0.5: a typed INPUT parameter (not just a RETURNS result) can also be SAVEd", () => {
  const program = `DATA Product
    name: text
END
DO store RETURNS integer
    INPUT p: Product
    RETURN SAVE p
END
SET id = store({ name: "Widget" })
SHOW id`;
  assertEqual(run(program), ["1"]);
});
