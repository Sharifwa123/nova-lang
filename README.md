# NOVA

NOVA is a programming language designed to read like natural, ordinary
instructions to a computer while remaining precise enough for a real
compiler pipeline — one language meant to eventually span core logic, data,
UI, and APIs, instead of stitching together a different language per layer.

This repository is the **v0.1 core**: lexer → parser → AST → semantic
analyzer → tree-walking interpreter, for the SHOW/SET/CHANGE/IF/FOR
EACH/REPEAT/DO/RETURN surface. See [HANDOFF.md](HANDOFF.md) for how this
repo came to exist and what's next, and
[docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the binding language
specification.

## Try it

```bash
node src/cli.js run examples/hello.nova
node src/cli.js run examples/if_else.nova
node src/cli.js run examples/accumulation.nova
node src/cli.js run examples/catalog.nova
node src/cli.js run examples/typed_procedures.nova
node src/cli.js run examples/data_types.nova
node src/cli.js run examples/persistence.nova
node src/cli.js run examples/stdlib.nova
```

```nova
SET name = "World"
SHOW "Hello {name}"

SET age = 18
IF age >= 18
    SHOW "Adult"
ELSE
    SHOW "Minor"
END
```

## Development

No npm dependencies are required — see HANDOFF.md for why. Node.js 18+ is
the only requirement.

```bash
node test/run.js            # unit tests (lexer/parser/analyzer/interpreter)
node test/run-examples.js   # runs every examples/*.nova through the real CLI
```

## Layout

```
src/
  lexer/        source text -> tokens
  parser/       tokens -> AST (recursive descent)
  ast/          AST node shapes
  analyzer/     static scope + type checking (one pass, before any execution)
  interpreter/  tree-walking evaluator over the validated AST
  diagnostics/  the WHAT/WHERE/WHY/HOW error model, shared by every stage
  cli.js        `nova run <file>.nova`
  nova.js       ties the pipeline together (compile / runSource)
docs/
  SPECIFICATION.md   the binding v0.1 language spec
  adr/               architectural decision records
  reference/         the original design chat, kept for provenance
examples/        runnable .nova programs (and examples/errors/ for diagnostics)
test/            zero-dependency unit tests + a real-CLI example runner
```
