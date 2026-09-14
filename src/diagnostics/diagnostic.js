// Diagnostic model — see docs/SPECIFICATION.md §11.
// Every diagnostic carries: severity, code, message, primarySpan, relatedSpans,
// explanation?, suggestion? — the WHAT / WHERE / WHY / HOW structure NOVA
// commits to for every error.

export class Diagnostic {
  constructor({
    severity = "Error",
    code,
    message,
    primarySpan,
    relatedSpans = [],
    explanation = null,
    suggestion = null,
  }) {
    this.severity = severity;
    this.code = code;
    this.message = message;
    this.primarySpan = primarySpan;
    this.relatedSpans = relatedSpans;
    this.explanation = explanation;
    this.suggestion = suggestion;
  }
}

// Thrown by the lexer/parser/analyzer/interpreter to unwind to the CLI (or a
// test harness) with a single, well-formed Diagnostic.
export class NovaError extends Error {
  constructor(diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

function sourceLine(source, lineNumber) {
  const lines = source.split("\n");
  return lines[lineNumber - 1] ?? "";
}

function caretLine(startColumn, endColumn, sameLine) {
  const width = sameLine ? Math.max(1, endColumn - startColumn) : 1;
  return " ".repeat(startColumn - 1) + "^".repeat(width);
}

// Renders a Diagnostic into the WHAT/WHERE/WHY/HOW text format used
// throughout docs/SPECIFICATION.md §11's worked examples.
export function formatDiagnostic(diagnostic, source, filename) {
  const { primarySpan, code, message, relatedSpans, explanation, suggestion } =
    diagnostic;
  const lines = [];
  lines.push(
    `NOVA ${diagnostic.severity.toUpperCase()} [${code}]`
  );
  lines.push(
    `File: ${filename}, Line ${primarySpan.start.line}, Column ${primarySpan.start.column}`
  );
  lines.push("");
  lines.push(message);
  lines.push("");

  for (const [span, label] of relatedSpans) {
    lines.push(`${label}:`);
    lines.push(`  Line ${span.start.line}:  ${sourceLine(source, span.start.line)}`);
    lines.push("");
  }

  const sameLine = primarySpan.start.line === primarySpan.end.line;
  lines.push(`Line ${primarySpan.start.line}:  ${sourceLine(source, primarySpan.start.line)}`);
  lines.push(
    "         " +
      caretLine(primarySpan.start.column, primarySpan.end.column, sameLine)
  );

  if (explanation) {
    lines.push("");
    lines.push(explanation);
  }
  if (suggestion) {
    lines.push("");
    lines.push("Suggested fix:");
    lines.push("    " + suggestion);
  }
  return lines.join("\n");
}
