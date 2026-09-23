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
        case "DATA": return this.parseData();
        case "DELETE": return this.parseDelete();
        case "TRY": return this.parseTry();
        case "PAGE": return this.parsePage();
        case "SERVICE": return this.parseService();
        case "END":
          this.error(
            CODES.UNEXPECTED_END,
            "Found END, but there is no open block to close here.",
            tok,
            "Every END must match an earlier block-opening keyword (IF, FOR EACH, REPEAT, DO). No such keyword is open at this point.",
            "Remove this END, or check whether an earlier block was closed too early."
          );
      }
      // Any other keyword either starts a valid expression (TRUE, FALSE,
      // NOT, SAVE, GET) — handled by falling through to
      // parseExpressionStatement below — or it doesn't, in which case
      // parseAtom's own "Expected an expression, but found X" error covers
      // it with an equally clear diagnostic. No need to keep a second,
      // separate list of "keywords that can start a statement" in sync.
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

  // ADR-009 — CHANGE may target a plain name or an indexed (possibly
  // chained) list element: CHANGE x = ..., CHANGE list[i] = ...,
  // CHANGE matrix[i][j] = ...
  parseChange() {
    const start = this.expectKeyword("CHANGE");
    const name = this.expectIdentifier("a variable name");
    const indexPath = [];
    while (this.checkPunct("[")) {
      this.advance();
      indexPath.push(this.parseExpression());
      this.expectPunct("]");
    }
    this.expectOperator("=");
    const value = this.parseExpression();
    return AST.ChangeStatement(
      AST.Identifier(name.value, name.span),
      indexPath,
      value,
      spanOf(start.span, value.span)
    );
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

  // ADR-004 — optional "RETURNS type" after the name, optional ": type"
  // after each INPUT parameter name.
  parseTypeName() {
    const tok = this.expectIdentifier("a type name");
    return tok.value;
  }

  parseDo() {
    const doTok = this.expectKeyword("DO");
    const name = this.expectIdentifier("a procedure name");
    let returnType = null;
    if (this.checkKeyword("RETURNS")) {
      this.advance();
      returnType = this.parseTypeName();
    }
    this.skipNewlines();
    const parameters = [];
    while (this.checkKeyword("INPUT")) {
      this.advance();
      const paramName = this.expectIdentifier("a parameter name");
      let paramType = null;
      if (this.checkPunct(":")) {
        this.advance();
        paramType = this.parseTypeName();
      }
      parameters.push({ name: AST.Identifier(paramName.value, paramName.span), type: paramType });
      this.skipNewlines();
    }
    const block = this.parseBlockUntil(["END"]);
    if (block.stoppedAt === "EOF") this.unclosedBlockError(doTok, "DO block");
    const end = this.expectKeyword("END");
    return AST.ProcedureDeclaration(
      AST.Identifier(name.value, name.span),
      parameters,
      returnType,
      block.statements,
      spanOf(doTok.span, end.span)
    );
  }

  // ADR-005 — data-declaration ::= "DATA" identifier NEWLINE field-decl* "END"
  //           field-decl        ::= identifier ":" type-name
  parseData() {
    const dataTok = this.expectKeyword("DATA");
    const name = this.expectIdentifier("a DATA type name");
    this.skipNewlines();
    const fields = [];
    while (!this.checkKeyword("END")) {
      if (this.atEOF()) this.unclosedBlockError(dataTok, "DATA declaration");
      const fieldName = this.expectIdentifier("a field name");
      this.expectPunct(":");
      const fieldType = this.parseTypeName();
      fields.push({ name: fieldName.value, type: fieldType, nameSpan: fieldName.span });
      this.skipNewlines();
    }
    const end = this.expectKeyword("END");
    return AST.DataDeclaration(AST.Identifier(name.value, name.span), fields, spanOf(dataTok.span, end.span));
  }

  // ADR-010 — try-statement ::= "TRY" block "CATCH" identifier block "END"
  parseTry() {
    const tryTok = this.expectKeyword("TRY");
    const tryBlock = this.parseBlockUntil(["CATCH"]);
    if (tryBlock.stoppedAt === "EOF") this.unclosedBlockError(tryTok, "TRY block");
    this.expectKeyword("CATCH");
    const errorVar = this.expectIdentifier("an error variable name");
    const catchBlock = this.parseBlockUntil(["END"]);
    if (catchBlock.stoppedAt === "EOF") this.unclosedBlockError(tryTok, "TRY/CATCH block");
    const end = this.expectKeyword("END");
    return AST.TryStatement(
      tryBlock.statements,
      AST.Identifier(errorVar.value, errorVar.span),
      catchBlock.statements,
      spanOf(tryTok.span, end.span)
    );
  }

  // ADR-011/ADR-012 — page-declaration ::= "PAGE" string-literal NEWLINE page-element* "END"
  //           page-element ::= ("TITLE"|"STYLE"|"HEADING"|"TEXT") expression
  //                          | "FOR" "EACH" identifier "IN" "GET" identifier NEWLINE page-element* "END"
  parsePage() {
    const pageTok = this.expectKeyword("PAGE");
    const routeTok = this.current();
    if (routeTok.type !== TokenType.STRING) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected a route (a string literal), but found ${this.describeToken(routeTok)}.`,
        routeTok,
        null,
        'PAGE must be followed by a route string, e.g. PAGE "/" or PAGE "/about".'
      );
    }
    if (routeTok.value.some((p) => p.kind === "interp")) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        "A PAGE route cannot contain interpolation.",
        routeTok,
        null,
        'Use a plain string, e.g. PAGE "/about".'
      );
    }
    const route = routeTok.value.map((p) => p.value).join("");
    this.advance();
    const { elements, stoppedAt } = this.parsePageElementList();
    if (stoppedAt === "EOF") this.unclosedBlockError(pageTok, "PAGE block");
    const end = this.expectKeyword("END");
    return AST.PageDeclaration(route, routeTok.span, elements, spanOf(pageTok.span, end.span));
  }

  // Shared by the top of a PAGE and by a nested FOR EACH's body.
  parsePageElementList() {
    const elements = [];
    this.skipNewlines();
    const leafKeywords = ["TITLE", "STYLE", "HEADING", "TEXT"];
    while (!this.checkKeyword("END")) {
      if (this.atEOF()) return { elements, stoppedAt: "EOF" };
      if (this.checkKeyword("FOR")) {
        elements.push(this.parsePageForEach());
      } else if (this.checkKeyword("SET")) {
        elements.push(this.parsePageState());
      } else if (this.checkKeyword("BUTTON")) {
        elements.push(this.parsePageButton());
      } else {
        const tok = this.current();
        if (tok.type !== TokenType.KEYWORD || !leafKeywords.includes(tok.value)) {
          this.error(
            CODES.UNEXPECTED_TOKEN,
            `Expected TITLE, STYLE, HEADING, TEXT, FOR EACH, SET, or BUTTON, but found ${this.describeToken(tok)}.`,
            tok
          );
        }
        this.advance();
        const value = this.parseExpression();
        elements.push({ kind: tok.value, value, span: spanOf(tok.span, value.span) });
      }
      this.skipNewlines();
    }
    return { elements, stoppedAt: "END" };
  }

  // ADR-013 — page-local state: SET <name> = <literal>, reusing the exact
  // "SET declares" meaning ordinary variables already have (ADR-002).
  parsePageState() {
    const setTok = this.expectKeyword("SET");
    const name = this.expectIdentifier("a state variable name");
    this.expectOperator("=");
    const value = this.parseExpression();
    return {
      kind: "SET",
      name: AST.Identifier(name.value, name.span),
      value,
      span: spanOf(setTok.span, value.span),
    };
  }

  // ADR-013 — button-element ::= "BUTTON" expression NEWLINE
  //                               "WHEN" "CLICKED" block "END" NEWLINE "END"
  // WHEN CLICKED's body is parsed as an ORDINARY statement block (any
  // statement is syntactically valid here) - restricting it to safe
  // CHANGE-only actions is a semantic check, not a parser one (ADR-013).
  parsePageButton() {
    const buttonTok = this.expectKeyword("BUTTON");
    const label = this.parseExpression();
    this.skipNewlines();
    this.expectKeyword("WHEN");
    this.expectKeyword("CLICKED");
    const whenBlock = this.parseBlockUntil(["END"]);
    if (whenBlock.stoppedAt === "EOF") this.unclosedBlockError(buttonTok, "BUTTON's WHEN CLICKED block");
    this.expectKeyword("END"); // closes WHEN CLICKED
    this.skipNewlines(); // a missing newline-skip here would break consecutive BUTTON blocks (ADR-013)
    const end = this.expectKeyword("END"); // closes BUTTON
    return { kind: "BUTTON", label, actions: whenBlock.statements, span: spanOf(buttonTok.span, end.span) };
  }

  // ADR-012 — reuses FOR EACH / GET rather than inventing a parallel
  // "page loop" construct; the iterable is restricted to "GET <DataType>"
  // since that's the only build-time-known data source PAGE has.
  parsePageForEach() {
    const forTok = this.expectKeyword("FOR");
    this.expectKeyword("EACH");
    const loopVar = this.expectIdentifier("a loop variable name");
    this.expectKeyword("IN");
    this.expectKeyword(
      "GET",
      "Inside PAGE, FOR EACH must iterate GET <DataType> - that's the only data PAGE can see at build time."
    );
    const typeTok = this.expectIdentifier("a DATA type name");
    const { elements: body, stoppedAt } = this.parsePageElementList();
    if (stoppedAt === "EOF") this.unclosedBlockError(forTok, "FOR EACH block inside PAGE");
    const end = this.expectKeyword("END");
    return {
      kind: "FOR_EACH",
      loopVar: AST.Identifier(loopVar.value, loopVar.span),
      dataTypeName: typeTok.value,
      dataTypeNameSpan: typeTok.span,
      body,
      span: spanOf(forTok.span, end.span),
    };
  }

  // ADR-014 — service-declaration ::= "SERVICE" NEWLINE api-declaration* "END"
  parseService() {
    const serviceTok = this.expectKeyword("SERVICE");
    const apis = [];
    this.skipNewlines();
    while (!this.checkKeyword("END")) {
      if (this.atEOF()) this.unclosedBlockError(serviceTok, "SERVICE block");
      if (!this.checkKeyword("API")) {
        this.error(
          CODES.UNEXPECTED_TOKEN,
          `Expected API, but found ${this.describeToken(this.current())}.`,
          this.current(),
          null,
          "A SERVICE block may only contain API declarations."
        );
      }
      apis.push(this.parseApiDeclaration());
      this.skipNewlines();
    }
    const end = this.expectKeyword("END");
    return AST.ServiceDeclaration(apis, spanOf(serviceTok.span, end.span));
  }

  // ADR-014/ADR-015 — api-declaration ::= "API" ("GET"|"POST") string-literal
  //                                        NEWLINE statement* "END"
  // Only GET and POST are supported so far - the grammar itself only
  // accepts those literal keywords (see the ADRs for why this is a parser
  // restriction, not a semantic one). The body is an ORDINARY statement
  // block - unlike WHEN CLICKED (ADR-013), an API handler is deliberately
  // NOT sandboxed.
  parseApiDeclaration() {
    const apiTok = this.expectKeyword("API");
    let methodTok;
    if (this.checkKeyword("GET") || this.checkKeyword("POST")) {
      methodTok = this.advance();
    } else {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected GET or POST, but found ${this.describeToken(this.current())}.`,
        this.current(),
        null,
        'API must be followed by GET or POST, e.g. API GET "/products" or API POST "/products".'
      );
    }
    const routeTok = this.current();
    if (routeTok.type !== TokenType.STRING) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        `Expected a route (a string literal), but found ${this.describeToken(routeTok)}.`,
        routeTok,
        null,
        'API GET must be followed by a route string, e.g. API GET "/products".'
      );
    }
    if (routeTok.value.some((p) => p.kind === "interp")) {
      this.error(
        CODES.UNEXPECTED_TOKEN,
        "An API route cannot contain interpolation.",
        routeTok,
        null,
        'Use a plain string, e.g. API GET "/products".'
      );
    }
    const route = routeTok.value.map((p) => p.value).join("");
    this.advance();
    const block = this.parseBlockUntil(["END"]);
    if (block.stoppedAt === "EOF") this.unclosedBlockError(apiTok, "API block");
    const end = this.expectKeyword("END");
    return {
      method: methodTok.value,
      route,
      routeSpan: routeTok.span,
      body: block.statements,
      span: spanOf(apiTok.span, end.span),
    };
  }

  // ADR-006 — delete-statement ::= "DELETE" identifier expression
  parseDelete() {
    const deleteTok = this.expectKeyword("DELETE");
    const typeTok = this.expectIdentifier("a DATA type name");
    const idExpression = this.parseExpression();
    return AST.DeleteStatement(typeTok.value, typeTok.span, idExpression, spanOf(deleteTok.span, idExpression.span));
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
    const node = this.parseAtom();
    return this.parsePostfix(node);
  }

  // ADR-003 — `.field` access follows ANY primary (literal, call, list,
  // record, or a parenthesized expression), not only identifiers.
  // ADR-009 — `[index]` likewise, and the two chain freely: a[0].b[1].
  parsePostfix(node) {
    while (this.checkPunct(".") || this.checkPunct("[")) {
      if (this.checkPunct(".")) {
        this.advance();
        const field = this.expectIdentifier("a field name");
        node = AST.FieldAccess(node, field.value, spanOf(node.span, field.span));
      } else {
        this.advance(); // '['
        const index = this.parseExpression();
        const close = this.expectPunct("]");
        node = AST.IndexAccess(node, index, spanOf(node.span, close.span));
      }
    }
    return node;
  }

  parseAtom() {
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
    if (tok.type === TokenType.PUNCTUATION && tok.value === "[") {
      return this.parseListLiteral(tok);
    }
    if (tok.type === TokenType.PUNCTUATION && tok.value === "{") {
      return this.parseRecordLiteral(tok);
    }
    // ADR-006 — save-expression ::= "SAVE" expression
    if (tok.type === TokenType.KEYWORD && tok.value === "SAVE") {
      this.advance();
      const value = this.parseExpression();
      return AST.SaveExpression(value, spanOf(tok.span, value.span));
    }
    // ADR-006 — get-expression ::= "GET" identifier
    if (tok.type === TokenType.KEYWORD && tok.value === "GET") {
      this.advance();
      const typeTok = this.expectIdentifier("a DATA type name");
      return AST.GetExpression(typeTok.value, typeTok.span, spanOf(tok.span, typeTok.span));
    }
    // ADR-008 — ask-expression ::= "ASK" expression
    if (tok.type === TokenType.KEYWORD && tok.value === "ASK") {
      this.advance();
      const prompt = this.parseExpression();
      return AST.AskExpression(prompt, spanOf(tok.span, prompt.span));
    }
    // ADR-015 — request-expression ::= "REQUEST" "AS" identifier
    if (tok.type === TokenType.KEYWORD && tok.value === "REQUEST") {
      this.advance();
      this.expectKeyword("AS", 'REQUEST must be followed by AS <DataType>, e.g. REQUEST AS Product.');
      const typeTok = this.expectIdentifier("a DATA type name");
      return AST.RequestExpression(typeTok.value, typeTok.span, spanOf(tok.span, typeTok.span));
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
      return node;
    }

    this.error(
      CODES.UNEXPECTED_TOKEN,
      `Expected an expression, but found ${this.describeToken(tok)}.`,
      tok
    );
  }

  // ADR-003 — list-literal ::= "[" ( expression ( "," expression )* ","? )? "]"
  parseListLiteral(openTok) {
    this.advance(); // '['
    this.skipNewlines();
    const elements = [];
    if (!this.checkPunct("]")) {
      elements.push(this.parseExpression());
      this.skipNewlines();
      while (this.matchPunct(",")) {
        this.skipNewlines();
        if (this.checkPunct("]")) break; // trailing comma
        elements.push(this.parseExpression());
        this.skipNewlines();
      }
    }
    const close = this.expectPunct("]");
    return AST.ListLiteral(elements, spanOf(openTok.span, close.span));
  }

  // ADR-003 — record-literal ::= "{" ( field-init ( "," field-init )* ","? )? "}"
  parseRecordLiteral(openTok) {
    this.advance(); // '{'
    this.skipNewlines();
    const fields = [];
    if (!this.checkPunct("}")) {
      fields.push(this.parseFieldInit());
      this.skipNewlines();
      while (this.matchPunct(",")) {
        this.skipNewlines();
        if (this.checkPunct("}")) break; // trailing comma
        fields.push(this.parseFieldInit());
        this.skipNewlines();
      }
    }
    const close = this.expectPunct("}");
    return AST.RecordLiteral(fields, spanOf(openTok.span, close.span));
  }

  parseFieldInit() {
    const name = this.expectIdentifier("a field name");
    this.expectPunct(":");
    const value = this.parseExpression();
    return { name: name.value, value, nameSpan: name.span };
  }
}

export function parse(tokens, source, filename) {
  return new Parser(tokens, source, filename).parseProgram();
}
