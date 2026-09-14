// ADR-007 — the small standard library. Single source of truth for both
// the analyzer's static registration/checking and the interpreter's actual
// implementation, so the two can never drift out of sync.
import { makeInt, makeDec, makeText } from "../interpreter/values.js";
import { Diagnostic, NovaError } from "../diagnostics/diagnostic.js";
import { CODES } from "../diagnostics/codes.js";

function runtimeTypeError(message, span) {
  throw new NovaError(new Diagnostic({ code: CODES.BUILTIN_ARGUMENT_TYPE, message, primarySpan: span }));
}

function article(typeName) {
  return /^[aeiou]/.test(typeName) ? "an" : "a";
}

// `paramTypes: "unknown"` means the parameter has no single fixed NOVA
// type and is checked at the call instead (LENGTH/ROUND/ABS - see ADR-007
// for why a union/polymorphic annotation wasn't introduced just for these).
export const BUILTINS = [
  {
    name: "UPPER",
    paramNames: ["text"],
    paramTypes: ["text"],
    returnType: "text",
    impl: (args) => makeText(args[0].value.toUpperCase()),
  },
  {
    name: "LOWER",
    paramNames: ["text"],
    paramTypes: ["text"],
    returnType: "text",
    impl: (args) => makeText(args[0].value.toLowerCase()),
  },
  {
    name: "TRIM",
    paramNames: ["text"],
    paramTypes: ["text"],
    returnType: "text",
    impl: (args) => makeText(args[0].value.trim()),
  },
  {
    name: "LENGTH",
    paramNames: ["value"],
    paramTypes: ["unknown"],
    returnType: "integer",
    impl: (args, span) => {
      const v = args[0];
      if (v.type === "text" || v.type === "list") return makeInt(v.value.length);
      runtimeTypeError(`LENGTH requires text or a list, but this is ${article(v.type)} ${v.type} value.`, span);
    },
  },
  {
    name: "ROUND",
    paramNames: ["number"],
    paramTypes: ["unknown"],
    returnType: "integer",
    impl: (args, span) => {
      const v = args[0];
      if (v.type !== "integer" && v.type !== "decimal") {
        runtimeTypeError(`ROUND requires a number, but this is ${article(v.type)} ${v.type} value.`, span);
      }
      return makeInt(Math.round(v.value));
    },
  },
  {
    name: "ABS",
    paramNames: ["number"],
    paramTypes: ["unknown"],
    returnType: "decimal",
    impl: (args, span) => {
      const v = args[0];
      if (v.type !== "integer" && v.type !== "decimal") {
        runtimeTypeError(`ABS requires a number, but this is ${article(v.type)} ${v.type} value.`, span);
      }
      return makeDec(Math.abs(v.value));
    },
  },
];
