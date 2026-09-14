// Runtime value model — see docs/SPECIFICATION.md §3 and §14.
// Every NOVA runtime value is a small tagged object: { type, value }.
// `type` is one of: integer, decimal, text, boolean, list, record, none.

export const NONE = Object.freeze({ type: "none", value: null });

export const makeInt = (n) => ({ type: "integer", value: n });
export const makeDec = (n) => ({ type: "decimal", value: n });
export const makeText = (s) => ({ type: "text", value: s });
export const makeBool = (b) => ({ type: "boolean", value: b });
export const makeList = (items) => ({ type: "list", value: items });
// `fields` is a plain JS object mapping field name -> NOVA value.
export const makeRecord = (fields) => ({ type: "record", value: fields });

export function isNumeric(v) {
  return v.type === "integer" || v.type === "decimal";
}

// §3 — integer -> decimal widening in mixed arithmetic, no other coercion.
export function resultNumericType(a, b) {
  return a.type === "decimal" || b.type === "decimal" ? "decimal" : "integer";
}

// §14 — display() per type.
export function display(v) {
  switch (v.type) {
    case "integer":
      return String(v.value);
    case "decimal": {
      // Minimal representation (trailing-zero policy deferred, §14).
      const s = String(v.value);
      return s;
    }
    case "text":
      return v.value;
    case "boolean":
      return v.value ? "TRUE" : "FALSE";
    case "list":
      return "[" + v.value.map(display).join(", ") + "]";
    case "record":
      return (
        "{ " +
        Object.entries(v.value)
          .map(([k, val]) => `${k}: ${display(val)}`)
          .join(", ") +
        " }"
      );
    case "none":
      return "NONE";
    default:
      return String(v.value);
  }
}

// ADR-003 - structural equality for records, matching the list behavior
// already established in v0.1: two records are equal iff they have the
// same field names and every field's value is (recursively) equal.
export function valuesEqual(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "list") {
    return (
      a.value.length === b.value.length &&
      a.value.every((item, i) => valuesEqual(item, b.value[i]))
    );
  }
  if (a.type === "record") {
    const aKeys = Object.keys(a.value);
    const bKeys = Object.keys(b.value);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => Object.prototype.hasOwnProperty.call(b.value, k) && valuesEqual(a.value[k], b.value[k]))
    );
  }
  return a.value === b.value;
}

export function typeName(v) {
  return v.type;
}
