// ADR-011/ADR-012 — compiles PAGE declarations to static HTML. Takes a
// validated Program AST plus (optionally) an interpreter's populated
// SAVE/GET store (ADR-006), so FOR EACH...IN GET can render real records.
// PAGE content is never *executed* even when data-bound — a page-element's
// value is always either a literal or a field lookup on an already-fetched
// record (see the ADR for why that boundary matters).
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

      const text = resolvePageValue(el.value, bindings);
      switch (el.kind) {
        case "TITLE":
          title = text;
          break;
        case "STYLE":
          styles.push(text); // raw CSS - not HTML-escaped, it isn't HTML content
          break;
        case "HEADING":
          bodyParts.push(`  <h1>${escapeHtml(text)}</h1>`);
          break;
        case "TEXT":
          bodyParts.push(`  <p>${escapeHtml(text)}</p>`);
          break;
        default:
          throw new Error(`Page compiler: unhandled element kind '${el.kind}'`);
      }
    }
  }

  render(page.elements, new Map());

  const titleHtml = escapeHtml(title ?? page.route);
  const styleHtml = styles.length > 0 ? `\n  <style>${styles.join("\n")}</style>` : "";
  const html =
    `<!DOCTYPE html>\n` +
    `<html>\n<head>\n  <meta charset="utf-8">\n  <title>${titleHtml}</title>${styleHtml}\n</head>\n<body>\n` +
    bodyParts.join("\n") +
    `\n</body>\n</html>\n`;

  return { path: routeToOutputPath(page.route), html };
}

// Returns [] if the program has no PAGE declarations. `store` is an
// interpreter's populated SAVE/GET collections (ADR-006); omit it to
// compile purely-static pages with any FOR EACH rendering zero records.
export function compileProgram(program, store = new Map()) {
  return program.statements
    .filter((stmt) => stmt.kind === "PageDeclaration")
    .map((page) => compilePage(page, store));
}
