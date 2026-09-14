// Tree-walking interpreter — see docs/SPECIFICATION.md §14.
// An explicit starting implementation strategy (not a permanent
// architectural commitment, per §14) operating on a semantically-validated
// AST: by the time this runs, the analyzer has already rejected every
// program with a statically-detectable error.
import {
  NONE, makeInt, makeDec, makeText, makeBool, makeList, makeRecord,
  display, valuesEqual, resultNumericType,
} from "./values.js";
import { Diagnostic, NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";

// Runtime environment — mirrors analyzer/scope.js's Scope one-for-one so
// CHANGE resolves identically at analysis time and run time (ADR-002).
class Environment {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map();
  }
  defineLocal(name, value) {
    this.vars.set(name, value);
  }
  // Returns the Environment actually holding `name`, or null.
  resolveEnv(name) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) return env;
      env = env.parent;
    }
    return null;
  }
  get(name) {
    const env = this.resolveEnv(name);
    if (!env) throw new Error(`Internal error: undefined variable '${name}' reached the interpreter unvalidated.`);
    return env.vars.get(name);
  }
  child() {
    return new Environment(this);
  }
}

class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

function runtimeError(code, message, span, explanation = null, suggestion = null) {
  throw new NovaError(new Diagnostic({ code, message, primarySpan: span, explanation, suggestion }));
}

function numericResult(l, r, fn) {
  const t = resultNumericType(l, r);
  const v = fn(l.value, r.value);
  return t === "decimal" ? makeDec(v) : makeInt(v);
}

export class Interpreter {
  constructor(program, hostGlobals = {}, { write = (s) => process.stdout.write(s + "\n") } = {}) {
    this.program = program;
    this.globalEnv = new Environment();
    for (const [name, value] of Object.entries(hostGlobals)) {
      this.globalEnv.defineLocal(name, value);
    }
    this.procedures = new Map(); // name -> { params: [string], body: Block }
    this.write = write;
  }

  run() {
    this.registerProcedures(this.program.statements);
    this.execStatements(this.program.statements, this.globalEnv);
  }

  registerProcedures(statements) {
    for (const stmt of statements) {
      if (stmt.kind === "ProcedureDeclaration") {
        // ADR-004 — parameters are {name: Identifier, type} now; the
        // interpreter only ever needed the name (types are enforced
        // statically by the analyzer, never re-checked at runtime, §13).
        this.procedures.set(stmt.name.name, {
          params: stmt.parameters.map((p) => p.name.name),
          body: stmt.body,
        });
      }
    }
  }

  execStatements(statements, env) {
    for (const stmt of statements) this.execStatement(stmt, env);
  }

  execStatement(stmt, env) {
    switch (stmt.kind) {
      case "ShowStatement": {
        const v = this.evaluate(stmt.value, env);
        this.write(display(v));
        return;
      }
      case "SetStatement": {
        const v = this.evaluate(stmt.value, env);
        env.defineLocal(stmt.name.name, v);
        return;
      }
      case "ChangeStatement": {
        const v = this.evaluate(stmt.value, env);
        const target = env.resolveEnv(stmt.name.name);
        if (!target) {
          runtimeError(
            CODES.CHANGE_UNDEFINED,
            `CHANGE requires "${stmt.name.name}" to already exist, but it hasn't been created yet.`,
            stmt.name.span
          );
        }
        target.vars.set(stmt.name.name, v);
        return;
      }
      case "IfStatement": {
        for (const branch of stmt.branches) {
          const c = this.evaluate(branch.condition, env);
          if (c.type === "boolean" && c.value === true) {
            this.execStatements(branch.body, env.child());
            return;
          }
        }
        if (stmt.elseBranch) this.execStatements(stmt.elseBranch, env.child());
        return;
      }
      case "ForEachStatement": {
        const iterable = this.evaluate(stmt.iterable, env);
        if (iterable.type !== "list") {
          runtimeError(
            CODES.FOR_EACH_NOT_LIST,
            `Cannot iterate over a value of type '${iterable.type}' with FOR EACH.`,
            stmt.iterable.span
          );
        }
        // §8.4 — a fresh binding per iteration, not one reused binding.
        for (const item of iterable.value) {
          const child = env.child();
          child.defineLocal(stmt.loopVariable.name, item);
          this.execStatements(stmt.body, child);
        }
        return;
      }
      case "RepeatStatement": {
        const count = this.evaluate(stmt.count, env);
        if (count.type !== "integer") {
          runtimeError(
            CODES.REPEAT_COUNT_NOT_INTEGER,
            `REPEAT requires an integer count, but this is a ${count.type} value.`,
            stmt.count.span
          );
        }
        for (let i = 0; i < count.value; i++) {
          this.execStatements(stmt.body, env.child());
        }
        return;
      }
      case "ProcedureDeclaration":
        return; // already registered by registerProcedures
      case "ReturnStatement": {
        const v = stmt.value ? this.evaluate(stmt.value, env) : NONE;
        throw new ReturnSignal(v);
      }
      case "ExpressionStatement":
        this.evaluate(stmt.expression, env);
        return;
      default:
        throw new Error(`Interpreter: unhandled statement kind '${stmt.kind}'`);
    }
  }

