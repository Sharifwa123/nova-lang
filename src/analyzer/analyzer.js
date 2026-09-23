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

// ADR-011 — PAGE content must be a literal: no identifiers, calls, or
// interpolated strings, since PAGE is compiled, never executed.
function isStaticLiteral(expr) {
  if (expr.kind === "StringLiteral") return expr.parts.every((p) => p.kind === "text");
  return expr.kind === "IntegerLiteral" || expr.kind === "DecimalLiteral" || expr.kind === "BooleanLiteral";
}

function staticLiteralType(expr) {
  switch (expr.kind) {
    case "IntegerLiteral": return "integer";
    case "DecimalLiteral": return "decimal";
    case "BooleanLiteral": return "boolean";
    case "StringLiteral": return "text";
    default: return "unknown";
  }
}

// ADR-004/ADR-005 — recognized primitive type-annotation names. DATA names
// (checked separately, since they're user-declared) extend this set.
const PRIMITIVE_TYPE_NAMES = new Set(["integer", "decimal", "text", "boolean", "list", "record"]);

// ADR-015 — the subset of PRIMITIVE_TYPE_NAMES a REQUEST AS <Type> field
// may be: a JSON request body has a direct, unambiguous mapping only for
// these four; a nested DATA type, list, or record would need a recursive
// (and, for list, an element-typed) validation story NOVA doesn't have yet.
const REQUEST_SCALAR_TYPES = new Set(["integer", "decimal", "text", "boolean"]);

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
    this.pages = new Map(); // ADR-011 — route -> PageDeclaration node
    this.apiRoutes = new Map(); // ADR-014 — "<METHOD> <route>" -> api declaration
    this.topLevelServices = new Set(); // which ServiceDeclaration nodes were seen at genuine top level (see checkStatement)
    this.currentApiMethod = null; // ADR-015 — the API method whose body is currently being checked, or null
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
    this.checkPageApiRouteCollisions();
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
      } else if (stmt.kind === "PageDeclaration") {
        this.registerPage(stmt);
      } else if (stmt.kind === "ServiceDeclaration") {
        this.topLevelServices.add(stmt);
        this.registerService(stmt);
      }
    }
  }

  // ADR-014 — route validation and method+route uniqueness, checked in
  // phase 1 exactly like registerPage: neither needs DATA fields resolved.
  // Body-checking (which does need DATA fields) waits for the main
  // traversal, same timing ProcedureDeclaration bodies already use.
  registerService(stmt) {
    for (const api of stmt.apis) {
      if (!api.route.startsWith("/")) {
        err(
          CODES.INVALID_API_ROUTE,
          `An API route must start with "/", but got "${api.route}".`,
          api.routeSpan,
          null,
          `Use "/${api.route}" or similar.`
        );
      }
      const key = `${api.method} ${api.route}`;
      if (this.apiRoutes.has(key)) {
        err(
          CODES.DUPLICATE_API_ROUTE,
          `The route "${api.route}" (${api.method}) is already used by another API.`,
          api.routeSpan,
          "Each API endpoint must have a unique method + route combination.",
          "Use a different route.",
          [[this.apiRoutes.get(key).routeSpan, "Previous API with this route"]]
        );
      }
      this.apiRoutes.set(key, api);
    }
  }

  // ADR-011 — route validation and uniqueness happen here, in phase 1,
  // since they don't depend on DATA field resolution. Element validation
  // (ADR-012) needs DATA fields already resolved (staticFieldType), so it
  // waits for phase 2 - see resolveTopLevelTypes.
  registerPage(stmt) {
    if (!stmt.route.startsWith("/")) {
      err(
        CODES.INVALID_PAGE_ROUTE,
        `A PAGE route must start with "/", but got "${stmt.route}".`,
        stmt.routeSpan,
        null,
        `Use "/${stmt.route}" or similar.`
      );
    }
    if (this.pages.has(stmt.route)) {
      err(
        CODES.DUPLICATE_PAGE_ROUTE,
        `The route "${stmt.route}" is already used by another PAGE.`,
        stmt.routeSpan,
        "Each PAGE must have a unique route.",
        "Use a different route.",
        [[this.pages.get(stmt.route).routeSpan, "Previous PAGE with this route"]]
      );
    }
    this.pages.set(stmt.route, stmt);
  }

  // ADR-016 — nova serve now serves both PAGE and API routes from one
  // server, so a PAGE route and an API GET route claiming the same path
  // would be a genuine runtime ambiguity (both want "GET <route>"). Both
  // route tables are fully populated by the time registerTopLevelDeclarations
  // finishes (phase 1), regardless of which kind of declaration appeared
  // first in the file, so this runs once right after it.
  checkPageApiRouteCollisions() {
    for (const [route, page] of this.pages) {
      const key = `GET ${route}`;
      if (this.apiRoutes.has(key)) {
        err(
          CODES.PAGE_ROUTE_COLLIDES_WITH_API,
          `PAGE "${route}" and API GET "${route}" cannot share the same route - nova serve serves both PAGE and API routes from one server.`,
          page.routeSpan,
          "A GET request to this path would be ambiguous between the compiled page and the API handler.",
          "Use a different route for one of the two.",
          [[this.apiRoutes.get(key).routeSpan, "The colliding API GET is declared here"]]
        );
      }
    }
  }

  // ADR-013 — page-local state (SET at a PAGE's top level) is collected
  // once, up front, so BUTTON/TEXT/HEADING can reference it regardless of
  // where in the page it's declared (the same "register names first"
  // pattern used for DATA/procedures).
  collectPageStateVars(elements) {
    const stateVars = new Map();
    for (const el of elements) {
      if (el.kind !== "SET") continue;
      if (stateVars.has(el.name.name)) {
        err(
          CODES.DUPLICATE_PAGE_STATE,
          `"${el.name.name}" is already declared as page-local state.`,
          el.name.span,
          "Page-local state can only be declared once per PAGE.",
          `Rename one of the declarations, e.g. ${el.name.name}2.`
        );
      }
      if (!isStaticLiteral(el.value)) {
        err(
          CODES.PAGE_CONTENT_NOT_STATIC,
          "Page-local state's initial value must be a plain literal (PAGE content is compiled, not run).",
          el.value.span
        );
      }
      stateVars.set(el.name.name, staticLiteralType(el.value));
    }
    return stateVars;
  }

  // ADR-012/ADR-013 — recursive: a PAGE-level FOR EACH nests more page-
  // elements. `loopVarStack` is every enclosing FOR EACH's { name,
  // dataTypeName }, outermost first, so a body can reference any of them
  // (like ordinary lexical scoping) - and their fields are checked
  // against the real DATA shape (reusing staticFieldType, the same
  // machinery ordinary .field access already uses). `stateVars` is the
  // whole PAGE's page-local state (name -> type), collected once up front.
  validatePageElements(elements, loopVarStack, topLevel, stateVars) {
    let sawTitle = false;
    for (const el of elements) {
      if (el.kind === "FOR_EACH") {
        if (!this.dataTypes.has(el.dataTypeName)) {
          err(
            CODES.UNKNOWN_DATA_TYPE_IN_GET,
            `"${el.dataTypeName}" is not a DATA type.`,
            el.dataTypeNameSpan,
            null,
            `Declare it first with DATA ${el.dataTypeName} ... END, or check the spelling.`
          );
        }
        this.validatePageElements(
          el.body,
          [...loopVarStack, { name: el.loopVar.name, dataTypeName: el.dataTypeName }],
          false,
          stateVars
        );
        continue;
      }

      if (el.kind === "BUTTON") {
        // ADR-016 — BUTTON is now allowed inside FOR EACH: a per-record
        // button's label and click-handler data are both resolved against
        // the concrete bound record at PAGE-compile time (loopVarStack),
        // the same way HEADING/TEXT already resolve loop-bound content.
        this.checkPageContent(el.label, loopVarStack, stateVars);
        for (const action of el.actions) this.checkButtonAction(action, stateVars, loopVarStack);
        continue;
      }

      if ((el.kind === "TITLE" || el.kind === "STYLE" || el.kind === "SET") && !topLevel) {
        err(
          CODES.PAGE_TITLE_STYLE_NOT_TOP_LEVEL,
          `${el.kind} must be at the top level of a PAGE, not inside FOR EACH.`,
          el.span,
          el.kind === "SET"
            ? "Page-local state is scoped to the whole PAGE, not to one iteration."
            : `${el.kind === "TITLE" ? "A title" : "A stylesheet"} repeated once per record has no meaning.`,
          null
        );
      }
      if (el.kind === "SET") continue; // already validated by collectPageStateVars

      this.checkPageContent(el.value, loopVarStack, stateVars);

      if (el.kind === "STYLE" && staticLiteralType(el.value) !== "text") {
        err(
          CODES.PAGE_STYLE_NOT_TEXT,
          `STYLE requires text (raw CSS), but this is ${describeType(staticLiteralType(el.value))}.`,
          el.value.span
        );
      }
      if (el.kind === "TITLE") {
        if (sawTitle) {
          err(CODES.UNEXPECTED_TOKEN, "A PAGE can have at most one TITLE.", el.span);
        }
        sawTitle = true;
      }
    }
  }

  // ADR-012/ADR-013/ADR-016 — shared by any page-side value slot (ordinary
  // page content and a CALL API WITH payload field, ADR-016): valid iff
  // it's a plain literal, a field-access chain rooted at an enclosing FOR
  // EACH's loop variable (checked against that DATA type's real fields via
  // staticFieldType), or a bare reference to page-local state. Each call
  // site raises its own contextually-accurate error on failure.
  isValidPageValueRef(expr, loopVarStack, stateVars) {
    if (isStaticLiteral(expr)) return true;

    if (expr.kind === "Identifier" && stateVars.has(expr.name)) return true;

    if (expr.kind === "FieldAccess") {
      const fields = [];
      let root = expr;
      while (root.kind === "FieldAccess") {
        fields.unshift(root.field);
        root = root.target;
      }
      if (root.kind === "Identifier") {
        const frame = loopVarStack.find((f) => f.name === root.name);
        if (frame) {
          let currentType = frame.dataTypeName;
          for (const field of fields) currentType = this.staticFieldType(currentType, field, expr.span);
          return true;
        }
      }
    }

    return false;
  }

  pageValueHintText(loopVarStack, stateVars) {
    const hints = [];
    if (loopVarStack.length > 0) {
      hints.push(`a field of ${loopVarStack.map((f) => `"${f.name}"`).join("/")} (the current FOR EACH loop variable)`);
    }
    if (stateVars.size > 0) hints.push("a reference to page-local state declared with SET");
    return hints.length > 0 ? ` or ${hints.join(", or ")}` : "";
  }

  checkPageContent(expr, loopVarStack, stateVars) {
    if (this.isValidPageValueRef(expr, loopVarStack, stateVars)) return;
    err(
      CODES.PAGE_CONTENT_NOT_STATIC,
      `This requires a plain literal value${this.pageValueHintText(loopVarStack, stateVars)} (PAGE content is compiled, not run) — not a variable, call, or interpolated string.`,
      expr.span,
      "PAGE content is compiled, not run, so there is no variable state for anything else to resolve against.",
      null
    );
  }

  // ADR-013/ADR-016 — validates one statement inside a BUTTON's WHEN
  // CLICKED block. Only CHANGE targeting page-local state (a "safe"
  // expression - see assertNoUnsafeConstructs for why type/name
  // correctness and sandboxing are checked as two separate passes) or
  // CALL API (ADR-016) is allowed.
  checkButtonAction(action, stateVars, loopVarStack) {
    if (action.kind === "CallApiStatement") {
      this.checkCallApiAction(action, stateVars, loopVarStack);
      return;
    }
    if (action.kind !== "ChangeStatement") {
      err(
        CODES.BUTTON_ACTION_NOT_CHANGE,
        `Only CHANGE or CALL API is allowed inside WHEN CLICKED, but found ${action.kind}.`,
        action.span,
        "SAVE, GET, ASK, and procedure calls are never permitted in a click handler - a click handler can only update page-local state or call a declared API.",
        null
      );
    }
    if (action.indexPath.length > 0) {
      err(
        CODES.BUTTON_ACTION_INDEXED,
        "Page-local state is scalar - indexed CHANGE (list[i] = ...) is not allowed inside WHEN CLICKED.",
        action.span
      );
    }
    if (!stateVars.has(action.name.name)) {
      err(
        CODES.BUTTON_ACTION_NOT_STATE,
        `CHANGE inside WHEN CLICKED can only target page-local state, but "${action.name.name}" isn't page-local state declared with SET.`,
        action.name.span,
        null,
        "Declare it first with SET at the PAGE's top level."
      );
    }

    this.assertNoUnsafeConstructs(action.value);
    // Reuses ordinary infer()/reassignCompatibleType against a scope
    // containing ONLY page-local state - any other identifier fails as an
    // ordinary undefined name (E-SEM-001), for free.
    const stateScope = new Scope();
    for (const [name, type] of stateVars) stateScope.defineLocal(name, type);
    const exprType = this.infer(action.value, stateScope);
    const existingType = stateVars.get(action.name.name);
    stateVars.set(action.name.name, this.reassignCompatibleType(existingType, exprType, action.name.name, action.span));
  }

  // ADR-016 — validates a CALL API statement inside a click handler: the
  // method+route must match a real API declared somewhere in this file
  // (reusing `this.apiRoutes`, the exact map registerService/ADR-014
  // already builds), and every WITH payload field must be a valid
  // page-side value reference (isValidPageValueRef, shared with ordinary
  // page content). The payload's shape is deliberately NOT cross-checked
  // against the target handler's own REQUEST AS type here - see the ADR
  // for why that's an explicit, named boundary, not a gap: a mismatch
  // surfaces at runtime exactly like it would for any other client
  // (E-RUN-008/E-RUN-009), reaching this page as an ordinary failed
  // request.
  checkCallApiAction(action, stateVars, loopVarStack) {
    const key = `${action.method} ${action.route}`;
    if (!this.apiRoutes.has(key)) {
      const available = [...this.apiRoutes.keys()];
      err(
        CODES.CALL_API_UNKNOWN_ROUTE,
        `CALL API ${action.method} "${action.route}" doesn't match any API declared in this file.`,
        action.routeSpan,
        available.length > 0
          ? `Declared in this file: ${available.join(", ")}.`
          : "This file has no SERVICE/API declarations yet.",
        "Check the method and route spelling, or declare this API first."
      );
    }
    if (action.payload) {
      const seenFields = new Map();
      for (const field of action.payload.fields) {
        if (seenFields.has(field.name)) {
          err(
            CODES.DUPLICATE_FIELD,
            `"${field.name}" is already set in this CALL API's WITH payload.`,
            field.nameSpan,
            "A record literal cannot repeat a field name.",
            `Remove one of the two "${field.name}:" entries.`,
            [[seenFields.get(field.name), `"${field.name}" was first set here`]]
          );
        }
        seenFields.set(field.name, field.nameSpan);
        if (!this.isValidPageValueRef(field.value, loopVarStack, stateVars)) {
          err(
            CODES.CALL_API_PAYLOAD_NOT_STATIC,
            `This field must be a plain literal${this.pageValueHintText(loopVarStack, stateVars)} — CALL API's payload is built at compile time, not run.`,
            field.value.span
          );
        }
      }
    }
  }

  // ADR-013 — the sandboxing half of click-handler validation: no calls,
  // no SAVE/GET/ASK, no field/index access, no list/record literals.
  // Deliberately separate from infer() (which alone would happily accept
  // a call to any ordinary, safe-looking procedure) - this is the direct
  // countermeasure to the RPC-shaped hole this whole ADR exists to close.
  assertNoUnsafeConstructs(expr) {
    switch (expr.kind) {
      case "IntegerLiteral":
      case "DecimalLiteral":
      case "BooleanLiteral":
      case "Identifier":
        return;
      case "StringLiteral":
        if (expr.parts.some((p) => p.kind === "interp")) {
          err(CODES.CLICK_HANDLER_UNSAFE, "Interpolated strings are not allowed inside a click handler.", expr.span);
        }
        return;
      case "UnaryOp":
        this.assertNoUnsafeConstructs(expr.operand);
        return;
      case "BinaryOp":
        this.assertNoUnsafeConstructs(expr.left);
        this.assertNoUnsafeConstructs(expr.right);
        return;
      case "CallExpression":
        err(
          CODES.CLICK_HANDLER_UNSAFE,
          `Click handlers cannot call procedures ("${expr.callee.name}") - only literals, page-local state, and +-*/ ==!= <><= >= AND OR NOT are allowed.`,
          expr.span
        );
        return;
      case "SaveExpression":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use SAVE.", expr.span);
        return;
      case "GetExpression":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use GET.", expr.span);
        return;
      case "AskExpression":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use ASK.", expr.span);
        return;
      case "FieldAccess":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use .field access (page-local state is scalar).", expr.span);
        return;
      case "IndexAccess":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use [ ] indexing (page-local state is scalar).", expr.span);
        return;
      case "ListLiteral":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use list literals (page-local state is scalar).", expr.span);
        return;
      case "RecordLiteral":
        err(CODES.CLICK_HANDLER_UNSAFE, "Click handlers cannot use record literals (page-local state is scalar).", expr.span);
        return;
      default:
        err(CODES.CLICK_HANDLER_UNSAFE, "This is not allowed inside a click handler.", expr.span);
    }
  }

  // ADR-014 — the one restriction an API handler body has: no ASK,
  // anywhere in its own statements (not a deep call-graph check through
  // called procedures - see the ADR's "Known limitation"). ASK blocks on
  // real stdin (ADR-008); a live HTTP server has no per-request terminal,
  // so every request would hang forever. Deliberately narrower than
  // assertNoUnsafeConstructs (ADR-013): everything else - SAVE, GET,
  // DELETE, procedure calls - is genuine, unrestricted server-side code.
  assertNoAskInStatements(statements) {
    for (const stmt of statements) this.assertNoAskInStatement(stmt);
  }

  assertNoAskInStatement(stmt) {
    switch (stmt.kind) {
      case "ShowStatement":
        this.assertNoAskInExpr(stmt.value);
        return;
      case "SetStatement":
        this.assertNoAskInExpr(stmt.value);
        return;
      case "ChangeStatement":
        for (const idx of stmt.indexPath) this.assertNoAskInExpr(idx);
        this.assertNoAskInExpr(stmt.value);
        return;
      case "IfStatement":
        for (const branch of stmt.branches) {
          this.assertNoAskInExpr(branch.condition);
          this.assertNoAskInStatements(branch.body);
        }
        if (stmt.elseBranch) this.assertNoAskInStatements(stmt.elseBranch);
        return;
      case "ForEachStatement":
        this.assertNoAskInExpr(stmt.iterable);
        this.assertNoAskInStatements(stmt.body);
        return;
      case "RepeatStatement":
        this.assertNoAskInExpr(stmt.count);
        this.assertNoAskInStatements(stmt.body);
        return;
      case "ReturnStatement":
        if (stmt.value) this.assertNoAskInExpr(stmt.value);
        return;
      case "ExpressionStatement":
        this.assertNoAskInExpr(stmt.expression);
        return;
      case "TryStatement":
        this.assertNoAskInStatements(stmt.tryBody);
        this.assertNoAskInStatements(stmt.catchBody);
        return;
      case "DeleteStatement":
        this.assertNoAskInExpr(stmt.idExpression);
        return;
      default:
        return; // ProcedureDeclaration/DataDeclaration/PageDeclaration/ServiceDeclaration: not reachable here
    }
  }

  assertNoAskInExpr(expr) {
    switch (expr.kind) {
      case "AskExpression":
        err(
          CODES.API_HANDLER_ASK_NOT_ALLOWED,
          "ASK cannot be used inside an API handler - a server has no per-request interactive terminal to read from.",
          expr.span,
          "ASK blocks on real stdin; inside a request handler that would hang the server on every request against this endpoint.",
          "Remove ASK, or move this logic somewhere it's called from nova run instead."
        );
        return;
      case "UnaryOp":
        this.assertNoAskInExpr(expr.operand);
        return;
      case "BinaryOp":
        this.assertNoAskInExpr(expr.left);
        this.assertNoAskInExpr(expr.right);
        return;
      case "FieldAccess":
        this.assertNoAskInExpr(expr.target);
        return;
      case "IndexAccess":
        this.assertNoAskInExpr(expr.target);
        this.assertNoAskInExpr(expr.index);
        return;
      case "CallExpression":
        for (const arg of expr.arguments) this.assertNoAskInExpr(arg);
        return;
      case "ListLiteral":
        for (const el of expr.elements) this.assertNoAskInExpr(el);
        return;
      case "RecordLiteral":
        for (const f of expr.fields) this.assertNoAskInExpr(f.value);
        return;
      case "SaveExpression":
        this.assertNoAskInExpr(expr.value);
        return;
      default:
        return; // literals, identifiers, GetExpression - nothing to walk
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
    // ADR-012 — PAGE element validation (field access against real DATA
    // shapes) needs the DATA fields just resolved above, so it happens
    // last in phase 2, not during phase 1's registerPage.
    for (const [, page] of this.pages) {
      const stateVars = this.collectPageStateVars(page.elements); // ADR-013
      this.validatePageElements(page.elements, [], true, stateVars);
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

      case "PageDeclaration":
        // Already fully validated in registerPage (phase 1) - PAGE is
        // inert during `nova run`, exactly like DATA (ADR-011).
        return;

      case "ServiceDeclaration": {
        // A SERVICE nested inside IF/DO/FOR EACH/REPEAT/TRY parses fine
        // (parseStatement doesn't distinguish position) but registerService
        // (phase 1) only ever sees genuine top-level ones - collectApiRoutes
        // (src/apiserver/serve.js) walks program.statements the same way,
        // so a nested SERVICE would otherwise silently register no route
        // at all: `nova serve` boots clean and every request 404s, with no
        // signal at compile time about why. Reject it here instead, the
        // same "must be top level" treatment PAGE_TITLE_STYLE_NOT_TOP_LEVEL
        // already gives TITLE/STYLE/SET inside a PAGE-level FOR EACH.
        if (!this.topLevelServices.has(stmt)) {
          err(
            CODES.SERVICE_NOT_TOP_LEVEL,
            "SERVICE must be declared at the top level of a file, not nested inside IF/DO/FOR EACH/REPEAT/TRY.",
            stmt.span,
            "A SERVICE nested inside a conditional or procedure body would never be reachable by nova serve - only top-level SERVICE blocks are compiled into the server's routing table.",
            "Move this SERVICE block to the top level of the file."
          );
        }
        // ADR-014 — an API handler body reuses the exact same machinery a
        // DO procedure body already has: a child of global scope, RETURN
        // valid (insideProcedure: true), no declared return type so
        // definitelyReturns is not required (matches an undeclared-
        // RETURNS procedure exactly - falls through to NONE/null).
        for (const api of stmt.apis) {
          const apiScope = this.globalScope.child();
          // ADR-015 — tracks which API method's body is currently being
          // checked, so REQUEST (below, in infer()) can be statically
          // restricted to POST handlers only. A single instance field, not
          // threaded through infer()'s signature - restored afterward so
          // it's null again outside any API body (top level, DO procedures).
          this.currentApiMethod = api.method;
          try {
            this.checkStatements(api.body, apiScope, { insideProcedure: true, declaredReturnType: null });
            this.assertNoAskInStatements(api.body);
          } finally {
            this.currentApiMethod = null;
          }
        }
        return;
      }

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

      // ADR-016 — a CallApiStatement reached through ordinary statement
      // dispatch is, by construction, NOT inside a click handler: a
      // legitimate one is only ever visited via checkButtonAction, which
      // never calls checkStatement.
      case "CallApiStatement":
        err(
          CODES.CALL_API_OUTSIDE_CLICK_HANDLER,
          "CALL API can only be used inside a BUTTON's WHEN CLICKED block.",
          stmt.span,
          "CALL API compiles to a browser-side network request - it has no meaning in a script, procedure, or API handler body.",
          "Move this inside a BUTTON ... WHEN CLICKED ... END block."
        );
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

      case "RequestExpression": {
        // ADR-015 — REQUEST is only meaningful (and only ever populated)
        // inside a POST handler's own body - not a GET handler, not a
        // DO procedure another handler happens to call (ProcedureDeclaration
        // bodies are checked once, at their own declaration, never
        // re-entered from a call site, so this check is fully sound).
        if (this.currentApiMethod !== "POST") {
          err(
            CODES.REQUEST_OUTSIDE_POST_HANDLER,
            "REQUEST can only be used inside an API POST handler's body.",
            expr.span,
            "A GET handler has no request body, and REQUEST is not visible from a DO procedure another handler happens to call - only its own POST handler's body.",
            "Move this into an API POST ... END handler, or remove it."
          );
        }
        if (!this.dataTypes.has(expr.typeName)) {
          err(
            CODES.UNKNOWN_DATA_TYPE_IN_GET,
            `"${expr.typeName}" is not a DATA type.`,
            expr.typeNameSpan,
            null,
            `Declare it first with DATA ${expr.typeName} ... END, or check the spelling.`
          );
        }
        const dataType = this.dataTypes.get(expr.typeName);
        for (const field of dataType.fields) {
          if (!REQUEST_SCALAR_TYPES.has(field.type)) {
            err(
              CODES.REQUEST_TYPE_UNSUPPORTED_FIELD,
              `REQUEST AS ${expr.typeName} requires every field to be integer/decimal/text/boolean, but "${field.name}" is ${describeType(field.type)}.`,
              expr.typeNameSpan,
              "REQUEST does not support nested DATA/list/record fields yet.",
              null,
              [[dataType.node.name.span, `${expr.typeName} is declared here`]]
            );
          }
        }
        return expr.typeName;
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
