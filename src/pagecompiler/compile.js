// ADR-011/ADR-012/ADR-013 — compiles PAGE declarations to static HTML,
// optionally data-bound (ADR-012) against an interpreter's populated
// SAVE/GET store, and optionally interactive (ADR-013) via page-local
// state and BUTTON/WHEN CLICKED, compiled to real client-side JavaScript.
// PAGE content is never *executed* server-side even when interactive — a
// click handler's safety was already fully checked by the analyzer
// (ADR-013's assertNoUnsafeConstructs); this module only translates the
// already-validated, restricted expression subset to JS text.
import { display } from "../interpreter/values.js";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Mirrors interpreter/values.js's display() semantics, but operates
// directly on a literal AST node - PAGE content is never wrapped in a
// runtime Value unless it came from the store (see resolvePageValue).
function literalText(expr) {
  switch (expr.kind) {
    case "BooleanLiteral":
      return expr.value ? "TRUE" : "FALSE";
    case "StringLiteral":
      return expr.parts.map((p) => p.value).join("");
    default:
      return String(expr.value);
  }
}

function literalJsValue(expr) {
  switch (expr.kind) {
    case "BooleanLiteral":
      return expr.value;
    case "StringLiteral":
      return expr.parts.map((p) => p.value).join("");
    default:
      return expr.value;
  }
}

// ADR-012 — resolves a page-element's value against `bindings` (loop
// variable name -> the record currently bound to it, a real runtime
// Value from the store). A literal needs no binding; a FieldAccess chain
// is walked against the bound record and displayed the same way SHOW
// would display it.
function resolvePageValue(expr, bindings) {
  if (expr.kind !== "FieldAccess") return literalText(expr);
  const fields = [];
  let root = expr;
  while (root.kind === "FieldAccess") {
    fields.unshift(root.field);
    root = root.target;
  }
  let value = bindings.get(root.name);
  for (const field of fields) value = value.value[field];
  return display(value);
}

// ADR-013 — translates one already-validated "safe" expression (literal,
// page-state reference, or +-*/ ==!= <><= >= AND OR NOT over those) to a
// JavaScript expression string. Only ever called on expressions
// assertNoUnsafeConstructs already accepted.
function compileExprToJs(expr) {
  switch (expr.kind) {
    case "IntegerLiteral":
    case "DecimalLiteral":
      return String(expr.value);
    case "BooleanLiteral":
      return expr.value ? "true" : "false";
    case "StringLiteral":
      return JSON.stringify(expr.parts.map((p) => p.value).join(""));
    case "Identifier":
      return `state.${expr.name}`;
    case "UnaryOp":
      return expr.operator === "NOT" ? `(!${compileExprToJs(expr.operand)})` : `(-${compileExprToJs(expr.operand)})`;
    case "BinaryOp": {
      const jsOp = { AND: "&&", OR: "||", "==": "===", "!=": "!==" }[expr.operator] ?? expr.operator;
      return `(${compileExprToJs(expr.left)} ${jsOp} ${compileExprToJs(expr.right)})`;
    }
    default:
      throw new Error(`Page compiler: unexpected expression kind '${expr.kind}' in a click handler`);
  }
}

// route "/" -> "index.html"; "/about" -> "about.html";
// "/products/list" -> "products/list.html".
export function routeToOutputPath(route) {
  const trimmed = route.replace(/^\/+/, "");
  return trimmed === "" ? "index.html" : `${trimmed}.html`;
}