  callProcedure(name, argValues, span) {
    const proc = this.procedures.get(name);
    if (!proc) {
      runtimeError(CODES.UNDEFINED_PROCEDURE, `"${name}" is not a defined procedure.`, span);
    }
    const env = this.globalEnv.child(); // §8.3 — parent is global scope, not the call site.
    proc.params.forEach((p, i) => env.defineLocal(p, argValues[i]));
    try {
      this.execStatements(proc.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return NONE;
  }

  evaluate(expr, env) {
    switch (expr.kind) {
      case "IntegerLiteral": return makeInt(expr.value);
      case "DecimalLiteral": return makeDec(expr.value);
      case "BooleanLiteral": return makeBool(expr.value);

      case "StringLiteral": {
        let out = "";
        for (const part of expr.parts) {
          if (part.kind === "text") {
            out += part.value;
            continue;
          }
          let base = env.get(part.path[0]);
          for (let i = 1; i < part.path.length; i++) {
            const field = part.path[i];
            if (base.type !== "record" || !(field in base.value)) {
              runtimeError(
                CODES.NO_SUCH_FIELD,
                `"${part.path.slice(0, i + 1).join(".")}" has no field "${field}".`,
                part.span
              );
            }
            base = base.value[field];
          }
          out += display(base);
        }
        return makeText(out);
      }

      case "Identifier":
        return env.get(expr.name);

      case "FieldAccess": {
        const target = this.evaluate(expr.target, env);
        if (target.type !== "record" || !(expr.field in target.value)) {
          runtimeError(CODES.NO_SUCH_FIELD, `This value has no field "${expr.field}".`, expr.span);
        }
        return target.value[expr.field];
      }

      case "UnaryOp": {
        const v = this.evaluate(expr.operand, env);
        if (expr.operator === "NOT") return makeBool(!v.value);
        return v.type === "decimal" ? makeDec(-v.value) : makeInt(-v.value);
      }

      case "BinaryOp":
        return this.evalBinary(expr, env);

      case "CallExpression": {
        const args = expr.arguments.map((a) => this.evaluate(a, env)); // left-to-right (§5.6)
        return this.callProcedure(expr.callee.name, args, expr.span);
      }

      case "ListLiteral":
        return makeList(expr.elements.map((el) => this.evaluate(el, env))); // left-to-right (§5.6)

      case "RecordLiteral": {
        const fields = {};
        for (const f of expr.fields) fields[f.name] = this.evaluate(f.value, env); // left-to-right
        return makeRecord(fields);
      }

      default:
        throw new Error(`Interpreter: unhandled expression kind '${expr.kind}'`);
    }
  }

  evalBinary(expr, env) {
    const { operator } = expr;

    if (operator === "AND") {
      const l = this.evaluate(expr.left, env);
      if (l.value !== true) return makeBool(false);
      return makeBool(this.evaluate(expr.right, env).value === true);
    }
    if (operator === "OR") {
      const l = this.evaluate(expr.left, env);
      if (l.value === true) return makeBool(true);
      return makeBool(this.evaluate(expr.right, env).value === true);
    }

    const l = this.evaluate(expr.left, env);
    const r = this.evaluate(expr.right, env);

    switch (operator) {
      case "==": return makeBool(valuesEqual(l, r));
      case "!=": return makeBool(!valuesEqual(l, r));
      case "<": return makeBool(l.value < r.value);
      case ">": return makeBool(l.value > r.value);
      case "<=": return makeBool(l.value <= r.value);
      case ">=": return makeBool(l.value >= r.value);
      case "+": return numericResult(l, r, (a, b) => a + b);
      case "-": return numericResult(l, r, (a, b) => a - b);
      case "*": return numericResult(l, r, (a, b) => a * b);
      case "/": {
        if (r.value === 0) {
          runtimeError(CODES.DIVIDE_BY_ZERO, "Cannot divide by zero.", expr.span);
        }
        // True division always yields a decimal (§14 — never Infinity/NaN;
        // integer / integer that isn't exact must not silently truncate).
        return makeDec(l.value / r.value);
      }
      default:
        throw new Error(`Interpreter: unhandled operator '${operator}'`);
    }
  }
}

export function run(program, hostGlobals = {}, options = {}) {
  new Interpreter(program, hostGlobals, options).run();
}
