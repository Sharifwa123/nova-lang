# Sharif NOVA

Sharif NOVA (referred to as NOVA throughout this document) is an
independent programming language and toolchain developed by Sharif
Technologies, unrelated to other same-named "Nova"/"NovaLang" language
projects, editors, or products elsewhere in the industry.

NOVA is designed to read like natural, ordinary instructions to a computer
while remaining precise enough for a real compiler pipeline — one language
meant to eventually span core logic, data, UI, and APIs, instead of
stitching together a different language per layer.

This repository implements **v0.1 through v0.15**: v0.1–v0.12 is every
milestone in the language's core design roadmap — lexer → parser → AST →
semantic analyzer → tree-walking interpreter, covering the core language
(SHOW/SET/CHANGE/IF/FOR EACH/REPEAT/DO/RETURN), lists/records, typed
procedures, `DATA` named types, in-memory persistence (`SAVE`/`GET`/
`DELETE`), a small stdlib, `ASK` input, list indexing/mutation,
`TRY`/`CATCH` error handling, and a `PAGE` compiler (`nova build`)
spanning static HTML, data-bound content, and real client-side
interactivity (`BUTTON`/`WHEN CLICKED` compiled to JavaScript). v0.13
through v0.15 are the milestones past that original roadmap: `SERVICE`/
`API` compile to a real, live HTTP server (`nova serve`) sharing one
persistence store across every request, with `GET` (v0.13) and `POST` +
`REQUEST AS <DataType>` (v0.14) reading and validating a real JSON request
body; v0.15 connects `PAGE` and `SERVICE` for the first time — `nova
serve` now serves compiled `PAGE` HTML alongside the API, `BUTTON` works
inside `FOR EACH`, and a click handler can `CALL API` a declared endpoint
and reflect the real result, so backend, API, and frontend can genuinely
be written and run together from one file. Start with
[docs/LANGUAGE_GUIDE.md](docs/LANGUAGE_GUIDE.md) to learn the language and
write programs; see [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the
binding language specification, and [HANDOFF.md](HANDOFF.md) for project
history and what's next.

## Install

```bash
npm install -g nova-lang
nova run yourfile.nova
```

`nova-lang` can also be used as a library in a Node project
(`npm install nova-lang`):

```js
import { runSource } from "nova-lang";
runSource('SHOW "Hello, {name}"', "<source>", {}, { write: console.log });
```

No transitive dependencies either way — see [Development](#development)
below for why that's deliberate. Prefer working from a clone instead? See
[Try it](#try-it) and [Development](#development) — everything below
also works with `node src/cli.js ...` in place of `nova ...`, no install
required.

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
printf "Ada\n7\n" | node src/cli.js run examples/ask.nova
node src/cli.js run examples/list_indexing.nova
node src/cli.js run examples/error_handling.nova
node src/cli.js build examples/website.nova              # static PAGE
node src/cli.js build examples/data_bound_website.nova   # data-bound PAGE
node src/cli.js build examples/interactive_counter.nova  # interactive PAGE (real JS)
node src/cli.js serve examples/api_service.nova 3000      # live HTTP server (SERVICE/API)
# in another terminal:
#   curl http://localhost:3000/hello
#   curl http://localhost:3000/products
#   curl -X POST -d '{"name":"Sprocket","price":4.25}' http://localhost:3000/products

node src/cli.js serve examples/booking_page.nova 3000     # PAGE + SERVICE together
# open http://localhost:3000/ in a browser and click "Book Now" - it
# really calls the live API and books the room; confirm with:
#   curl http://localhost:3000/reservations
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
  stdlib/       built-in procedures (UPPER, LENGTH, ...)
  pagecompiler/ PAGE declarations -> static HTML (used by `nova build`)
  apiserver/    SERVICE/API declarations -> a live HTTP server (used by `nova serve`)
  cli.js        `nova run` / `nova build` / `nova serve <file>.nova [port]`
  nova.js       ties the pipeline together (compile / runSource)
docs/
  SPECIFICATION.md   the binding v0.1 language spec
  adr/               architectural decision records
examples/        runnable .nova programs (and examples/errors/ for diagnostics)
test/            zero-dependency unit tests + a real-CLI example runner
editors/vscode/  VS Code extension (syntax highlighting + Run/Build/Serve)
```

## Editor support

`editors/vscode/nova-lang/` is a VS Code extension: syntax highlighting for
`.nova` files, plus Run/Build/Serve wired into the editor's toolbar,
right-click menu, and Command Palette — not just a terminal command. See
[editors/vscode/nova-lang/README.md](editors/vscode/nova-lang/README.md)
for install instructions (no build step, zero dependencies).

## License

[MIT](LICENSE)
