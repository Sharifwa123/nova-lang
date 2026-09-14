import { test, assertEqual, assertThrows } from "./harness.js";
import { Lexer } from "../src/lexer/lexer.js";
import { TokenType } from "../src/lexer/token.js";
import { NovaError } from "../src/diagnostics/diagnostic.js";
import { CODES } from "../src/diagnostics/codes.js";

function types(source) {
  return new Lexer(source).tokenize().map((t) => t.type);
}

test("lexer: keywords are uppercase-only", () => {
  const tokens = new Lexer("SHOW show Show").tokenize();
  assertEqual(tokens[0].type, TokenType.KEYWORD);
  assertEqual(tokens[1].type, TokenType.IDENTIFIER);
  assertEqual(tokens[2].type, TokenType.IDENTIFIER);
});

test("lexer: integer and decimal literals", () => {
  const tokens = new Lexer("42 3.14").tokenize();
  assertEqual(tokens[0].type, TokenType.INTEGER);
  assertEqual(tokens[0].value, 42);
  assertEqual(tokens[1].type, TokenType.DECIMAL);
  assertEqual(tokens[1].value, 3.14);
});

test("lexer: string with interpolation and dotted path", () => {
  const tokens = new Lexer('"Hello {name}, total is {product.price}"').tokenize();
  assertEqual(tokens[0].type, TokenType.STRING);
  assertEqual(tokens[0].value, [
    { kind: "text", value: "Hello " },
    { kind: "interp", path: ["name"], span: tokens[0].value[1].span },
    { kind: "text", value: ", total is " },
    { kind: "interp", path: ["product", "price"], span: tokens[0].value[3].span },
  ]);
});

test("lexer: escapes", () => {
  const tokens = new Lexer('"a\\nb\\tc\\"d\\\\e"').tokenize();
  assertEqual(tokens[0].value, [{ kind: "text", value: 'a\nb\tc"d\\e' }]);
});

test("lexer: comments produce no token", () => {
  assertEqual(types("SET x = 1 # comment\nSHOW x"), [
    TokenType.KEYWORD, TokenType.IDENTIFIER, TokenType.OPERATOR, TokenType.INTEGER,
    TokenType.NEWLINE, TokenType.KEYWORD, TokenType.IDENTIFIER, TokenType.EOF,
  ]);
});

test("lexer: two-char operators tokenize before one-char", () => {
  const tokens = new Lexer("== != <= >=").tokenize();
  assertEqual(tokens.slice(0, 4).map((t) => t.value), ["==", "!=", "<=", ">="]);
});

test("lexer: forward-reserved keywords tokenize as KEYWORD", () => {
  assertEqual(types("DATA")[0], TokenType.KEYWORD);
});

test("lexer: unterminated string is a lexical error", () => {
  assertThrows(
    () => new Lexer('"unterminated').tokenize(),
    (e) => {
      assertEqual(e instanceof NovaError, true);
      assertEqual(e.diagnostic.code, CODES.UNTERMINATED_STRING);
    }
  );
});

test("lexer: unrecognized escape is a lexical error", () => {
  assertThrows(
    () => new Lexer('"bad \\q escape"').tokenize(),
    (e) => assertEqual(e.diagnostic.code, CODES.BAD_ESCAPE)
  );
});

test("lexer: unexpected character is a lexical error", () => {
  assertThrows(
    () => new Lexer("SET x = 1 @ 2").tokenize(),
    (e) => assertEqual(e.diagnostic.code, CODES.UNEXPECTED_CHARACTER)
  );
});

test("lexer: source locations are 1-based line/column", () => {
  const tokens = new Lexer("SHOW 1\nSHOW 2").tokenize();
  const secondShow = tokens[3]; // KEYWORD 'SHOW' on line 2
  assertEqual(secondShow.span.start.line, 2);
  assertEqual(secondShow.span.start.column, 1);
});
