// Token model — see docs/SPECIFICATION.md §2.9.
export const TokenType = Object.freeze({
  IDENTIFIER: "IDENTIFIER",
  KEYWORD: "KEYWORD",
  INTEGER: "INTEGER",
  DECIMAL: "DECIMAL",
  STRING: "STRING",
  OPERATOR: "OPERATOR",
  PUNCTUATION: "PUNCTUATION",
  NEWLINE: "NEWLINE",
  EOF: "EOF",
});

// §2.6 — keywords with real grammar (CHANGE: ADR-002, DATA: ADR-005).
export const ACTIVE_KEYWORDS = new Set([
  "SET", "CHANGE", "SHOW", "IF", "ELSE", "END",
  "FOR", "EACH", "IN",
  "REPEAT", "TIMES",
  "DO", "RETURN", "RETURNS",
  "INPUT",
  "DATA",
  "SAVE", "GET", "DELETE",
  "TRUE", "FALSE",
  "AND", "OR", "NOT",
]);

// §2.6 — forward-reserved keywords: no grammar yet, but cannot be used as
// identifiers, protecting NOVA's future extension points.
export const RESERVED_KEYWORDS = new Set([
  "PAGE", "SCREEN", "API", "SERVICE", "SECURITY", "WHEN",
  "USE", "GO", "TO", "CREATE", "STYLE",
]);

export const ALL_KEYWORDS = new Set([...ACTIVE_KEYWORDS, ...RESERVED_KEYWORDS]);

export class Token {
  constructor(type, lexeme, value, span) {
    this.type = type;
    this.lexeme = lexeme;
    this.value = value;
    this.span = span;
  }
}

export function loc(line, column, offset) {
  return { line, column, offset };
}

export function span(start, end) {
  return { start, end };
}
