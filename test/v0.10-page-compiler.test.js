// v0.10 (ADR-011) - PAGE compiles to static HTML; it never runs. Also
// covers the lexer fix picked up along the way: a `{` not shaped like a
// real interpolation is literal text, not a lex error (needed for raw CSS
// in STYLE, but general-purpose - see lexer.test.js's own new cases too).
import { test, assertEqual, assertThrows, assertTrue } from "./harness.js";
import { compile, runSource } from "../src/nova.js";
import { compileProgram, routeToOutputPath } from "../src/pagecompiler/compile.js";
import { CODES } from "../src/diagnostics/codes.js";

function build(source) {
  const program = compile(source, "<test>", {});
  return compileProgram(program);
}

function run(source) {
  const lines = [];
  runSource(source, "<test>", {}, { write: (s) => lines.push(s) });
  return lines;
}

// ---- routing ----

test("v0.10: route-to-path mapping", () => {
  assertEqual(routeToOutputPath("/"), "index.html");
  assertEqual(routeToOutputPath("/about"), "about.html");
  assertEqual(routeToOutputPath("/products/list"), "products/list.html");
});

test("v0.10: a program with no PAGE declarations compiles to zero outputs", () => {
  assertEqual(build('SHOW "hello"'), []);
});

test("v0.10: multiple PAGE declarations each produce their own output", () => {
  const outputs = build('PAGE "/"\n    TITLE "Home"\nEND\nPAGE "/about"\n    TITLE "About"\nEND');
  assertEqual(outputs.map((o) => o.path).sort(), ["about.html", "index.html"]);
});

// ---- HTML content ----

test("v0.10: TITLE, HEADING, TEXT render into the expected tags", () => {
  const [{ html }] = build('PAGE "/"\n    TITLE "My Page"\n    HEADING "Hi"\n    TEXT "Body text"\nEND');
  assertTrue(html.includes("<title>My Page</title>"));
  assertTrue(html.includes("<h1>Hi</h1>"));
  assertTrue(html.includes("<p>Body text</p>"));
});

test("v0.10: HEADING/TEXT interleave in declaration order", () => {
  const [{ html }] = build(
    'PAGE "/"\n    HEADING "One"\n    TEXT "First"\n    HEADING "Two"\n    TEXT "Second"\nEND'
  );
  const tags = ["<h1>One</h1>", "<p>First</p>", "<h1>Two</h1>", "<p>Second</p>"];
  const order = tags.map((s) => html.indexOf(s));
  assertTrue(order.every((idx) => idx !== -1));
  assertTrue(order.every((idx, i) => i === 0 || idx > order[i - 1]));
});

test("v0.10: STYLE content is embedded raw (not HTML-escaped) in a <style> tag", () => {
  const [{ html }] = build('PAGE "/"\n    STYLE "body { color: red; }"\nEND');
  assertTrue(html.includes("<style>body { color: red; }</style>"));
});

test("v0.10: multiple STYLE elements concatenate", () => {
  const [{ html }] = build('PAGE "/"\n    STYLE "a { color: red; }"\n    STYLE "b { color: blue; }"\nEND');
  assertTrue(html.includes("a { color: red; }"));
  assertTrue(html.includes("b { color: blue; }"));
});

test("v0.10: TITLE defaults to the route when omitted", () => {
  const [{ html }] = build('PAGE "/about"\n    TEXT "hi"\nEND');
  assertTrue(html.includes("<title>/about</title>"));
});

test("v0.10: TEXT/HEADING content is HTML-escaped", () => {
  const [{ html }] = build('PAGE "/"\n    TEXT "a & b < c > d"\nEND');
  assertTrue(html.includes("a &amp; b &lt; c &gt; d"));
  assertTrue(!html.includes("a & b < c > d"));
});

test("v0.10: non-text literals display like SHOW does", () => {
  const [{ html }] = build('PAGE "/"\n    TEXT 42\n    TEXT TRUE\nEND');
  assertTrue(html.includes(">42<"));
  assertTrue(html.includes(">TRUE<"));
});

// ---- PAGE is inert during `nova run` ----

test("v0.10: nova run ignores PAGE declarations entirely", () => {
  const program = `PAGE "/"
    TITLE "x"
END
SHOW "only this runs"`;
  assertEqual(run(program), ["only this runs"]);
});

test("v0.10: a file can mix a runnable script and PAGE declarations", () => {
  const program = `DO greet
    SHOW "hello from the script"
END
PAGE "/"
    TITLE "A page"
END
greet()`;
  assertEqual(run(program), ["hello from the script"]);
});

// ---- diagnostics ----

test("v0.10: route without a leading slash is E-SEM-029", () => {
  assertThrows(
    () => compile('PAGE "no-slash"\n    TITLE "x"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.INVALID_PAGE_ROUTE)
  );
});

test("v0.10: duplicate route is E-SEM-028", () => {
  assertThrows(
    () => compile('PAGE "/"\n    TITLE "a"\nEND\nPAGE "/"\n    TITLE "b"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.DUPLICATE_PAGE_ROUTE)
  );
});

test("v0.10: a variable used as PAGE content is E-SEM-030 (PAGE is never executed)", () => {
  assertThrows(
    () => compile('SET name = "World"\nPAGE "/"\n    TEXT name\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_CONTENT_NOT_STATIC)
  );
});

test("v0.10: interpolated string as PAGE content is also E-SEM-030", () => {
  assertThrows(
    () => compile('SET name = "World"\nPAGE "/"\n    TEXT "Hello {name}"\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_CONTENT_NOT_STATIC)
  );
});

test("v0.10: STYLE given a non-text literal is E-SEM-031", () => {
  assertThrows(
    () => compile('PAGE "/"\n    STYLE 42\nEND'),
    (e) => assertEqual(e.diagnostic.code, CODES.PAGE_STYLE_NOT_TEXT)
  );
});

test("v0.10: a second TITLE in one PAGE is an error", () => {
  assertThrows(() => compile('PAGE "/"\n    TITLE "a"\n    TITLE "b"\nEND'));
});

// ---- the lexer fix ----

test("v0.10 (lexer fix): a brace not shaped like interpolation is literal text", () => {
  assertEqual(run('SHOW "body { color: red; }"'), ["body { color: red; }"]);
});

test("v0.10 (lexer fix): real interpolation still works alongside literal braces", () => {
  assertEqual(run('SET x = "red"\nSHOW "color: {x}; margin: { 2em }"'), ["color: red; margin: { 2em }"]);
});