export function compilePage(page, store = new Map()) {
  let title = null;
  const styles = [];
  const bodyParts = [];
  const initialState = {}; // name -> JS literal value
  const stateBoundElements = []; // { id, stateName }
  const buttons = []; // { fnName, actions: ChangeStatement[] }
  let nextElementId = 0;
  let nextButtonId = 0;

  function render(elements, bindings) {
    for (const el of elements) {
      if (el.kind === "FOR_EACH") {
        const collection = store.get(el.dataTypeName);
        const records = collection ? [...collection.records.values()] : [];
        for (const record of records) {
          const childBindings = new Map(bindings);
          childBindings.set(el.loopVar.name, record);
          render(el.body, childBindings);
        }
        continue;
      }

      if (el.kind === "SET") {
        initialState[el.name.name] = literalJsValue(el.value);
        continue;
      }

      if (el.kind === "BUTTON") {
        const fnName = `novaClick_${nextButtonId++}`;
        buttons.push({ fnName, actions: el.actions });
        const labelText = escapeHtml(resolvePageValue(el.label, bindings));
        bodyParts.push(`  <button onclick="${fnName}()">${labelText}</button>`);
        continue;
      }

      // TITLE/STYLE/HEADING/TEXT — a bare reference to page-local state
      // gets a DOM id so the click handlers can update it live; anything
      // else renders as plain static text, exactly as ADR-011/012.
      const isStateRef = el.value.kind === "Identifier" && el.value.name in initialState;
      const text = isStateRef ? String(initialState[el.value.name]) : resolvePageValue(el.value, bindings);

      switch (el.kind) {
        case "TITLE":
          title = text;
          break;
        case "STYLE":
          styles.push(text); // raw CSS - not HTML-escaped, it isn't HTML content
          break;
        case "HEADING":
        case "TEXT": {
          const tag = el.kind === "HEADING" ? "h1" : "p";
          if (isStateRef) {
            const id = `nova-el-${nextElementId++}`;
            stateBoundElements.push({ id, stateName: el.value.name });
            bodyParts.push(`  <${tag} id="${id}">${escapeHtml(text)}</${tag}>`);
          } else {
            bodyParts.push(`  <${tag}>${escapeHtml(text)}</${tag}>`);
          }
          break;
        }
        default:
          throw new Error(`Page compiler: unhandled element kind '${el.kind}'`);
      }
    }
  }

  render(page.elements, new Map());

  const scriptHtml = buildScript(initialState, stateBoundElements, buttons);

  const titleHtml = escapeHtml(title ?? page.route);
  const styleHtml = styles.length > 0 ? `\n  <style>${styles.join("\n")}</style>` : "";
  const html =
    `<!DOCTYPE html>\n` +
    `<html>\n<head>\n  <meta charset="utf-8">\n  <title>${titleHtml}</title>${styleHtml}\n</head>\n<body>\n` +
    bodyParts.join("\n") +
    `\n</body>${scriptHtml}\n</html>\n`;

  return { path: routeToOutputPath(page.route), html };
}

// ADR-013 — one <script> block: a `state` object, a `render()` that
// updates every state-bound element's textContent (never innerHTML - it
// cannot be interpreted as markup, so no escaping is needed here even
// though the initial server-rendered HTML above does need it), and one
// named function per BUTTON applying its CHANGEs then calling render().
function buildScript(initialState, stateBoundElements, buttons) {
  if (Object.keys(initialState).length === 0 && buttons.length === 0) return "";

  const lines = [];
  lines.push(`<script>`);
  lines.push(`var state = ${JSON.stringify(initialState)};`);
  lines.push(`function novaDisplay(v) { return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v); }`);
  lines.push(`function render() {`);
  for (const { id, stateName } of stateBoundElements) {
    lines.push(`  document.getElementById(${JSON.stringify(id)}).textContent = novaDisplay(state.${stateName});`);
  }
  lines.push(`}`);
  for (const { fnName, actions } of buttons) {
    lines.push(`function ${fnName}() {`);
    for (const action of actions) {
      lines.push(`  state.${action.name.name} = ${compileExprToJs(action.value)};`);
    }
    lines.push(`  render();`);
    lines.push(`}`);
  }
  lines.push(`render();`);
  lines.push(`</script>`);
  return "\n" + lines.join("\n");
}

// Returns [] if the program has no PAGE declarations. `store` is an
// interpreter's populated SAVE/GET collections (ADR-006); omit it to
// compile purely-static pages with any FOR EACH rendering zero records.
export function compileProgram(program, store = new Map()) {
  return program.statements
    .filter((stmt) => stmt.kind === "PageDeclaration")
    .map((page) => compilePage(page, store));
}
