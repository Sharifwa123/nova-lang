// v0.9 (ADR-010) - TRY/CATCH: catching runtime-only NovaErrors. Semantic/
// parse errors can never reach a TRY block (the whole program is rejected
// before any statement runs, §13), so there's nothing to test for that -
// it's structurally impossible, not merely unlikely.
import { test, assertEqual, assertThrows } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { CODES } from "../src/diagnostics/codes.js";

function run(source, hostGlobals = {}) {
  const lines = [];
  runSource(source, "<test>", hostGlobals, { write: (s) => lines.push(s) });
  return lines;
}

// ---- happy paths ----

test("v0.9: CATCH runs when the TRY body raises a runtime error", () => {
  const program = `TRY
    SET x = 10 / 0
    SHOW "unreachable"
CATCH error
    SHOW "caught"
END`;
  assertEqual(run(program), ["caught"]);
});

test("v0.9: the caught error binds to the diagnostic's message, as text", () => {
  const program = `TRY
    SET x = 10 / 0
CATCH error
    SHOW error
END`;
  assertEqual(run(program), ["Cannot divide by zero."]);
});

test("v0.9: no error means CATCH never runs", () => {
  const program = `TRY
    SHOW "all good"
CATCH error
    SHOW "should not run"
END`;
  assertEqual(run(program), ["all good"]);
});

test("v0.9: an error raised inside a called procedure is still caught at the call site", () => {
  const program = `DO risky
    SET a = [1, 2, 3]
    RETURN a[10]
END
TRY
    SHOW risky()
CATCH error
    SHOW "caught: {error}"
END`;
  assertEqual(run(program), ["caught: Index 10 is out of bounds for a list of length 3."]);
});

test("v0.9: TRY/CATCH bodies are their own scopes", () => {
  assertThrows(() =>
    run(`TRY
    SET x = 1
CATCH error
    SHOW x
END`)
  );
});

test("v0.9: execution resumes normally after a caught TRY", () => {
  const program = `TRY
    SET x = 10 / 0
CATCH error
    SHOW "caught"
END
SHOW "resumed"`;
  assertEqual(run(program), ["caught", "resumed"]);
});

test("v0.9: RETURN inside TRY exits the procedure normally, bypassing CATCH", () => {
  const program = `DO f RETURNS integer
    TRY
        RETURN 42
    CATCH error
        RETURN -1
    END
END
SHOW f()`;
  assertEqual(run(program), ["42"]);
});

test("v0.9: TRY/CATCH where both bodies always return satisfies a RETURNS annotation", () => {
  compile(`DO f RETURNS integer
    TRY
        RETURN 1 / 0
    CATCH error
        RETURN -1
    END
END`);
});

test("v0.9: nested TRY/CATCH", () => {
  const program = `TRY
    TRY
        SET x = 10 / 0
    CATCH inner
        SHOW "inner: {inner}"
        SET y = 10 / 0
    END
CATCH outer
    SHOW "outer: {outer}"
END`;
  assertEqual(run(program), ["inner: Cannot divide by zero.", "outer: Cannot divide by zero."]);
});

// ---- diagnostics ----

test("v0.9: missing CATCH is a parse error", () => {
  assertThrows(() => compile('TRY\n    SHOW "x"\nEND'));
});

test("v0.9: missing END is E-PARSE-001", () => {
  assertThrows(
    () => compile('TRY\n    SHOW "x"\nCATCH e\n    SHOW e'),
    (e) => assertEqual(e.diagnostic.code, CODES.UNCLOSED_BLOCK)
  );
});

test("v0.9: a TRY body that doesn't return, with a CATCH that does, does not satisfy RETURNS (conservative)", () => {
  assertThrows(
    () =>
      compile(
        'DO f RETURNS integer\n    TRY\n        SHOW "no return here"\n    CATCH error\n        RETURN -1\n    END\nEND'
      ),
    (e) => assertEqual(e.diagnostic.code, CODES.NOT_ALL_PATHS_RETURN)
  );
});
