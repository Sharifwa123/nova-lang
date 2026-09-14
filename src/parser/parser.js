// Recursive-descent parser — see docs/SPECIFICATION.md §5-§9 and ADR-001.
// Blocks are delimited solely by explicit keywords (END / ELSE); NEWLINE
// tokens are only ever skipped, never load-bearing for block structure.
import { TokenType } from "../lexer/token.js";
import * as AST from "../ast/ast.js";
import { Diagnostic, NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";

function spanOf(startSpan, endSpan) {
  return { start: startSpan.start, end: endSpan.end };
}

export class Parser {
  constructor(tokens, source, filename = "<source>") {
    this.tokens = tokens;
    this.source = source;
    this.filename = filename;
    this.idx = 0;
  }

  // ---- token stream helpers ----

  current() {
    return this.tokens[this.idx];
  }
  atEOF() {
    return this.current().type === TokenType.EOF;
  }
  advance() {
    const tok = this.tokens[this.idx];
    if (tok.type !== TokenType.EOF) this.idx++;
    return tok;
  }
  checkType(type) {
    return this.current().type === type;
  }
  checkKeyword(word) {
    return this.current().type === TokenType.KEYWORD && this.current().value === word;
  }
  checkOperator(op) {
    return this.current().type === TokenType.OPERATOR && this.current().value === op;
  }
  checkPunct(p) {
    return this.current().type === TokenType.PUNCTUATION && this.current().value === p;
  }
  matchKeyword(word) {
    if (this.checkKeyword(word)) return this.advance();
    return null;
  }
  matchOperator(op) {
    if (this.checkOperator(op)) return this.advance();
    return null;
  }
  matchPunct(p) {
    if (this.checkPunct(p)) return this.advance();
    return null;
  }
  skipNewlines() {
    while (this.checkType(TokenType.NEWLINE)) this.advance();
  }

  describeToken(tok) {
    if (tok.type === TokenType.EOF) return "end of file";
    if (tok.type === TokenType.NEWLINE) return "end of line";
    if (tok.type === TokenType.STRING) return "a string literal";
    return `'${tok.lexeme}'`;
  }

  error(code, message, tok, explanation = null, suggestion = null, relatedSpans = []) {
    throw new NovaError(
      new Diagnostic({
        code,
        message,
        primarySpan: tok.span,
        relatedSpans,
        explanation,
        suggestion,
      })
    );
  }

  expectKeyword(word, suggestion = null) {
    if (!this.checkKeyword(word)) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected ${word}, but found ${this.describeToken(this.current())}.`,
        this.current(),
        null,
        suggestion
      );
    }
    return this.advance();
  }

  expectIdentifier(context) {
    const tok = this.current();
    if (tok.type === TokenType.KEYWORD) {
      this.error(
        CODES.RESERVED_WORD_AS_IDENTIFIER,
        `'${tok.value}' is a reserved word and cannot be used as ${context}.`,
        tok,
        "Reserved words are kept out of identifier position so future NOVA versions can give them meaning without breaking existing programs.",
        "Choose a different name."
      );
    }
    if (tok.type !== TokenType.IDENTIFIER) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected ${context}, but found ${this.describeToken(tok)}.`,
        tok
      );
    }
    return this.advance();
  }

  expectOperator(op) {
    if (!this.checkOperator(op)) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected '${op}', but found ${this.describeToken(this.current())}.`,
        this.current()
      );
    }
    return this.advance();
  }

  expectPunct(p) {
    if (!this.checkPunct(p)) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected '${p}', but found ${this.describeToken(this.current())}.`,
        this.current()
      );
    }
    return this.advance();
  }

  // ---- program / blocks ----

  parseProgram() {
    const statements = [];
    this.skipNewlines();
    while (!this.atEOF()) {
      statements.push(this.parseStatement());
      this.skipNewlines();
    }
    const eof = this.current();
    return AST.Program(statements, spanOf(
      statements[0]?.span ?? eof.span,
      eof.span
    ));
  }

  // Parses statements until a KEYWORD in `stopKeywords` is seen, or EOF.
  // Returns { statements, stoppedAt: 'EOF' | keyword }.
  parseBlockUntil(stopKeywords) {
    const statements = [];
    this.skipNewlines();
    while (true) {
      if (this.atEOF()) return { statements, stoppedAt: "EOF" };
      if (this.current().type === TokenType.KEYWORD && stopKeywords.includes(this.current().value)) {
        return { statements, stoppedAt: this.current().value };
      }
      statements.push(this.parseStatement());
      this.skipNewlines();
    }
  }

  unclosedBlockError(openerTok, openerDescription) {
    const eof = this.current();
    this.error(
      CODES.UNCLOSED_BLOCK,
      `This ${openerDescription} was never closed with END.`,
      eof,
      null,
      `Add END to close the ${openerDescription} started on line ${openerTok.span.start.line}.`,
      [[openerTok.span, `The ${openerDescription} started here`]]
    );
  }

  // ---- statements ----

  parseStatement() {
    const tok = this.current();
    if (tok.type === TokenType.KEYWORD) {
      switch (tok.value) {
        case "SHOW": return this.parseShow();
        case "SET": return this.parseSet();
        case "CHANGE": return this.parseChange();
        case "IF": return this.parseIf();
        case "FOR": return this.parseForEach();
        case "REPEAT": return this.parseRepeat();
        case "DO": return this.parseDo();
        case "RETURN": return this.parseReturn();
        case "END":
          this.error(
            CODES.UNEXPECTED_END,
            "Found END, but there is no open block to close here.",
            tok,
            "Every END must match an earlier block-opening keyword (IF, FOR EACH, REPEAT, DO). No such keyword is open at this point.",
            "Remove this END, or check whether an earlier block was closed too early."
          );
        default:
          this.error(
            CODES.UNEXPECTED_TOKEN,
            `'${tok.value}' cannot start a statement here.`,
            tok
          );
      }
    }
    return this.parseExpressionStatement();
  }

  parseShow() {
    const start = this.expectKeyword("SHOW");
    const value = this.parseExpression();
    return AST.ShowStatement(value, spanOf(start.span, value.span));
  }

  parseSet() {
    const start = this.expectKeyword("SET");
    const name = this.expectIdentifier("a variable name");
    this.expectOperator("=");
    const value = this.parseExpression();
    return AST.SetStatement(AST.Identifier(name.value, name.span), value, spanOf(start.span, value.span));
  }

  parseChange() {
    const start = this.expectKeyword("CHANGE");
    const name = this.expectIdentifier("a variable name");
    this.expectOperator("=");
    const value = this.parseExpression();
    return AST.ChangeStatement(AST.Identifier(name.value, name.span), value, spanOf(start.span, value.span));
  }

  parseIf() {
    const ifTok = this.expectKeyword("IF");
    const branches = [];
    let condition = this.parseExpression();
    let block = this.parseBlockUntil(["ELSE", "END"]);
    branches.push({ condition, body: block.statements });

    let elseBranch = null;
    let lastSpan = block;
    while (block.stoppedAt === "ELSE") {
      const elseTok = this.expectKeyword("ELSE");
      if (this.checkKeyword("IF")) {
        this.advance();
        const cond2 = this.parseExpression();
        block = this.parseBlockUntil(["ELSE", "END"]);
        branches.push({ condition: cond2, body: block.statements });
      } else {
        block = this.parseBlockUntil(["ELSE", "END"]);
        if (block.stoppedAt === "ELSE") {
          this.error(
            CODES.DUPLICATE_ELSE,
            "Unexpected ELSE. This IF already has an ELSE branch.",
            this.current(),
            "An IF may have at most one ELSE, and it must be the last branch.",
            "If you meant an additional condition, use ELSE IF instead of ELSE.",
            [[elseTok.span, "The first ELSE was here"]]
          );
        }
        elseBranch = block.statements;
        break;
      }
    }

    if (block.stoppedAt === "EOF") {
      this.unclosedBlockError(ifTok, "IF block");
    }
    const end = this.expectKeyword("END");
    return AST.IfStatement(branches, elseBranch, spanOf(ifTok.span, end.span));
  }

  parseForEach() {
    const forTok = this.expectKeyword("FOR");
    this.expectKeyword("EACH", "FOR EACH loops must have the form: FOR EACH <name> IN <list>");
    const loopVar = this.expectIdentifier("a loop variable name");
    if (!this.checkKeyword("IN")) {
      this.error(
        CODES.MALFORMED_FOR_EACH,
        "Expected IN after the loop variable name.",
        this.current(),
        null,
        "FOR EACH loops must have the form: FOR EACH <name> IN <list>"
      );
    }
    this.advance(); // IN
    const iterable = this.parseExpression();
    const block = this.parseBlockUntil(["END"]);
    if (block.stoppedAt === "EOF") this.unclosedBlockError(forTok, "FOR EACH block");
    const end = this.expectKeyword("END");
    return AST.ForEachStatement(
      AST.Identifier(loopVar.value, loopVar.span),
      iterable,
      block.statements,
      spanOf(forTok.span, end.span)
    );
  }

  parseRepeat() {
    const repeatTok = this.expectKeyword("REPEAT");
    const count = this.parseExpression();
    if (!this.checkKeyword("TIMES")) {
      this.error(
        CODES.MALFORMED_REPEAT,
        "Expected TIMES after the repeat count.",
        this.current(),
        null,
        "REPEAT loops must have the form: REPEAT <count> TIMES"
      );
    }
    this.advance(); // TIMES
    const block = this.parseBlockUntil(["END"]);
    if (block.stoppedAt === "EOF") this.unclosedBlockError(repeatTok, "REPEAT block");
    const end = this.expectKeyword("END");
    return AST.RepeatStatement(count, block.statements, spanOf(repeatTok.span, end.span));
  }

  parseDo() {
    const doTok = this.expectKeyword("DO");
    const name = this.expectIdentifier("a procedure name");
    this.skipNewlines();
    const parameters = [];
    while (this.checkKeyword("INPUT")) {
      this.advance();
      const paramName = this.expectIdentifier("a parameter name");
      parameters.push(AST.Identifier(paramName.value, paramName.span));
      this.skipNewlines();
    }
    const block = this.parseBlockUntil(["END"]);
    if (block.stoppedAt === "EOF") this.unclosedBlockError(doTok, "DO block");
    const end = this.expectKeyword("END");
    return AST.ProcedureDeclaration(
      AST.Identifier(name.value, name.span),
      parameters,
      block.statements,
      spanOf(doTok.span, end.span)
    );
  }

  parseReturn() {
    const start = this.expectKeyword("RETURN");
    // A bare RETURN is followed by NEWLINE/END/EOF; anything else starts an expression.
    if (
      this.checkType(TokenType.NEWLINE) ||
      this.checkKeyword("END") ||
      this.checkKeyword("ELSE") ||
      this.atEOF()
    ) {
      return AST.ReturnStatement(null, start.span);
    }
    const value = this.parseExpression();
    return AST.ReturnStatement(value, spanOf(start.span, value.span));
  }

  parseExpressionStatement() {
    const expr = this.parseExpression();
    return AST.ExpressionStatement(expr, expr.span);
  }

  // ---- expressions (§5) ----

  parseExpression() {
    return this.parseLogicalOr();
  }

  parseLogicalOr() {
    let left = this.parseLogicalAnd();
    while (this.checkKeyword("OR")) {
      this.advance();
      const right = this.parseLogicalAnd();
      left = AST.BinaryOp("OR", left, right, spanOf(left.span, right.span));
    }
    return left;
  }

  parseLogicalAnd() {
    let left = this.parseEquality();
    while (this.checkKeyword("AND")) {
      this.advance();
      const right = this.parseEquality();
      left = AST.BinaryOp("AND", left, right, spanOf(left.span, right.span));
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.checkOperator("==") || this.checkOperator("!=")) {
      const op = this.advance().value;
      const right = this.parseComparison();
      left = AST.BinaryOp(op, left, right, spanOf(left.span, right.span));
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    if (
      this.checkOperator("<") || this.checkOperator(">") ||
      this.checkOperator("<=") || this.checkOperator(">=")
    ) {
      const op = this.advance().value;
      const right = this.parseAdditive();
      left = AST.BinaryOp(op, left, right, spanOf(left.span, right.span));
      // §5.3 — comparisons do not chain.
      if (
        this.checkOperator("<") || this.checkOperator(">") ||
        this.checkOperator("<=") || this.checkOperator(">=")
      ) {
        this.error(
          CODES.UNEXPECTED_TOKEN,
          "Comparison operators cannot be chained.",
          this.current(),
          "NOVA does not support 'a < b < c'. Each comparison must produce a boolean, and booleans cannot themselves be compared with < > <= >=.",
          "Write it explicitly with AND, e.g. 'a < b AND b < c'."
        );
      }
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.checkOperator("+") || this.checkOperator("-")) {
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      left = AST.BinaryOp(op, left, right, spanOf(left.span, right.span));
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.checkOperator("*") || this.checkOperator("/")) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = AST.BinaryOp(op, left, right, spanOf(left.span, right.span));
    }
    return left;
  }

  parseUnary() {
    if (this.checkOperator("-")) {
      const tok = this.advance();
      const operand = this.parseUnary();
      return AST.UnaryOp("-", operand, spanOf(tok.span, operand.span));
    }
    if (this.checkKeyword("NOT")) {
      const tok = this.advance();
      const operand = this.parseUnary();
      return AST.UnaryOp("NOT", operand, spanOf(tok.span, operand.span));
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.current();

    if (tok.type === TokenType.INTEGER) {
      this.advance();
      return AST.IntegerLiteral(tok.value, tok.span);
    }
    if (tok.type === TokenType.DECIMAL) {
      this.advance();
      return AST.DecimalLiteral(tok.value, tok.span);
    }
    if (tok.type === TokenType.STRING) {
      this.advance();
      return AST.StringLiteral(tok.value, tok.span);
    }
    if (tok.type === TokenType.KEYWORD && tok.value === "TRUE") {
      this.advance();
      return AST.BooleanLiteral(true, tok.span);
    }
    if (tok.type === TokenType.KEYWORD && tok.value === "FALSE") {
      this.advance();
      return AST.BooleanLiteral(false, tok.span);
    }
    if (tok.type === TokenType.PUNCTUATION && tok.value === "(") {
      this.advance();
      const expr = this.parseExpression();
      this.expectPunct(")");
      return expr;
    }
    if (tok.type === TokenType.IDENTIFIER) {
      this.advance();
      let node = AST.Identifier(tok.value, tok.span);

      if (this.checkPunct("(")) {
        this.advance();
        const args = [];
        if (!this.checkPunct(")")) {
          args.push(this.parseExpression());
          while (this.matchPunct(",")) {
            args.push(this.parseExpression());
          }
        }
        const closeParen = this.expectPunct(")");
        node = AST.CallExpression(node, args, spanOf(tok.span, closeParen.span));
      }

      while (this.checkPunct(".")) {
        this.advance();
        const field = this.expectIdentifier("a field name");
        node = AST.FieldAccess(node, field.value, spanOf(node.span, field.span));
      }
      return node;
    }

    this.error(
      CODES.UNEXPECTED_TOKEN,
      `Expected an expression, but found ${this.describeToken(tok)}.`,
      tok
    );
  }
}

export function parse(tokens, source, filename) {
  return new Parser(tokens, source, filename).parseProgram();
}
