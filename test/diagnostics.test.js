import { test, assertTrue } from "./harness.js";
import { Diagnostic, formatDiagnostic } from "../src/diagnostics/diagnostic.js";
import { CODES } from "../src/diagnostics/codes.js";

test("diagnostics: formatDiagnostic includes code, location, message, and suggestion", () => {
  const source = 'SET x = 5\nSET x = "hello"\n';
  const span = {
    start: { line: 2, column: 1, offset: 10 },
    end: { line: 2, column: 16, offset: 25 },
  };
  const diagnostic = new Diagnostic({
    code: CODES.REASSIGN_TYPE_MISMATCH,
    message: '"x" was created as a number (integer), but this assigns a text value.',
    primarySpan: span,
    suggestion: "Use a different name for the text value.",
  });
  const text = formatDiagnostic(diagnostic, source, "hello.nova");
  assertTrue(text.includes("E-SEM-003"));
  assertTrue(text.includes("hello.nova"));
  assertTrue(text.includes("Line 2, Column 1"));
  assertTrue(text.includes('"x" was created as a number'));
  assertTrue(text.includes("Suggested fix:"));
  assertTrue(text.includes("^"));
});
