# The Sharif NOVA Language Guide

Sharif NOVA (also referred to as NOVA in this guide) is an independent
programming language and toolchain developed by Sharif Technologies. It is
unrelated to other, same-named "Nova"/"NovaLang" language projects, editors,
or products from other developers or companies elsewhere in the industry.

This is a complete, self-contained guide to writing programs in Sharif NOVA
— from your first `SHOW "Hello"` through typed procedures, persistent data,
and compiling a program into a live website or HTTP service. It assumes no
prior knowledge of the language and doesn't assume you've read anything else
in this repository first.

If you want the precise, binding grammar instead of a guided tour, see
[SPECIFICATION.md](SPECIFICATION.md). This guide and the specification
describe the same language; this one is written to teach it, not to define
it.

## Contents

1. [What NOVA is](#1-what-nova-is)
2. [Install and run your first program](#2-install-and-run-your-first-program)
3. [The shape of a NOVA file](#3-the-shape-of-a-nova-file)
4. [Types and literals](#4-types-and-literals)
5. [Variables: SET and CHANGE](#5-variables-set-and-change)
6. [Expressions and operators](#6-expressions-and-operators)
7. [Text and string interpolation](#7-text-and-string-interpolation)
8. [Control flow](#8-control-flow)
9. [Lists](#9-lists)
10. [Records](#10-records)
11. [Procedures: DO / INPUT / RETURN](#11-procedures-do--input--return)
12. [DATA: named types](#12-data-named-types)
13. [Persistence: SAVE / GET / DELETE](#13-persistence-save--get--delete)
14. [The standard library](#14-the-standard-library)
15. [ASK: reading input](#15-ask-reading-input)
16. [TRY / CATCH: handling errors](#16-try--catch-handling-errors)
17. [PAGE: building a website](#17-page-building-a-website)
18. [SERVICE / API: a live HTTP server](#18-service--api-a-live-http-server)
19. [The command line](#19-the-command-line)
20. [Scope rules, in one place](#20-scope-rules-in-one-place)
21. [Type rules, in one place](#21-type-rules-in-one-place)
22. [Keyword reference](#22-keyword-reference)
23. [Diagnostic code reference](#23-diagnostic-code-reference)

---

## 1. What NOVA is

Sharif NOVA is a programming language whose statements read close to ordinary
sentences (`SET price = 9.99`, `SHOW "Hello, {name}"`, `FOR EACH item IN
cart`) while still compiling through a real, strict pipeline: a lexer, a
parser, a static semantic analyzer, and an interpreter. Nothing about NOVA
is guessed or pattern-matched at runtime — every program is fully checked
before the first line of it runs.

A single `.nova` file can hold ordinary script logic, structured data
(`DATA`), a persistent store (`SAVE`/`GET`/`DELETE`), a compiled webpage
(`PAGE`), and a live HTTP API (`SERVICE`) all at once. Which parts of the
file actually run depends on which command you invoke — see
[§19](#19-the-command-line).

A `.nova` file is plain UTF-8 text, exactly like a `.py` or `.js` file —
there's no special editor or format behind it. You can write one in any
text editor and save it with a `.nova` extension.

## 2. Install and run your first program

```bash
npm install -g nova-lang
```

This installs the `nova` command. Create a file named `hello.nova`:

```nova
SET name = "World"
SHOW "Hello, {name}!"
```

Run it:

```bash
nova run hello.nova
```

```
Hello, World!
```

That's the whole cycle: write a `.nova` file, run it with `nova run`. The
rest of this guide covers everything you can put inside that file.

## 3. The shape of a NOVA file

A NOVA file is a sequence of top-level statements, executed top to bottom.
There's no required wrapper — no `main` function, no imports, no module
header. The file *is* the program.

```nova
SHOW "This runs first."
SHOW "Then this."
```

**Statements end at the newline.** There are no semicolons.

```nova
SET total = 0        # one statement per line
SHOW total
```

**Comments** start with `#` and run to the end of the line. There are no
block comments.

```nova
# This whole line is a comment.
SHOW "code"   # this trailing part is a comment too
```

**Blocks are closed with `END`**, not indentation. Indentation is for
readability only — NOVA doesn't parse whitespace as structure. Every
construct that opens a block (`IF`, `FOR EACH`, `REPEAT`, `DO`, `DATA`,
`TRY`, `PAGE`, `SERVICE`, `API`) is closed by a matching `END`.

```nova
IF total > 100
    SHOW "big order"
END
```

**Keywords are uppercase and case-sensitive.** `IF` is a keyword; `if` and
`If` are ordinary identifiers, not the keyword. This isn't a style
preference — the language only recognizes the uppercase spelling.

## 4. Types and literals

NOVA has four primitive types:

| Type | Example literal | Notes |
|---|---|---|
| `integer` | `42` | whole numbers |
| `decimal` | `3.14` | must have digits on both sides of the `.` |
| `text` | `"hello"` | double-quoted only |
| `boolean` | `TRUE` / `FALSE` | keyword literals |

Plus two structural types you build out of these: `list` (§9) and `record`
(§10), and named shapes built from records called `DATA` types (§12).

There are no negative number literals — `-5` is the unary `-` operator
applied to `5`, which behaves the same way in practice.

**Numbers mix freely.** An `integer` is automatically usable wherever a
`decimal` is expected, in both directions — `5 + 2.5` is `7.5`, and a
variable that's held an `integer` can later be reassigned a `decimal` (its
tracked type just becomes `decimal` from then on).

**Nothing else converts automatically.** `text` and `boolean` never
silently convert to or from numbers or to each other. `"5" + 5` is a type
error, not string concatenation or coercion — if a comparison or operation
mixes incompatible types, NOVA rejects the whole program before it runs,
rather than guessing what you meant.

## 5. Variables: SET and CHANGE

NOVA has two different keywords for touching a variable, and they do
opposite things. This is the single most important rule to internalize
early, because it's used everywhere — ordinary variables, list elements,
and page-local state in a compiled website all follow it.

**`SET` declares (or re-declares) a name in the *current* scope:**

```nova
SET count = 0
```

If `count` isn't already bound in this scope, `SET` creates it. If it
already exists in the *same* scope, `SET` (well, ordinarily you'd use
`CHANGE` for that — see below) still just reassigns it, as long as the new
value's type is compatible (numbers freely mix; anything else must match).

**`CHANGE` mutates a binding that already exists, wherever it lives:**

```nova
CHANGE count = count + 1
```

`CHANGE` walks outward from the current scope to find where `count` is
already bound and mutates it there. It never creates a new binding —
`CHANGE`-ing a name that was never `SET` anywhere is an error.

This split is what makes accumulation across a loop work correctly:

```nova
SET total = 0
FOR EACH price IN prices
    CHANGE total = total + price
END
SHOW total
```

Inside the loop, `SET total = ...` would create a *new*, loop-scoped
`total` that vanishes every iteration and never affects the outer one.
`CHANGE total = ...` reaches out to the `total` declared before the loop
and updates it in place — which is what you actually want.

**Rule of thumb:** use `SET` the first time you introduce a name in a
scope; use `CHANGE` every time after that, in this scope or a nested one.

## 6. Expressions and operators

```nova
SHOW 2 + 3 * 4        # 14 - normal precedence
SHOW (2 + 3) * 4      # 20 - parentheses override it
```

Arithmetic: `+ - * /`. Comparison: `< > <= >=`. Equality: `== !=`.
Logical: `AND`, `OR`, `NOT` (words, not `&&`/`||`/`!`).

Precedence, highest to lowest: field/index access, unary `-`/`NOT`,
`* /`, `+ -`, comparisons, `== !=`, `AND`, `OR`.

Comparisons don't chain: `a < b < c` is a parse error, not shorthand for
`a < b AND b < c` — write the `AND` out explicitly.

`==`/`!=` require both sides to already be the same type; comparing a
`text` to an `integer`, for instance, is rejected rather than silently
returning `FALSE`.

Two lists are `==` iff they have the same elements in the same order,
recursively. Two records are `==` iff they have the same field names and
every field's value is `==`, recursively.

## 7. Text and string interpolation

```nova
SET name = "Ada"
SHOW "Hello, {name}!"
```

`{name}` inside a string literal is replaced with that variable's value.
You can go one level into a field with a dot:

```nova
SHOW "{order.total} due"
```

Interpolation only accepts a bare name or one `name.field` — it does not
accept arbitrary expressions. `"{price * quantity}"` is not valid; compute
the value in a variable first, then interpolate the variable:

```nova
SET lineTotal = price * quantity
SHOW "Line total: {lineTotal}"
```

Escape sequences inside strings: `\"`, `\\`, `\n`, `\t`. Any other
backslash sequence is a lexical error rather than being passed through.

A literal `{` that isn't the start of real interpolation (for example,
CSS inside a `STYLE` string — see §17) is just treated as ordinary text.

## 8. Control flow

### IF / ELSE IF / ELSE

```nova
SET age = 20

IF age < 13
    SHOW "child"
ELSE IF age < 20
    SHOW "teen"
ELSE IF age < 65
    SHOW "adult"
ELSE
    SHOW "senior"
END
```

Any number of `ELSE IF` branches is allowed. `ELSE` (if present) must come
last. Branches are checked top to bottom; the first one whose condition is
`TRUE` runs, and the rest are skipped.

### FOR EACH

```nova
SET items = ["apple", "banana", "cherry"]
FOR EACH item IN items
    SHOW item
END
```

`item` is a fresh binding on every iteration — mutating it in one
iteration never affects the next one starting. The list being iterated is
evaluated once, before the loop starts.

### REPEAT

```nova
REPEAT 3 TIMES
    SHOW "Hi!"
END
```

The count must be an `integer`. A count of zero or less simply runs the
body zero times — it's not an error.

## 9. Lists

There's no list literal type annotation — a list can hold values of mixed
types, since NOVA doesn't yet track element types.

```nova
SET numbers = [1, 2, 3]
SET mixed = [1, "two", TRUE]
SET empty = []
```

**Indexing** is zero-based:

```nova
SET fruits = ["apple", "banana", "cherry"]
SHOW fruits[0]     # apple
SHOW fruits[2]     # cherry
```

Reading or writing past the end (or a negative index) is a runtime error —
there's no negative "from the end" indexing.

**Mutating an element** uses `CHANGE`, following the same SET-declares /
CHANGE-mutates split from §5 — an existing element is something that
already exists, so it's always `CHANGE`, never `SET`:

```nova
CHANGE fruits[1] = "blueberry"
```

Indexing chains and nests freely:

```nova
SET grid = [[1, 2, 3], [4, 5, 6]]
SHOW grid[1][2]        # 6
CHANGE grid[0][0] = 100
```

**Lists are reference types.** Assigning a list to another name, or
passing it into a procedure, shares the same underlying storage —
mutating through one name is visible through every other name pointing at
the same list:

```nova
SET original = [1, 2, 3]
SET alias = original
CHANGE alias[0] = 99
SHOW original[0]        # 99 - same underlying list
```

## 10. Records

A record is an unordered bag of named fields:

```nova
SET point = { x: 3, y: 4 }
SHOW point.x
SHOW point.y
```

A repeated field name in one record literal is rejected — there's no
"last one wins" behavior to hide a mistake.

Records combine naturally with lists:

```nova
SET catalog = [
    { name: "Widget", price: 9.99 },
    { name: "Gadget", price: 19.99 }
]

FOR EACH product IN catalog
    SHOW "{product.name}: {product.price}"
END
```

Field access and indexing both follow *any* expression, not just a bare
variable — `makePoint().x`, `{ x: 1 }.x`, and `list[0].name` are all valid.

## 11. Procedures: DO / INPUT / RETURN

```nova
DO greet
    INPUT name
    SHOW "Hello, {name}!"
END

greet("Ada")
```

`INPUT` declarations must be the first thing(s) in the body, one per
parameter, in the order arguments are passed — NOVA has no named or
keyword arguments.

**Add types** to get real checking, both at the call site and inside the
body:

```nova
DO add RETURNS integer
    INPUT a: integer
    INPUT b: integer
    RETURN a + b
END

SHOW add(2, 3)      # 5
```

Valid type names: `integer`, `decimal`, `text`, `boolean`, `list`,
`record`, or any `DATA` type name you've declared (§12).

When a procedure declares `RETURNS`, every `RETURN` in its body must
produce a compatible value, and the compiler checks that the procedure
**always** returns on every possible path — an `IF` without an `ELSE`, for
instance, doesn't count as "always returns," because there's a path
through it that returns nothing. A loop body never counts either, since a
loop can run zero times.

Leaving off `RETURNS` (and leaving parameters untyped) is completely
valid — you get back v0.1-style, fully permissive behavior. Types in NOVA
are opt-in, not mandatory.

**A procedure that never hits `RETURN`** simply falls off the end and
produces the internal empty value (`NONE`) — this is not an error unless
the procedure declared a `RETURNS` type.

**Recursion** works normally:

```nova
DO factorial RETURNS integer
    INPUT n: integer
    IF n <= 1
        RETURN 1
    END
    RETURN n * factorial(n - 1)
END

SHOW factorial(5)     # 120
```

Procedures are **not closures** over whatever called them — a procedure's
body only ever sees its own parameters plus top-level (global) variables,
never a caller's local variables. This is deliberate, define-site
("lexical") scoping.

## 12. DATA: named types

`DATA` gives a record shape a name, which unlocks static checking of its
fields wherever that name is used directly:

```nova
DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT p: decimal
    RETURN { name: n, price: p }
END

SET widget = makeProduct("Widget", 9.99)
SHOW widget.name
```

When a record literal is checked directly against a specific `DATA` type
(as `makeProduct`'s `RETURN` is checked against `Product` here), it must
match **exactly**: every declared field present, no extra fields, and
every field's value type-compatible. This is what catches a typo in a
field name at compile time instead of producing a silently wrong record.

A `DATA` type can reference itself or other `DATA` types as field types
(useful for things like a linked list or a tree), and declaration order
doesn't matter — a `DATA` type can reference one declared later in the
file.

`DATA` names and procedure names live in separate namespaces, so `DATA
Product` and `DO Product` can coexist without conflict.

## 13. Persistence: SAVE / GET / DELETE

NOVA keeps one in-memory collection per `DATA` type, alive for as long as
the program (or server — see §18) is running.

```nova
DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT p: decimal
    RETURN { name: n, price: p }
END

SET id1 = SAVE makeProduct("Widget", 9.99)
SET id2 = SAVE makeProduct("Gadget", 19.99)

FOR EACH product IN GET Product
    SHOW "{product.name}: {product.price}"
END

DELETE Product id2
```

- `SAVE <value>` requires a value whose *specific* `DATA` type is known
  statically (a plain, untyped record literal doesn't qualify on its own —
  route it through a typed procedure or variable first, as above). It
  returns a fresh `integer` id, starting at 1 per type, that you can use
  with `DELETE`.
- `GET TypeName` returns every currently-saved record of that type, as a
  `list`, oldest first. There's no filtering yet — if you need a subset,
  filter after fetching, using ordinary `FOR EACH`/`IF`.
- `DELETE TypeName id` removes that record. Deleting an id that's already
  gone (or never existed) is a silent no-op, not an error.

## 14. The standard library

Six built-in procedures, called exactly like any `DO` procedure:

| Name | Signature | Behavior |
|---|---|---|
| `UPPER(text)` | → `text` | uppercase |
| `LOWER(text)` | → `text` | lowercase |
| `TRIM(text)` | → `text` | strip leading/trailing whitespace |
| `LENGTH(x)` | → `integer` | length of a `text` or `list` |
| `ROUND(x)` | → `integer` | nearest integer to a number |
| `ABS(x)` | → `decimal` | absolute value of a number |

```nova
SHOW UPPER("hello")            # HELLO
SHOW LENGTH([1, 2, 3, 4])       # 4
SHOW ROUND(3.7)                 # 4
SHOW ABS(-9.5)                  # 9.5
```

`LENGTH`/`ROUND`/`ABS` accept either `text`/numbers as appropriate and are
checked when they're called; passing an unsupported type is a runtime
error.

Because built-ins share the ordinary procedure namespace, declaring your
own `DO UPPER ... END` collides with the built-in the same way redeclaring
any procedure would — it isn't silently shadowed.

## 15. ASK: reading input

```nova
SET name = ASK "What's your name? "
SHOW "Hello, {name}!"
```

`ASK <expr>` prints `expr` as a prompt (no trailing newline), then blocks
for one line of real input from the terminal, returned as `text`. Input is
only read when `ASK` actually executes — a program that never calls `ASK`
never touches the terminal's input at all.

`ASK` always returns `text`, even if the user types a number — there's no
built-in string-to-number parser yet, so using the result arithmetically
without converting it first will hit an ordinary type error.

Calling `ASK` after input has run out (for example, piping a file with
fewer lines than `ASK` calls) is a runtime error.

## 16. TRY / CATCH: handling errors

```nova
DO safeDivide RETURNS decimal
    INPUT a: decimal
    INPUT b: decimal

    TRY
        RETURN a / b
    CATCH error
        SHOW "Division failed: {error}"
        RETURN 0
    END
END

SHOW safeDivide(10, 2)    # 5
SHOW safeDivide(10, 0)    # Division failed: ... / 0
```

`TRY`/`CATCH` only ever catches **runtime** errors — things like division
by zero or an out-of-bounds list index. A program with a lexical, parse,
or semantic-analysis error is rejected before anything runs at all, so
there's no such error left for `TRY` to catch. `CATCH error` binds `error`
to the failure's message as plain `text`.

## 17. PAGE: building a website

A `PAGE` declaration describes a webpage. It's inert while the file runs
normally (`nova run` never touches it) — it's compiled to real HTML by a
separate command, `nova build`:

```nova
PAGE "/"
    TITLE "My Site"
    STYLE "body { font-family: sans-serif; max-width: 40em; margin: 3em auto; }"
    HEADING "Welcome"
    TEXT "This page was compiled by NOVA."
END
```

```bash
nova build mysite.nova
```

This writes `dist/index.html` next to the source file. The route string
(`"/"` here) determines the output path: `/` → `dist/index.html`,
`/about` → `dist/about.html`, `/products/list` →
`dist/products/list.html`. A file can declare as many `PAGE`s as it wants,
as long as every route is unique.

`TITLE` sets the page `<title>` (at most one per page). `STYLE` supplies
raw CSS (any number, concatenated into one stylesheet). `HEADING` and
`TEXT` add an `<h1>` and a `<p>` respectively, and can repeat, rendering
in the order you write them.

### Data-bound pages

Content inside a `PAGE` can loop over data you've `SAVE`d earlier in the
same file, using the same `FOR EACH ... IN GET ...` shape you'd use in
ordinary code:

```nova
DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT p: decimal
    RETURN { name: n, price: p }
END

SAVE makeProduct("Widget", 9.99)
SAVE makeProduct("Gadget", 19.99)

PAGE "/catalog"
    TITLE "Catalog"
    HEADING "Our Products"
    FOR EACH product IN GET Product
        HEADING product.name
        TEXT product.price
    END
END
```

`nova build` runs the file's ordinary top-level statements once, silently
(so the `SAVE` calls above actually populate the store), and *then*
compiles the `PAGE` content against that data. The resulting HTML reflects
whatever was saved as of build time — it's a snapshot, not a live view
(for a live view, see §18).

Inside a `FOR EACH` in a `PAGE`, content can be a literal or a
`loopVariable.field` reference — nothing more elaborate. `TITLE`/`STYLE`
can only appear at a page's top level, never inside a loop.

### Interactive pages

`SET`, `BUTTON`, and `WHEN CLICKED` add real, in-browser interactivity,
compiled to plain JavaScript — no separate script to write:

```nova
PAGE "/counter"
    TITLE "Counter"

    SET count = 0

    HEADING count

    BUTTON "+1"
        WHEN CLICKED
            CHANGE count = count + 1
        END
    END
    BUTTON "Reset"
        WHEN CLICKED
            CHANGE count = 0
        END
    END
END
```

A `SET` directly inside a `PAGE` declares **page-local state** — a value
that lives in the visitor's browser, not on any server. `BUTTON <label>`
renders a button; its `WHEN CLICKED` block runs when a visitor actually
clicks it.

Click handlers are intentionally restricted: every statement inside one
must be a `CHANGE` to page-local state or a `CALL API` (below), and a
`CHANGE`'s right-hand side must be a "safe" expression — literals, other
page-local state, and the ordinary operators combining them. Calls,
`SAVE`/`GET`/`ASK`, field/index access, and list/record literals aren't
allowed inside a click handler. This isn't an arbitrary restriction — a
click handler runs as real JavaScript in a stranger's browser, and NOVA
keeps that surface deliberately small and checkable rather than letting
arbitrary server-style code run there.

### Calling a live API from a page

A `BUTTON` can appear inside a `FOR EACH` too — one button per rendered
record — and its click handler can reach a real `SERVICE`/`API` endpoint
with `CALL API`:

```nova
PAGE "/"
    HEADING "Available Rooms"
    FOR EACH room IN GET Room
        HEADING room.roomType
        TEXT room.pricePerNight
        BUTTON "Book Now"
            WHEN CLICKED
                CALL API POST "/reservations" WITH { roomNumber: room.number }
            END
        END
    END
END

SERVICE
    API POST "/reservations"
        SET r = REQUEST AS Reservation
        SAVE r
        RETURN r
    END
END
```

`CALL API GET|POST "<route>"` optionally takes `WITH { field: value, ... }`
— a payload sent as the request's JSON body. Each field's value follows
the same rule any other page content does: a literal, page-local state, or
a field of the enclosing `FOR EACH`'s loop variable (`room.number` above —
resolved to the *specific* room's number when that specific button is
compiled, so each rendered room's button books the right room). The
method+route must match a real `API` declared somewhere in the same file
— a typo or an undeclared route is caught at compile time, not left to
fail silently in the browser.

On click, the button disables itself, sends the request, and shows
`"Done"` on success or `"Failed - try again"` (and re-enables) if the
request fails — there's no syntax yet for a custom success/failure
message. **This only works on a page actually served by `nova serve`**
(see below) — `nova build`'s static HTML has no live server for the
request to reach.

### Collecting real user input with FORM

Everything so far sends data the page already knew at build time — a room
from a loop, or fixed page state. `FORM`/`INPUT` let a visitor type
something in and have *that* reach the server:

```nova
PAGE "/"
    FORM
        INPUT author: text "Your name"
        INPUT body: text "Message"
        BUTTON "Post"
            WHEN CLICKED
                CALL API POST "/messages" WITH { author: author, body: body }
            END
        END
    END
END
```

`INPUT <name>: <type> "<label>"` declares one field inside a `FORM` —
`type` must be `integer`, `decimal`, `text`, or `boolean` (the same
restriction `REQUEST AS` places on its own fields, §16), and the label
is optional (falls back to the field name). Each renders as a labeled
HTML input — text, a number field, or a checkbox depending on the type.

A `CALL API`'s `WITH` payload can now reference an `INPUT`'s name
directly (`author`, `body` above), read live at submit time — unlike a
loop field or literal (fixed when the page compiles), a form field can
only be known once a visitor actually types it in.

`FORM` is top-level only inside a `PAGE` (not inside `FOR EACH` or
another `FORM`) — a form per rendered record isn't supported yet.

## 18. SERVICE / API: a live HTTP server

Where `PAGE` compiles to a static snapshot, `SERVICE` compiles to a real,
running HTTP server that keeps your data live across requests:

```nova
DATA Product
    name: text
    price: decimal
END

DO makeProduct RETURNS Product
    INPUT n: text
    INPUT p: decimal
    RETURN { name: n, price: p }
END

SAVE makeProduct("Widget", 9.99)

SERVICE
    API GET "/products"
        RETURN GET Product
    END

    API POST "/products"
        SET p = REQUEST AS Product
        SAVE p
        RETURN p
    END
END
```

```bash
nova serve myservice.nova 3000
```

```bash
curl http://localhost:3000/products
curl -X POST -d '{"name":"Sprocket","price":4.25}' http://localhost:3000/products
```

`nova serve` runs the file's top-level statements once (so any `SAVE`s
above populate the store), then starts a real server on the given port
(default `3000`) that keeps that **same** store alive across every
request — a `SAVE` made by one request is visible to a `GET` made by the
next one, and every one after that, for as long as the server keeps
running. This is what makes it genuinely live, unlike `PAGE`'s build-time
snapshot.

A `SERVICE` block holds any number of `API` routes. Each is either:

- **`API GET "/route"`** — its body is an ordinary statement block;
  whatever it `RETURN`s becomes the JSON response body. A handler that
  never hits `RETURN` responds with JSON `null`.
- **`API POST "/route"`** — same, but its body may use `REQUEST AS
  <DataType>`, an expression that evaluates to the incoming request's JSON
  body, validated against that `DATA` type's fields. If the request body
  doesn't match — wrong shape, missing field, wrong field type — the
  client gets back an HTTP `400` automatically; your handler code never
  even runs for a malformed request.

A route must start with `/`, and no two `API` declarations in a file may
share the same method and route. `API` handler bodies are genuine,
unrestricted server-side code — `SAVE`, `GET`, `DELETE`, and procedure
calls all work exactly as they do anywhere else, since a server request
handler isn't crossing into a stranger's browser the way a `PAGE` button
does. The one restriction: `ASK` can't be called directly inside a
handler's own body, since a live server has no per-request terminal for it
to block on.

`SERVICE` must be declared at a file's top level — not nested inside an
`IF`, `DO`, loop, or anything else.

A runtime error inside a handler (for example, `DELETE`ing with a bad id
type, somehow) becomes an HTTP `500` with the error message as JSON,
without taking the whole server down. An unmatched method+route is a
`404` — unless it's a `GET` matching a `PAGE` route declared in the same
file, in which case `nova serve` serves that page's compiled HTML instead
(the same compilation `nova build` does, run once at startup against the
same populated store). This is what lets a page's own `CALL API` button
(§17) reach a same-server endpoint at all. A `PAGE` route and an `API GET`
route can't share the same path — that's a compile-time error, not a
runtime ambiguity.

## 19. The command line

| Command | What it does |
|---|---|
| `nova run <file>.nova` | Runs the file's statements top to bottom, printing `SHOW` output and prompting for `ASK` input, exactly like an ordinary script. |
| `nova build <file>.nova` | Runs the file's statements once, silently, then compiles every `PAGE` declaration to HTML under a `dist/` folder next to the file. |
| `nova serve <file>.nova [port]` | Runs the file's statements once, silently, then starts a live HTTP server for every `SERVICE`/`API` declaration *and* every `PAGE` declaration (default port `3000`). |

A single file can hold ordinary script statements, `PAGE`s, and a
`SERVICE` all at once — which parts actually do anything depends entirely
on which of the three commands you run. `nova run` never looks at `PAGE`
or `SERVICE` content; `nova build` never starts a server; `nova serve`
never writes HTML files (it serves compiled `PAGE` HTML directly, in
memory, alongside the API).

## 20. Scope rules, in one place

- **Global scope**: every top-level `SET` lives here and is visible
  everywhere below it, including inside every procedure body.
- **Block scope**: `IF`/`ELSE IF`/`ELSE`, `FOR EACH`, and `REPEAT` bodies
  each get their own scope — a `SET` inside dies at that block's `END`.
- **Procedure scope**: a `DO` body's parent scope is always *global*, never
  the call site — procedures see their own parameters and global
  variables, never a caller's locals.
- **Loop variable**: `FOR EACH`'s loop variable is a fresh binding every
  iteration, not one binding reused and overwritten.
- **Shadowing**: a nested `SET` may reuse an outer name; it shadows the
  outer one for the inner scope's lifetime, and the outer one is
  unaffected afterward.
- **`SET` vs `CHANGE`**, restated: `SET` always writes to the *current*
  scope (creating if needed). `CHANGE` always writes to wherever the name
  is already bound, found by walking outward exactly the way a plain read
  would — and never creates a binding.
- Reading a name that's never been bound anywhere reachable is a compile
  time error, not `undefined`/`null`/`NONE`.

## 21. Type rules, in one place

- `integer` and `decimal` interoperate freely in arithmetic and
  reassignment, in both directions.
- No other pair of types converts automatically — `text`, `boolean`, and
  numbers never silently mix.
- `==`/`!=` require both sides to already be the same type.
- A typed `INPUT`/`RETURNS` is checked both at the call site and, for
  `RETURNS`, on every `RETURN` inside the body — plus a "does every path
  actually return" check when `RETURNS` is present.
- A record literal checked directly against a specific `DATA` type must
  match it exactly (every field, no extras). Away from that direct check,
  NOVA stays structurally typed — a plain `record` can flow through any
  generic record-typed position.
- Leaving off type annotations entirely keeps everything fully permissive,
  the same as NOVA's very first version — types are opt-in.

## 22. Keyword reference

| Keyword | Where it's used |
|---|---|
| `SET` | declare/assign in the current scope |
| `CHANGE` | mutate an existing binding, list element, or page-local state |
| `SHOW` | print a value |
| `IF` / `ELSE` / `END` | conditional branching |
| `FOR` / `EACH` / `IN` | loop over a list (or `GET` results) |
| `REPEAT` / `TIMES` | loop a fixed number of times |
| `DO` / `RETURN` / `RETURNS` / `INPUT` | procedure declaration and use |
| `TRUE` / `FALSE` | boolean literals |
| `AND` / `OR` / `NOT` | logical operators |
| `DATA` | named record type declaration |
| `SAVE` / `GET` / `DELETE` | persistence |
| `ASK` | read one line of input |
| `TRY` / `CATCH` | runtime error handling |
| `PAGE` / `TITLE` / `STYLE` / `HEADING` / `TEXT` | compiled webpage content |
| `BUTTON` / `WHEN` / `CLICKED` | interactive page behavior |
| `SERVICE` / `API` / `GET` / `POST` | live HTTP server declaration |
| `REQUEST` / `AS` | read and validate a POST request body |
| `CALL` / `WITH` | call a live API from a page's click handler |
| `FORM` | a group of user-input fields on a page |

## 23. Diagnostic code reference

Every error NOVA reports carries a stable code, a message, and the exact
source location it applies to. Codes starting `E-LEX`/`E-PARSE` are caught
before your program is even fully parsed; `E-SEM` codes are caught by
static analysis before anything runs; `E-RUN` codes can only happen while
a program is actually executing (and are the only kind `TRY`/`CATCH`, §16,
can ever see).

| Code | Meaning |
|---|---|
| E-LEX-001 | Unexpected character |
| E-LEX-002 | Unterminated string literal |
| E-LEX-003 | Unrecognized escape sequence |
| E-LEX-004 | Reserved word used as an identifier |
| E-PARSE-001 | Unclosed block (missing `END`) |
| E-PARSE-002 | `END` with no open block to close |
| E-PARSE-003 | A second `ELSE` on the same `IF` |
| E-PARSE-004 | Malformed `FOR EACH` (missing `IN`) |
| E-PARSE-005 | Malformed `REPEAT` (missing `TIMES`) |
| E-PARSE-006 | Unexpected token |
| E-SEM-001 | Undefined name |
| E-SEM-002 | Duplicate procedure declaration |
| E-SEM-003 | Type mismatch reassigning with `SET`/`CHANGE` |
| E-SEM-004 | Type error inside an operator expression |
| E-SEM-005 | `RETURN` outside a procedure |
| E-SEM-006 | `CHANGE` on a name that was never `SET` |
| E-SEM-007 | `FOR EACH` over something that isn't a list |
| E-SEM-008 | `REPEAT` count isn't an integer |
| E-SEM-009 | Wrong number of arguments in a call |
| E-SEM-010 | Call to an undeclared procedure |
| E-SEM-011 | `==`/`!=` between mismatched types |
| E-SEM-012 | Duplicate field name in a record literal |
| E-SEM-013 | `RETURN` value doesn't match the declared `RETURNS` type |
| E-SEM-014 | Not every path through the procedure returns |
| E-SEM-015 | Call argument type doesn't match the declared parameter type |
| E-SEM-016 | Unrecognized type name in an annotation |
| E-SEM-017 | Duplicate `DATA` type name |
| E-SEM-018 | Record literal is missing a field its `DATA` type requires |
| E-SEM-019 | Record literal field's type doesn't match the `DATA` type |
| E-SEM-020 | Record literal has a field its `DATA` type doesn't declare |
| E-SEM-021 | `.field` access naming a field that doesn't exist on a known `DATA` type |
| E-SEM-022 | `SAVE`'s value isn't a specific, known `DATA` type |
| E-SEM-023 | `GET` names a type that isn't a declared `DATA` type |
| E-SEM-024 | `DELETE` names a type that isn't a declared `DATA` type |
| E-SEM-025 | `DELETE`'s id isn't an integer |
| E-SEM-026 | Indexing (`[ ]`) something that definitely isn't a list |
| E-SEM-027 | A list index that definitely isn't an integer |
| E-SEM-028 | Duplicate `PAGE` route within one file |
| E-SEM-029 | `PAGE` route missing its leading `/` |
| E-SEM-030 | Non-literal content inside `PAGE` (it's compiled, not executed) |
| E-SEM-031 | `STYLE` given a non-text value |
| E-SEM-032 | `TITLE`/`STYLE` used inside a `PAGE`-level `FOR EACH` |
| E-SEM-033 | Duplicate page-local state name |
| E-SEM-034 | A non-`CHANGE` statement inside `WHEN CLICKED` |
| E-SEM-035 | A `CHANGE` target inside `WHEN CLICKED` that isn't page-local state |
| E-SEM-036 | An indexed `CHANGE` target inside `WHEN CLICKED` |
| E-SEM-037 | An unsafe construct (call, `SAVE`/`GET`/`ASK`, field/index access, list/record literal) inside a click handler |
| E-SEM-038 | `BUTTON` used inside `FOR EACH` |
| E-SEM-039 | Duplicate `API` method + route |
| E-SEM-040 | `API` route missing its leading `/` |
| E-SEM-041 | `ASK` used directly inside an `API` handler body |
| E-SEM-042 | `REQUEST` used outside an `API POST` handler's own body |
| E-SEM-043 | `REQUEST AS` a `DATA` type with an unsupported field type |
| E-SEM-044 | `SERVICE` declared somewhere other than a file's top level |
| E-SEM-045 | `CALL API` used outside a `BUTTON`'s `WHEN CLICKED` block |
| E-SEM-046 | `CALL API` references a method+route no `API` in this file declares |
| E-SEM-047 | A `CALL API` `WITH` payload field isn't a literal, page-local state, or a valid loop-variable field reference |
| E-SEM-048 | A `PAGE` route collides with an `API GET` route (`nova serve` now serves both from one server) |
| E-SEM-049 | `INPUT` used outside a `FORM` |
| E-SEM-050 | `FORM` declared somewhere other than a `PAGE`'s top level |
| E-SEM-051 | Duplicate `INPUT` name within one `FORM` |
| E-SEM-052 | `INPUT` with a non-`integer`/`decimal`/`text`/`boolean` type |
| E-RUN-001 | Division by zero |
| E-RUN-002 | No such field on a record |
| E-RUN-003 | A built-in called with an unsupported argument type |
| E-RUN-004 | `ASK` called with no input left |
| E-RUN-005 | List index out of bounds |
| E-RUN-006 | Indexing a value that turned out not to be a list |
| E-RUN-007 | Indexing with a value that turned out not to be an integer |
| E-RUN-008 | `POST` request body isn't a JSON object |
| E-RUN-009 | `POST` request body is missing a field, or a field's type doesn't match |

---

This guide covers the complete language as implemented today. New
capabilities are documented the same way as they land — see
[HANDOFF.md](../HANDOFF.md) for what's currently in progress, and
[docs/adr/](adr/) for the reasoning behind each design decision, if you
want the "why" behind any rule above.
