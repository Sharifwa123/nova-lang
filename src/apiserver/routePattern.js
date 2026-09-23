// ADR-019 — path-parameter routing. A route segment of the form ":name"
// binds an integer path parameter (the only kind of id this language's
// SAVE has ever produced, ADR-006) - not a general string capture. This
// module is the single source of truth for what a route pattern means,
// shared by the analyzer (validating/extracting parameter names at
// compile time) and the server (matching a real request path against a
// declared route at request time) - the same "one source of truth, not
// two copies that can drift" precedent BUILTINS (ADR-007) already sets.
import { ALL_KEYWORDS } from "../lexer/token.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGER_SEGMENT_RE = /^-?\d+$/;

// "/products/:id" -> [{ kind: "static", value: "products" }, { kind: "param", name: "id" }]
export function parseRoutePattern(route) {
  return route
    .split("/")
    .filter((s) => s.length > 0)
    .map((seg) => (seg.startsWith(":") ? { kind: "param", name: seg.slice(1) } : { kind: "static", value: seg }));
}

export function isValidParamName(name) {
  return IDENTIFIER_RE.test(name) && !ALL_KEYWORDS.has(name);
}

export function routeHasParams(route) {
  return parseRoutePattern(route).some((seg) => seg.kind === "param");
}

// Every param segment collapsed to the same placeholder, so two routes
// that differ only in a parameter's NAME ("/x/:id" vs "/x/:pid") still
// produce the same key - they'd be genuinely ambiguous at request time.
export function routeShapeKey(pattern) {
  return pattern.map((seg) => (seg.kind === "param" ? ":" : seg.value)).join("/");
}

// Returns a plain { name: number } object of bindings if `pathname`
// matches `pattern`, or null if it doesn't (wrong segment count, a
// static segment mismatch, or a param segment that isn't an integer).
export function matchRoutePattern(pattern, pathname) {
  const pathSegments = pathname.split("/").filter((s) => s.length > 0);
  if (pathSegments.length !== pattern.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    const actual = pathSegments[i];
    if (seg.kind === "static") {
      if (seg.value !== actual) return null;
    } else {
      if (!INTEGER_SEGMENT_RE.test(actual)) return null;
      params[seg.name] = Number(actual);
    }
  }
  return params;
}
