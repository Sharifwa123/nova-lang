// Semantic analyzer — see docs/SPECIFICATION.md §13.
// One pass over the whole AST, before any statement executes (fail fast,
// fail predictably, §13): scope resolution, duplicate-declaration checks,
// the §3/§4 type rules, RETURN placement, and call arity.
import { Scope } from "./scope.js";
import { Diagnostic, NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";
import { BUILTINS } from "../stdlib/builtins.js";

function err(code, message, span, explanation = null, suggestion = null, relatedSpans = []) {
  throw new NovaError(
    new Diagnostic({ code, message, primarySpan: span, relatedSpans, explanation, suggestion })
  );
}

function describeType(t) {
  const article = /^[aeiou]/.test(t) ? "an" : "a";
  const names = { integer: "a number (integer)", decimal: "a number (decimal)", text: "a text value", boolean: "a boolean value" };
  return names[t] ?? `${article} ${t} value`;
}

// ADR-004/ADR-005 — recognized primitive type-annotation names. DATA names
// (checked separately, since they're user-declared) extend this set.
const PRIMITIVE_TYPE_NAMES = new Set(["integer", "decimal", "text", "boolean", "list", "record"]);

// ADR-004 — conservative, sound "does this statement list definitely
// return a value on every path" check. See docs/adr/ADR-004 for the exact
// rules and why loops never count.
function definitelyReturns(statements) {
  return statements.some((stmt) => {
    if (stmt.kind === "ReturnStatement") return true;
    if (stmt.kind === "IfStatement") {
      return (
        stmt.elseBranch !== null &&
        stmt.branches.every((b) => definitelyReturns(b.body)) &&
        definitelyReturns(stmt.elseBranch)
      );
    }
    // ADR-010 — TRY/CATCH is exhaustive (exactly one of the two bodies
    // ever finishes running: the TRY body to completion, or a CATCH body
    // after an error partway through), the same "every branch covered"
    // shape as IF/ELSE, unlike a loop that can run zero times.
    if (stmt.kind === "TryStatement") {
      return definitelyReturns(stmt.tryBody) && definitelyReturns(stmt.catchBody);
    }
    return false;
  });
}

export class Analyzer {
  constructor(program, hostGlobals = {}) {
    this.program = program;
    this.procedures = new Map(); // name -> { arity, node, paramTypes, returnType }
    this.dataTypes = new Map(); // name -> { node, fields: [{name, type}] }
    this.globalScope = new Scope();
    for (const [name, type] of Object.entries(hostGlobals)) {
      this.globalScope.defineLocal(name, type);
    }
    // ADR-007 — built-ins share the procedure namespace and call syntax
    // with user DO declarations; `node: null` marks "no source location".
    for (const b of BUILTINS) {
      this.procedures.set(b.name, {
        arity: b.paramNames.length,
        node: null,
        paramNames: b.paramNames,
        paramTypes: b.paramTypes,
        returnType: b.returnType,
      });
    }
  }

  analyze() {
    // Two phases so DATA types and procedures can forward- and
    // self-reference each other regardless of declaration order (ADR-005).
    this.registerTopLevelDeclarations(this.program.statements);
    this.resolveTopLevelTypes();
    this.checkStatements(this.program.statements, this.globalScope, {
      insideProcedure: false,
      declaredReturnType: null,
    });
    return this.program;
  }

  checkTypeName(typeName, span) {
    if (typeName === null) return;
    if (PRIMITIVE_TYPE_NAMES.has(typeName) || this.dataTypes.has(typeName)) return;
    err(
      CODES.UNKNOWN_TYPE_NAME,
      `"${typeName}" is not a recognized type name.`,
      span,
      `Recognized type names are: ${[...PRIMITIVE_TYPE_NAMES].join(", ")}, or a DATA type declared with DATA ${typeName} ... END.`,
      "Check the spelling, or remove the annotation."
    );
  }

  // ADR-004/ADR-005 — shared assignability predicate for SET/CHANGE
  // reassignment, call arguments, and RETURN values. A generic 'record'
  // may flow into a DATA-typed slot and vice versa; two *different* DATA
  // types remain incompatible, same as any other real type mismatch.
  typesAreAssignable(targetType, sourceType) {
    if (targetType === "unknown" || sourceType === "unknown") return true;
    if (targetType === sourceType) return true;
    // integer/decimal interoperate in both directions - rejecting e.g. a
    // decimal-tracked variable later accepting an integer value would be
    // needlessly surprising, and inconsistent with §3's arithmetic
    // coercion already freely mixing the two.
    if (
      (targetType === "decimal" && sourceType === "integer") ||
      (targetType === "integer" && sourceType === "decimal")
    ) {
      return true;
    }
    if (targetType === "record" && this.dataTypes.has(sourceType)) return true;
    if (this.dataTypes.has(targetType) && sourceType === "record") return true;
    return false;
  }

  // Type-compatibility rule for SET reassignment and CHANGE (§4.1, §4.3).
  // Returns the resulting tracked type, or throws.
  reassignCompatibleType(existingType, newType, name, span) {
    if (!this.typesAreAssignable(existingType, newType)) {
      err(
        CODES.REASSIGN_TYPE_MISMATCH,
        `"${name}" was created as ${describeType(existingType)}, but this assigns ${describeType(newType)}.`,
        span,
        "NOVA variables keep the same type once created (integer values may later be assigned a decimal, but no other type change is allowed).",
        `Use a different name for the new value, or make sure the value being assigned to "${name}" is ${describeType(existingType)}.`
      );
    }
    if (existingType === "unknown") return newType;
    if (newType === "unknown") return existingType;
    if (existingType === newType) return existingType;
    if (existingType === "integer" && newType === "decimal") return "decimal";
    if (existingType === "decimal" && newType === "integer") return "decimal";
    // The only remaining assignable case: a DATA name paired with generic
    // 'record' (in either direction) - widen down to the safe, general type
    // rather than claim more precision than is actually known (ADR-005).
    return "record";
  }

  // ADR-005 — validates a record literal used directly where `dataTypeName`
  // is expected: exact field match (no missing/extra fields) and every
  // field's value type-compatible with its declared field type.
  checkRecordLiteralAgainstDataType(recordLiteralNode, dataTypeName, scope) {
    const dataType = this.dataTypes.get(dataTypeName);
    const literalFieldsByName = new Map(recordLiteralNode.fields.map((f) => [f.name, f]));
    const declaredNames = new Set(dataType.fields.map((f) => f.name));

    for (const declaredField of dataType.fields) {
      const literalField = literalFieldsByName.get(declaredField.name);
      if (!literalField) {
        err(
          CODES.MISSING_DATA_FIELD,
          `${dataTypeName} requires a "${declaredField.name}" field, but this record literal doesn't have one.`,
          recordLiteralNode.span,
          null,
          `Add "${declaredField.name}: ..." to this record literal.`,
          [[dataType.node.name.span, `${dataTypeName} is declared here`]]
        );
      }
      const fieldValueType = this.infer(literalField.value, scope);
      if (!this.typesAreAssignable(declaredField.type, fieldValueType)) {
        err(
          CODES.DATA_FIELD_TYPE_MISMATCH,
          `Field "${declaredField.name}" of ${dataTypeName} must be ${describeType(declaredField.type)}, but this is ${describeType(fieldValueType)}.`,
          literalField.value.span,
          null,
          `Make "${declaredField.name}" ${describeType(declaredField.type)}.`
        );
      }
    }
    for (const literalField of recordLiteralNode.fields) {
      if (!declaredNames.has(literalField.name)) {
        err(
          CODES.UNEXPECTED_DATA_FIELD,
          `"${literalField.name}" is not a field of ${dataTypeName}.`,
          literalField.nameSpan,
          `${dataTypeName} only has: ${[...declaredNames].join(", ")}.`,
          `Remove "${literalField.name}", or check the field name.`,
          [[dataType.node.name.span, `${dataTypeName} is declared here`]]
        );
      }
    }
  }

  // ADR-005 — looks up `fieldName` on the known DATA type `dataTypeName`,
  // returning its declared type, or reporting E-SEM-021 if it doesn't
  // exist. Shared by FieldAccess and string-interpolation path walking.
  staticFieldType(dataTypeName, fieldName, span) {
    const dataType = this.dataTypes.get(dataTypeName);
    const field = dataType.fields.find((f) => f.name === fieldName);
    if (!field) {
      err(
        CODES.UNKNOWN_DATA_FIELD_ACCESS,
        `"${fieldName}" is not a field of ${dataTypeName}.`,
        span,
        `${dataTypeName} only has: ${dataType.fields.map((f) => f.name).join(", ")}.`,
        "Check the field name.",
        [[dataType.node.name.span, `${dataTypeName} is declared here`]]
      );
    }
    return field.type;
  }

  registerTopLevelDeclarations(statements) {
    for (const stmt of statements) {
      if (stmt.kind === "ProcedureDeclaration") {
        const name = stmt.name.name;
        if (this.procedures.has(name)) {
          const prev = this.procedures.get(name);
          if (prev.node === null) {
            // ADR-007 — colliding with a built-in: no source location to
            // cite as "previous definition", so a dedicated message instead.
            err(
              CODES.DUPLICATE_PROCEDURE,
              `"${name}" is a built-in procedure and cannot be redefined.`,
              stmt.name.span,
              null,
              `Rename this procedure, e.g. ${name}2.`
            );
          }
          err(
            CODES.DUPLICATE_PROCEDURE,
            `"${name}" is already defined.`,
            stmt.name.span,
            "A name can only be declared once in the same scope.",
            `Rename one of the procedures, e.g. ${name}2.`,
            [[prev.node.name.span, "Previous definition"]]
          );
        }
        this.procedures.set(name, {
          arity: stmt.parameters.length,
          node: stmt,
          paramNames: stmt.parameters.map((p) => p.name.name),
          paramTypes: null,
          returnType: null,
        });
      } else if (stmt.kind === "DataDeclaration") {
        const name = stmt.name.name;
        if (this.dataTypes.has(name)) {
          const prev = this.dataTypes.get(name);
          err(
            CODES.DUPLICATE_DATA_TYPE,
            `"${name}" is already defined.`,
            stmt.name.span,
            "A DATA type can only be declared once.",
            `Rename one of the declarations, e.g. ${name}2.`,
            [[prev.node.name.span, "Previous definition"]]
          );
        }
        this.dataTypes.set(name, { node: stmt, fields: null });
      }
    }
  }

  // Phase 2 — every DATA/procedure name is now known, so field and
  // annotation type names can be validated regardless of declaration
  // order, including self- and forward-references (ADR-005).
  resolveTopLevelTypes() {
    for (const [, dataType] of this.dataTypes) {
      const seen = new Map();
      const fields = [];
      for (const field of dataType.node.fields) {
        if (seen.has(field.name)) {
          err(
            CODES.DUPLICATE_FIELD,
            `"${field.name}" is already declared in this DATA type.`,
            field.nameSpan,
            "A DATA type cannot declare the same field twice.",
            `Remove one of the two "${field.name}:" entries.`,
            [[seen.get(field.name), `"${field.name}" was first declared here`]]
          );
        }
        seen.set(field.name, field.nameSpan);
        this.checkTypeName(field.type, field.nameSpan);
        fields.push({ name: field.name, type: field.type });
      }
      dataType.fields = fields;
    }
    for (const [, proc] of this.procedures) {
      if (proc.node === null) continue; // built-in (ADR-007) - already fully resolved
      this.checkTypeName(proc.node.returnType, proc.node.name.span);
      for (const param of proc.node.parameters) this.checkTypeName(param.type, param.name.span);
      proc.paramTypes = proc.node.parameters.map((p) => p.type ?? "unknown");
      proc.returnType = proc.node.returnType;
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
          const resultType = this.reassignCompatibleType(existing.type, exprType, stmt.name.name, stmt.span);
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
        // ADR-009 — CHANGE list[i] = ... (possibly chained): mutate an
        // element rather than the binding itself. No single tracked type
        // exists for "element of a list" (elements may be mixed types,
        // ADR-003), so this skips the ordinary reassignment type check.
        if (stmt.indexPath.length > 0) {
          let targetType = resolved.binding.type;
          for (const indexExpr of stmt.indexPath) {
            if (targetType !== "list" && targetType !== "unknown") {
              err(
                CODES.INDEX_ON_NON_LIST,
                `Cannot index a value of type '${targetType}' with [ ].`,
                stmt.name.span,
                "CHANGE with [ ] requires a list.",
                null
              );
            }
            const indexType = this.infer(indexExpr, scope);
            if (indexType !== "integer" && indexType !== "unknown") {
              err(
                CODES.INDEX_NOT_INTEGER,
                `A list index must be an integer, but this is ${describeType(indexType)}.`,
                indexExpr.span
              );
            }
            targetType = "unknown"; // element type is never tracked (ADR-003/009)
          }
          this.infer(stmt.value, scope);
          return;
        }

        const exprType = this.infer(stmt.value, scope);
        resolved.binding.type = this.reassignCompatibleType(
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
          procScope.defineLocal(param.name.name, param.type ?? "unknown");
        }
        this.checkStatements(stmt.body, procScope, {
          insideProcedure: true,
          declaredReturnType: stmt.returnType,
        });
        // ADR-004 — a declared return type must be honored on every path.
        if (stmt.returnType !== null && !definitelyReturns(stmt.body)) {
          err(
            CODES.NOT_ALL_PATHS_RETURN,
            `"${stmt.name.name}" declares RETURNS ${stmt.returnType}, but does not return a value on every path.`,
            stmt.name.span,
            "Some path through this procedure can fall off the END without hitting a RETURN, which would silently produce NONE instead of the declared type.",
            `Add a RETURN of type ${stmt.returnType} on every path (including a final ELSE, if the last statement is an IF).`
          );
        }
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
        const declaredReturnType = ctx.declaredReturnType ?? null;
        if (declaredReturnType !== null && stmt.value && stmt.value.kind === "RecordLiteral" && this.dataTypes.has(declaredReturnType)) {
          // Infer the literal's fields (nested errors) then check it
          // exactly against the declared DATA shape (ADR-005).
          this.infer(stmt.value, scope);
          this.checkRecordLiteralAgainstDataType(stmt.value, declaredReturnType, scope);
          return;
        }
        const valueType = stmt.value ? this.infer(stmt.value, scope) : "none";
        if (declaredReturnType !== null && !this.typesAreAssignable(declaredReturnType, valueType)) {
          if (stmt.value === null) {
            err(
              CODES.RETURN_TYPE_MISMATCH,
              `This procedure declares RETURNS ${declaredReturnType}, but this is a bare RETURN with no value.`,
              stmt.span,
              null,
              `Return a value of type ${declaredReturnType}, e.g. RETURN ...`
            );
          }
          err(
            CODES.RETURN_TYPE_MISMATCH,
            `This procedure declares RETURNS ${declaredReturnType}, but this RETURN gives ${describeType(valueType)}.`,
            stmt.value.span,
            null,
            `Return a value of type ${declaredReturnType}, or change the procedure's RETURNS annotation.`
          );
        }
        return;
      }

      case "ExpressionStatement":
        this.infer(stmt.expression, scope);
        return;

      case "DataDeclaration":
        // Already fully validated in resolveTopLevelTypes (phase 2) -
        // nothing left to check when the main traversal reaches it.
        return;

      case "TryStatement": {
        this.checkStatements(stmt.tryBody, scope.child(), ctx);
        const catchScope = scope.child();
        catchScope.defineLocal(stmt.errorVar.name, "text");
        this.checkStatements(stmt.catchBody, catchScope, ctx);
        return;
      }

      case "DeleteStatement": {
        if (!this.dataTypes.has(stmt.typeName)) {
          err(
            CODES.UNKNOWN_DATA_TYPE_IN_DELETE,
            `"${stmt.typeName}" is not a DATA type.`,
            stmt.typeNameSpan,
            null,
            `Declare it first with DATA ${stmt.typeName} ... END, or check the spelling.`
          );
        }
        const idType = this.infer(stmt.idExpression, scope);
        if (idType !== "integer" && idType !== "unknown") {
          err(
            CODES.DELETE_ID_NOT_INTEGER,
            `DELETE requires an integer id, but this is ${describeType(idType)}.`,
            stmt.idExpression.span,
            "SAVE returns the integer id to use here.",
            null
          );
        }
        return;
      }

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
            // ADR-005 — walk the dotted path statically as far as DATA
            // shape info allows; falls back to permissive once it runs out.
            let currentType = resolved.binding.type;
            for (let i = 1; i < part.path.length && this.dataTypes.has(currentType); i++) {
              currentType = this.staticFieldType(currentType, part.path[i], part.span);
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
        const targetType = this.infer(expr.target, scope);
        // ADR-005 — once the target's static type is a known DATA type,
        // field access is checked (and precisely typed) statically;
        // otherwise it stays exactly as permissive as v0.1-v0.3 ('unknown').
        if (this.dataTypes.has(targetType)) {
          return this.staticFieldType(targetType, expr.field, expr.span);
        }
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
            proc.node ? [[proc.node.name.span, `"${name}" is declared here`]] : []
          );
        }
        expr.arguments.forEach((arg, i) => {
          const paramType = proc.paramTypes[i];
          const paramName = proc.paramNames[i];
          // ADR-005 — a record literal argument against a DATA-typed
          // parameter gets exact field checking, not just 'record'~=DATA.
          if (arg.kind === "RecordLiteral" && this.dataTypes.has(paramType)) {
            this.infer(arg, scope);
            this.checkRecordLiteralAgainstDataType(arg, paramType, scope);
            return;
          }
          const argType = this.infer(arg, scope);
          if (!this.typesAreAssignable(paramType, argType)) {
            err(
              CODES.ARGUMENT_TYPE_MISMATCH,
              `"${name}" expects ${describeType(paramType)} for "${paramName}", but this is ${describeType(argType)}.`,
              arg.span,
              null,
              `Pass a value of type ${paramType}, or change the parameter's declared type.`,
              proc.node ? [[proc.node.parameters[i].name.span, `"${paramName}" is declared here`]] : []
            );
          }
        });
        return proc.returnType ?? "unknown";
      }

      case "SaveExpression": {
        // ADR-006 — unlike everywhere else in NOVA, 'unknown' is NOT
        // permissively accepted here: the target collection is derived
        // entirely from the static type, and there is no runtime fallback.
        const valueType = this.infer(expr.value, scope);
        if (!this.dataTypes.has(valueType)) {
          err(
            CODES.SAVE_REQUIRES_DATA_TYPE,
            `SAVE requires a value whose specific DATA type is known, but this is ${describeType(valueType)}.`,
            expr.value.span,
            "SAVE needs to know which DATA type's collection to save into, which NOVA can only determine from a value that came from a typed INPUT parameter or a typed RETURNS procedure result - a plain, untyped record literal doesn't carry that information by itself.",
            "Pass this through a procedure with a RETURNS <DataType> annotation first, or an INPUT of that type."
          );
        }
        expr.dataTypeName = valueType; // read by the interpreter at run time
        return "integer";
      }

      case "GetExpression": {
        if (!this.dataTypes.has(expr.typeName)) {
          err(
            CODES.UNKNOWN_DATA_TYPE_IN_GET,
            `"${expr.typeName}" is not a DATA type.`,
            expr.typeNameSpan,
            null,
            `Declare it first with DATA ${expr.typeName} ... END, or check the spelling.`
          );
        }
        return "list";
      }

      case "IndexAccess": {
        const targetType = this.infer(expr.target, scope);
        if (targetType !== "list" && targetType !== "unknown") {
          err(
            CODES.INDEX_ON_NON_LIST,
            `Cannot index a value of type '${targetType}' with [ ].`,
            expr.target.span,
            "[ ] indexing requires a list.",
            null
          );
        }
        const indexType = this.infer(expr.index, scope);
        if (indexType !== "integer" && indexType !== "unknown") {
          err(
            CODES.INDEX_NOT_INTEGER,
            `A list index must be an integer, but this is ${describeType(indexType)}.`,
            expr.index.span
          );
        }
        return "unknown"; // element type is never tracked (ADR-003/ADR-009)
      }

      case "AskExpression": {
        this.infer(expr.prompt, scope); // any type is fine, display()-ed like SHOW
        return "text";
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
