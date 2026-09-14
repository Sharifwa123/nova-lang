// Lexer — see docs/SPECIFICATION.md §2 and ADR-001 (no indentation tracking:
// this is deliberately a boring, linear character scanner).
import { Token, TokenType, ALL_KEYWORDS, loc, span } from "./token.js";
import { Diagnostic, NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";

const TWO_CHAR_OPERATORS = ["==", "!=", "<=", ">="];
const ONE_CHAR_OPERATORS = new Set(["=", "<", ">", "+", "-", "*", "/"]);
const PUNCTUATION = new Set(["(", ")", ".", ",", ":"]);

function isLetter(ch) {
  return /[A-Za-z]/.test(ch);
}
function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function isIdentStart(ch) {
  return isLetter(ch) || ch === "_";
}
function isIdentContinue(ch) {
  return isLetter(ch) || isDigit(ch) || ch === "_";
}

export class Lexer {
  constructor(source, filename = "<source>") {
    // Strip an optional leading BOM (§1).
    this.source = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    this.filename = filename;
    this.pos = 0;
    this.line = 1;
    this.column = 1;
    this.tokens = [];
  }

  error(code, message, startLoc, endLoc, explanation = null, suggestion = null) {
    throw new NovaError(
      new Diagnostic({
        code,
        message,
        primarySpan: span(startLoc, endLoc ?? startLoc),
        explanation,
        suggestion,
      })
    );
  }

  here() {
    return loc(this.line, this.column, this.pos);
  }

  peek(offset = 0) {
    return this.source[this.pos + offset];
  }

  advance() {
    const ch = this.source[this.pos++];
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  atEnd() {
    return this.pos >= this.source.length;
  }

  tokenize() {
    while (!this.atEnd()) {
      this.scanToken();
    }
    const end = this.here();
    this.tokens.push(new Token(TokenType.EOF, "", null, span(end, end)));
    return this.tokens;
  }

  scanToken() {
    const ch = this.peek();

    if (ch === "\n") {
      const start = this.here();
      this.advance();
      this.tokens.push(new Token(TokenType.NEWLINE, "\n", null, span(start, this.here())));
      return;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      this.advance();
      return;
    }
    if (ch === "#") {
      while (!this.atEnd() && this.peek() !== "\n") this.advance();
      return;
    }
    if (ch === '"') {
      this.scanString();
      return;
    }
    if (isDigit(ch)) {
      this.scanNumber();
      return;
    }
    if (isIdentStart(ch)) {
      this.scanIdentifierOrKeyword();
      return;
    }

    const two = this.source.substr(this.pos, 2);
    if (TWO_CHAR_OPERATORS.includes(two)) {
      const start = this.here();
      this.advance();
      this.advance();
      this.tokens.push(new Token(TokenType.OPERATOR, two, two, span(start, this.here())));
      return;
    }
    if (ONE_CHAR_OPERATORS.has(ch)) {
      const start = this.here();
      this.advance();
      this.tokens.push(new Token(TokenType.OPERATOR, ch, ch, span(start, this.here())));
      return;
    }
    if (PUNCTUATION.has(ch)) {
      const start = this.here();
      this.advance();
      this.tokens.push(new Token(TokenType.PUNCTUATION, ch, ch, span(start, this.here())));
      return;
    }

    const start = this.here();
    this.advance();
    this.error(
      CODES.UNEXPECTED_CHARACTER,
      `Unexpected character '${ch}' at line ${start.line}, column ${start.column}.`,
      start,
      this.here(),
      null,
      "Remove or replace this character — it isn't part of any NOVA token."
    );
  }

  scanIdentifierOrKeyword() {
    const start = this.here();
    let text = "";
    while (!this.atEnd() && isIdentContinue(this.peek())) {
      text += this.advance();
    }
    const end = this.here();
    if (ALL_KEYWORDS.has(text)) {
      this.tokens.push(new Token(TokenType.KEYWORD, text, text, span(start, end)));
    } else {
      this.tokens.push(new Token(TokenType.IDENTIFIER, text, text, span(start, end)));
    }
  }

  scanNumber() {
    const start = this.here();
    let text = "";
    while (!this.atEnd() && isDigit(this.peek())) text += this.advance();
    let isDecimal = false;
    if (this.peek() === "." && isDigit(this.peek(1))) {
      isDecimal = true;
      text += this.advance(); // '.'
      while (!this.atEnd() && isDigit(this.peek())) text += this.advance();
    }
    const end = this.here();
    if (isDecimal) {
      this.tokens.push(new Token(TokenType.DECIMAL, text, parseFloat(text), span(start, end)));
    } else {
      this.tokens.push(new Token(TokenType.INTEGER, text, parseInt(text, 10), span(start, end)));
    }
  }

  scanString() {
    const start = this.here();
    this.advance(); // opening quote
    const parts = [];
    let textBuf = "";

    const flushText = () => {
      if (textBuf.length > 0) {
        parts.push({ kind: "text", value: textBuf });
        textBuf = "";
      }
    };

    while (true) {
      if (this.atEnd() || this.peek() === "\n") {
        this.error(
          CODES.UNTERMINATED_STRING,
          "This string was never closed with a matching \".",
          start,
          this.here(),
          null,
          'Add a closing " before the end of the line.'
        );
      }
      const ch = this.peek();
      if (ch === '"') {
        this.advance();
        break;
      }
      if (ch === "\\") {
        const escStart = this.here();
        this.advance();
        const next = this.peek();
        const map = { '"': '"', "\\": "\\", n: "\n", t: "\t" };
        if (next === undefined || !(next in map)) {
          this.error(
            CODES.BAD_ESCAPE,
            `Unrecognized escape sequence '\\${next ?? ""}'.`,
            escStart,
            this.here(),
            null,
            'Supported escapes are \\" \\\\ \\n \\t.'
          );
        }
        textBuf += map[next];
        this.advance();
        continue;
      }
      if (ch === "{") {
        const interpStart = this.here();
        this.advance();
        let ident = "";
        while (!this.atEnd() && isIdentContinue(this.peek())) ident += this.advance();
        const path = [ident];
        while (this.peek() === ".") {
          this.advance();
          let field = "";
          while (!this.atEnd() && isIdentContinue(this.peek())) field += this.advance();
          path.push(field);
        }
        if (this.peek() !== "}") {
          this.error(
            CODES.UNEXPECTED_CHARACTER,
            "Expected '}' to close this interpolation.",
            interpStart,
            this.here(),
            "NOVA string interpolation supports only {identifier} or {identifier.field}, not full expressions (§2.7.2).",
            'Close the interpolation with "}", e.g. "{name}".'
          );
        }
        this.advance(); // '}'
        flushText();
        parts.push({ kind: "interp", path, span: span(interpStart, this.here()) });
        continue;
      }
      textBuf += this.advance();
    }
    flushText();
    const end = this.here();
    this.tokens.push(new Token(TokenType.STRING, null, parts, span(start, end)));
  }
}
