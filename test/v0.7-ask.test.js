// v0.7 (ADR-008) - ASK: real synchronous input. Tests use a canned `input`
// list (the "automated suite with canned input queues" verification path
// the original chat itself described); test/run-examples.js separately
// pipes real stdin into the CLI, matching the original's other path.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, input = []) {
  const lines = [];
  const prompts = [];
  runSource(source, "<test>", {}, {
    write: (s) => lines.push(s),
    writePrompt: (s) => prompts.push(s),
    input,
  });
  return { lines, prompts };
}

// ---- happy paths ----

test("v0.7: ASK returns the next canned line as text", () => {
  const { lines } = run('SET name = ASK "Name? "\nSHOW "Hi {name}"', ["World"]);
  assertEqual(lines, ["Hi World"]);
});

test("v0.7: the prompt is written without SHOW's trailing newline", () => {
  const { prompts } = run('SET name = ASK "Name? "\nSHOW name', ["World"]);
  assertEqual(prompts, ["Name? "]);
});

test("v0.7: multiple ASKs consume canned input in order", () => {
  const { lines } = run(
    'SET a = ASK "A? "\nSET b = ASK "B? "\nSHOW a\nSHOW b',
    ["first", "second"]
  );
  assertEqual(lines, ["first", "second"]);
});

test("v0.7: ASK works inside a loop, consuming one line per iteration", () => {
  const program = `REPEAT 3 TIMES
    SET answer = ASK "> "
    SHOW answer
END`;
  const { lines } = run(program, ["a", "b", "c"]);
  assertEqual(lines, ["a", "b", "c"]);
});

test("v0.7: ASK's prompt can be any expression, not just a literal", () => {
  const { prompts } = run('SET n = "World"\nSET x = ASK "Hello {n}, age? "', ["30"]);
  assertEqual(prompts, ["Hello World, age? "]);
});

test("v0.7: ASK's result composes with existing text operations", () => {
  const { lines } = run('SET name = ASK "Name? "\nSHOW UPPER(name)', ["widget"]);
  assertEqual(lines, ["WIDGET"]);
});

// ---- diagnostics ----

test("v0.7: ASK using text where its result is used numerically is a static type error, not silently wrong", () => {
  assertThrows(
    () => compile('SET age = ASK "Age? "\nSHOW age + 1'),
    (e) => assertEqual(e.diagnostic.code, CODES.OPERATOR_TYPE_ERROR)
  );
});

test("v0.7: exhausted input is E-RUN-004, not empty text or NONE", () => {
  assertThrows(
    () => run('SET a = ASK "A? "\nSET b = ASK "B? "', ["only-one"]),
    (e) => assertEqual(e.diagnostic.code, CODES.ASK_NO_INPUT)
  );
});

test("v0.7: an empty canned line is a valid answer, distinct from exhaustion", () => {
  const { lines } = run('SET a = ASK "A? "\nSHOW "[{a}]"', [""]);
  assertEqual(lines, ["[]"]);
});
