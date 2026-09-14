// ADR-011 — compiles PAGE declarations to static HTML. Pure functions
// from a validated Program AST to { path, html } outputs; this module
// never touches the interpreter — PAGE content is never executed, only
// compiled, by design (see the ADR for why that's a deliberate choice,
// not a missing feature).

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Mirrors interpreter/values.js's display() semantics, but operates
// directly on a literal AST node - PAGE content is never wrapped in a
// runtime Value, since it's never evaluated (only known-static already).
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

// route "/" -> "index.html"; "/about" -> "about.html";
// "/products/list" -> "products/list.html".
export function routeToOutputPath(route) {
  const trimmed = route.replace(/^\/+/, "");
  return trimmed === "" ? "index.html" : `${trimmed}.html`;
}

export function compilePage(page) {
  let title = null;
  const styles = [];
  const bodyParts = [];

  for (const el of page.elements) {
    const text = literalText(el.value);
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

  const titleHtml = escapeHtml(title ?? page.route);
  const styleHtml = styles.length > 0 ? `\n  <style>${styles.join("\n")}</style>` : "";
  const html =
    `<!DOCTYPE html>\n` +
    `<html>\n<head>\n  <meta charset="utf-8">\n  <title>${titleHtml}</title>${styleHtml}\n</head>\n<body>\n` +
    bodyParts.join("\n") +
    `\n</body>\n</html>\n`;

  return { path: routeToOutputPath(page.route), html };
}

// Returns [] if the program has no PAGE declarations.
export function compileProgram(program) {
  return program.statements
    .filter((stmt) => stmt.kind === "PageDeclaration")
    .map(compilePage);
}
