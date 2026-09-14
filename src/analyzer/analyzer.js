// Semantic analyzer — see docs/SPECIFICATION.md §13.
// One pass over the whole AST, before any statement executes (fail fast,
// fail predictably, §13): scope resolution, duplicate-declaration checks,
// the §3/§4 type rules, RETURN placement, and call arity.
import { Scope } from "./scope.js";
import { Diagnostic, NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";

function err(code, message, span, explanation = null, suggestion = null, relatedSpans = []) {
  throw new NovaError(
    new Diagnostic({ code, message, primarySpan: span, relatedSpans, explanation, suggestion })
  );
}

// Type-compatibility rule shared by SET reassignment and CHANGE (§4.1, §4.3).
// Returns the resulting tracked type, or throws.
function reassignCompatibleType(existingType, newType, name, span) {
  if (existingType === "unknown" || newType === "unknown") return newType;
  if (existingType === newType) return existingType;
  if (existingType === "integer" && newType === "decimal") return "decimal";
  err(
    CODES.REASSIGN_TYPE_MISMATCH,
    `"${name}" was created as ${describeType(existingType)}, but this assigns ${describeType(newType)}.`,
    span,
    "NOVA variables keep the same type once created (integer values may later be assigned a decimal, but no other type change is allowed).",
    `Use a different name for the new value, or make sure the value being assigned to "${name}" is ${describeType(existingType)}.`
  );
}

function describeType(t) {
  const article = /^[aeiou]/.test(t) ? "an" : "a";
  const names = { integer: "a number (integer)", decimal: "a number (decimal)", text: "a text value", boolean: "a boolean value" };
  return names[t] ?? `${article} ${t} value`;
}

export class Analyzer {
  constructor(program, hostGlobals = {}) {
    this.program = program;
    this.procedures = new Map(); // name -> { arity, node }
    this.globalScope = new Scope();
    for (const [name, type] of Object.entries(hostGlobals)) {
      this.globalScope.defineLocal(name, type);
    }
  }

  analyze() {
    this.registerProcedures(this.program.statements);
    this.checkStatements(this.program.statements, this.globalScope, { insideProcedure: false });
    return this.program;
  }

  registerProcedures(statements) {
    for (const stmt of statements) {
      if (stmt.kind === "ProcedureDeclaration") {
        const name = stmt.name.name;
        if (this.procedures.has(name)) {
          const prev = this.procedures.get(name);
          err(
            CODES.DUPLICATE_PROCEDURE,
            `"${name}" is already defined.`,
            stmt.name.span,
            "A name can only be declared once in the same scope.",
            `Rename one of the procedures, e.g. ${name}2.`,
            [[prev.node.name.span, "Previous definition"]]
          );
        }
        this.procedures.set(name, { arity: stmt.parameters.length, node: stmt });
      }
    }
  }

  checkStatements(statements, scope, ctx) {
    for (const stmt of statements) this.checkStatement(stmt, scope, ctx);
  }

  checkStatement(stmt, scope, ctx) {
    switch (stmt.kind) {
      case "ShowStatement":
        this.infer(stmt.value, scope);
        return;

      case "SetStatement": {
        const exprType = this.infer(stmt.value, scope);
        if (scope.hasLocal(stmt.name.name)) {
          const existing = scope.getLocal(stmt.name.name);
          const resultType = reassignCompatibleType(existing.type, exprType, stmt.name.name, stmt.span);
          existing.type = resultType;
        } else {
          scope.defineLocal(stmt.name.name, exprType);
        }
        return;
      }

      case "ChangeStatement": {
        // Check the target exists *before* inferring the right-hand side:
        // `CHANGE total = total + 5` with no prior SET must report "total
        // doesn't exist" (E-SEM-006), not an undefined-name error on the
        // `total` reference inside its own expression (see the worked
        // example in ADR-002 / docs/SPECIFICATION.md §11, E10).
        const resolved = scope.resolve(stmt.name.name);
        if (!resolved) {
          err(
            CODES.CHANGE_UNDEFINED,
            `CHANGE requires "${stmt.name.name}" to already exist, but it hasn't been created yet.`,
            stmt.name.span,
            "CHANGE updates a variable that already exists elsewhere. It cannot create a new one — use SET for that.",
            `If this is a new variable, use SET instead of CHANGE. If you meant to update a variable created earlier, make sure it was created with SET before this point.`
          );
        }
        const exprType = this.infer(stmt.value, scope);
        resolved.binding.type = reassignCompatibleType(
          resolved.binding.type,
          exprType,
          stmt.name.name,
          stmt.span
        );
        return;
      }

      case "IfStatement": {
        for (const branch of stmt.branches) {
          this.infer(branch.condition, scope);
          this.checkStatements(branch.body, scope.child(), ctx);
        }
        if (stmt.elseBranch) this.checkStatements(stmt.elseBranch, scope.child(), ctx);
        return;
      }

      case "ForEachStatement": {
        const iterableType = this.infer(stmt.iterable, scope);
        if (iterableType !== "list" && iterableType !== "unknown") {
          err(
            CODES.FOR_EACH_NOT_LIST,
            `Cannot iterate over a value of type '${iterableType}' with FOR EACH.`,
            stmt.iterable.span,
            "FOR EACH requires a list value.",
            "Make sure the value after IN is a list."
          );
        }
        const child = scope.child();
        child.defineLocal(stmt.loopVariable.name, "unknown");
        this.checkStatements(stmt.body, child, ctx);
        return;
      }

      case "RepeatStatement": {
        const countType = this.infer(stmt.count, scope);
        if (countType !== "integer" && countType !== "unknown") {
          err(
            CODES.REPEAT_COUNT_NOT_INTEGER,
            `REPEAT requires an integer count, but this is ${describeType(countType)}.`,
            stmt.count.span,
            null,
            "Use a whole number, e.g. REPEAT 5 TIMES."
          );
        }
        this.checkStatements(stmt.body, scope.child(), ctx);
        return;
      }

      case "ProcedureDeclaration": {
        // §8.3 — a procedure body's parent is global scope, not the
        // lexical scope where DO happens to appear.
        const procScope = this.globalScope.child();
        for (const param of stmt.parameters) {
          procScope.defineLocal(param.name, "unknown");
        }
        this.checkStatements(stmt.body, procScope, { insideProcedure: true });
        return;
      }

      case "ReturnStatement": {
        if (!ctx.insideProcedure) {
          err(
            CODES.RETURN_OUTSIDE_PROCEDURE,
            "RETURN can only be used inside a procedure (DO ... END).",
            stmt.span,
            "This RETURN is not inside any DO block.",
            "Move this into a procedure."
          );
        }
        if (stmt.value) this.infer(stmt.value, scope);
        return;
      }

      case "ExpressionStatement":
        this.infer(stmt.expression, scope);
        return;

      default:
        throw new Error(`Analyzer: unhandled statement kind '${stmt.kind}'`);
    }
  }

  // Infers a static type for `expr`, or 'unknown' where v0.1 genuinely
  // cannot know (procedure results, field access, loop elements — none of
  // these have static type information in v0.1; see §15/§16).
  infer(expr, scope) {
    switch (expr.kind) {
      case "IntegerLiteral": return "integer";
      case "DecimalLiteral": return "decimal";
      case "BooleanLiteral": return "boolean";

      case "StringLiteral": {
        for (const part of expr.parts) {
          if (part.kind === "interp") {
            const resolved = scope.resolve(part.path[0]);
            if (!resolved) {
              err(
                CODES.UNDEFINED_NAME,
                `The name "${part.path[0]}" is not defined in this scope.`,
                part.span,
                "Possible causes: the variable was never created with SET, the name is misspelled, or it was declared inside a block that has already ended.",
                `Make sure "${part.path[0]}" is created before this line.`
              );
            }
          }
        }
        return "text";
      }

      case "Identifier": {
        const resolved = scope.resolve(expr.name);
        if (!resolved) {
          err(
            CODES.UNDEFINED_NAME,
            `The name "${expr.name}" is not defined in this scope.`,
            expr.span,
            "Possible causes: the variable was never created with SET, the name is misspelled, or it was declared inside a block that has already ended.",
            `Make sure "${expr.name}" is created before this line, e.g. SET ${expr.name} = ...`
          );
        }
        return resolved.binding.type;
      }

      case "FieldAccess": {
        this.infer(expr.target, scope);
        // No static field-type tracking in v0.1 (no DATA yet, §15).
        return "unknown";
      }

      case "ListLiteral": {
        // Elements may be mixed types (ADR-003) - infer each only to catch
        // nested errors (undefined names, bad operators, etc).
        for (const el of expr.elements) this.infer(el, scope);
        return "list";
      }

      case "RecordLiteral": {
        const seen = new Map();
        for (const field of expr.fields) {
          if (seen.has(field.name)) {
            err(
              CODES.DUPLICATE_FIELD,
              `"${field.name}" is already set in this record.`,
              field.nameSpan,
              "A record literal cannot set the same field twice - the later value would silently win, discarding the first.",
              `Remove one of the two "${field.name}:" entries.`,
              [[seen.get(field.name), `"${field.name}" was first set here`]]
            );
          }
          seen.set(field.name, field.nameSpan);
          this.infer(field.value, scope);
        }
        return "record";
      }

      case "UnaryOp": {
        const t = this.infer(expr.operand, scope);
        if (expr.operator === "NOT") {
          if (t !== "boolean" && t !== "unknown") {
            err(
              CODES.OPERATOR_TYPE_ERROR,
              `NOT requires a boolean value, but this is ${describeType(t)}.`,
              expr.span
            );
          }
          return "boolean";
        }
        // unary '-'
        if (t !== "integer" && t !== "decimal" && t !== "unknown") {
          err(
            CODES.OPERATOR_TYPE_ERROR,
            `Unary '-' requires a number, but this is ${describeType(t)}.`,
            expr.span
          );
        }
        return t;
      }

      case "BinaryOp":
        return this.inferBinaryOp(expr, scope);

      case "CallExpression": {
        const name = expr.callee.name;
        const proc = this.procedures.get(name);
        if (!proc) {
          err(
            CODES.UNDEFINED_PROCEDURE,
            `"${name}" is not a defined procedure.`,
            expr.callee.span,
            null,
            `Define it first with DO ${name} ... END, or check the spelling.`
          );
        }
        if (expr.arguments.length !== proc.arity) {
          err(
            CODES.ARITY_MISMATCH,
            `"${name}" expects ${proc.arity} argument(s), but ${expr.arguments.length} were given.`,
            expr.span,
            null,
            `Call it with exactly ${proc.arity} argument(s), matching its INPUT declarations.`,
            [[proc.node.name.span, `"${name}" is declared here`]]
          );
        }
        for (const arg of expr.arguments) this.infer(arg, scope);
        return "unknown";
      }

      default:
        throw new Error(`Analyzer: unhandled expression kind '${expr.kind}'`);
    }
  }

  inferBinaryOp(expr, scope) {
    const { operator, left, right } = expr;
    const lt = this.infer(left, scope);
    const rt = this.infer(right, scope);
    const numeric = (t) => t === "integer" || t === "decimal";

    if (operator === "AND" || operator === "OR") {
      if ((lt !== "boolean" && lt !== "unknown") || (rt !== "boolean" && rt !== "unknown")) {
        err(
          CODES.OPERATOR_TYPE_ERROR,
          `${operator} requires boolean values on both sides.`,
          expr.span
        );
      }
      return "boolean";
    }

    if (operator === "==" || operator === "!=") {
      if (lt !== "unknown" && rt !== "unknown" && lt !== rt) {
        err(
          CODES.EQUALITY_TYPE_MISMATCH,
          `Cannot compare a ${lt} value with a ${rt} value using ${operator}.`,
          expr.span,
          "NOVA's equality operator requires both sides to be the same type.",
          "Convert one side, or compare values of the same type."
        );
      }
      return "boolean";
    }

    if (operator === "<" || operator === ">" || operator === "<=" || operator === ">=") {
      if ((!numeric(lt) && lt !== "unknown") || (!numeric(rt) && rt !== "unknown")) {
        err(
          CODES.OPERATOR_TYPE_ERROR,
          `${operator} requires numbers on both sides.`,
          expr.span
        );
      }
      return "boolean";
    }

    // + - * /
    if ((!numeric(lt) && lt !== "unknown") || (!numeric(rt) && rt !== "unknown")) {
      err(
        CODES.OPERATOR_TYPE_ERROR,
        `Cannot use ${operator} between a ${lt} value and a ${rt} value.`,
        expr.span,
        `${operator} works between two numbers (integer/decimal). It does not convert text to a number automatically.`,
        operator === "+"
          ? 'If you meant to combine text, use string interpolation instead, e.g. "{a}{b}".'
          : null
      );
    }
    if (lt === "unknown" || rt === "unknown") return "unknown";
    return lt === "decimal" || rt === "decimal" ? "decimal" : "integer";
  }
}

export function analyze(program, hostGlobals = {}) {
  return new Analyzer(program, hostGlobals).analyze();
}
