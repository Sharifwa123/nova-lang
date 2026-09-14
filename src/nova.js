// Pipeline entry point — see docs/SPECIFICATION.md §17's implementation
// contract: Source -> Lexer -> Tokens -> Parser -> AST -> Semantic Analysis
// -> Interpreter. No stage is skipped or short-circuited.
import { Lexer } from "./lexer/lexer.js";
import { parse } from "./parser/parser.js";
import { analyze } from "./analyzer/analyzer.js";
import { Interpreter } from "./interpreter/interpreter.js";

// Lexes, parses, and semantically validates `source`. Returns the AST.
// Throws NovaError on any lexical, syntactic, or semantic error.
export function compile(source, filename = "<source>", hostGlobals = {}) {
  const tokens = new Lexer(source, filename).tokenize();
  const program = parse(tokens, source, filename);
  const hostTypes = {};
  for (const [name, value] of Object.entries(hostGlobals)) {
    hostTypes[name] = value.type;
  }
  analyze(program, hostTypes);
  return program;
}

// Compiles and runs `source`. `options` are passed straight through to the
// Interpreter: `write` receives one string per SHOW, `writePrompt` receives
// an ASK prompt (no trailing newline), `input` is a canned list of lines
// for ASK (omit to read real stdin, on demand - see ADR-008).
export function runSource(source, filename = "<source>", hostGlobals = {}, options = {}) {
  const program = compile(source, filename, hostGlobals);
  const interpreter = new Interpreter(program, hostGlobals, options);
  interpreter.run();
  return interpreter;
}
