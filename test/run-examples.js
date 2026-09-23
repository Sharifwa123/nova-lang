// Runs every example through the REAL CLI (a child process, exactly what a
// user would type), not the in-process pipeline test/interpreter.test.js
// exercises. This is the "actual nova run output" level of verification the
// original design discipline insisted on (see HANDOFF.md).
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { deleteStoreFileIfExists } from "../src/persistence/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const examplesDir = path.join(root, "examples");
const cli = path.join(root, "src", "cli.js");

let passed = 0;
let failed = 0;

function runCli(file, stdinInput, command = "run") {
  const opts = { encoding: "utf8" };
  if (stdinInput !== undefined) opts.input = stdinInput;
  return spawnSync(process.execPath, [cli, command, file], opts);
}

console.log("== Valid examples (expect exit 0) ==");
const validFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".nova"));
for (const f of validFiles) {
  const full = path.join(examplesDir, f);
  // ADR-008 — a companion `<name>.stdin` file, if present, is piped in as
  // real stdin (not the in-process canned-input path test/v0.7-ask.test.js
  // exercises) — dual verification, matching ADR-008's own discipline.
  const stdinPath = full.replace(/\.nova$/, ".stdin");
  let stdinInput;
  try {
    stdinInput = readFileSync(stdinPath, "utf8");
  } catch {
    stdinInput = undefined;
  }
  const result = runCli(full, stdinInput);
  if (result.status === 0) {
    console.log(`  OK   ${f}`);
    passed++;
  } else {
    console.log(`  FAIL ${f} (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

console.log("\n== Error examples (expect the annotated diagnostic code) ==");
const errorsDir = path.join(examplesDir, "errors");
const errorFiles = readdirSync(errorsDir).filter((f) => f.endsWith(".nova"));
for (const f of errorFiles) {
  const full = path.join(errorsDir, f);
  const source = readFileSync(full, "utf8");
  const expectedMatch = source.match(/# expect:\s*(\S+)/);
  const expectedCode = expectedMatch ? expectedMatch[1] : null;
  let stdinInput;
  try {
    stdinInput = readFileSync(full.replace(/\.nova$/, ".stdin"), "utf8");
  } catch {
    stdinInput = undefined;
  }
  const result = runCli(full, stdinInput);
  const gotCode = (result.stderr.match(/\[([A-Z0-9-]+)\]/) || [])[1];
  if (result.status === 1 && gotCode === expectedCode) {
    console.log(`  OK   ${f} -> ${gotCode}`);
    passed++;
  } else {
    console.log(`  FAIL ${f} (expected ${expectedCode}, got ${gotCode ?? "no diagnostic"}, exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

// ADR-011 — `nova run` never exercises the PAGE compiler at all (PAGE is
// inert there), so examples/website.nova is separately verified through
// `nova build`, checking the real files it writes to dist/ - the same
// "actual CLI output, not just in-process" standard as everything else.
console.log("\n== PAGE compiler (nova build, expect exit 0 + real output files) ==");
{
  const source = path.join(examplesDir, "website.nova");
  const distDir = path.join(examplesDir, "dist");
  const result = runCli(source, undefined, "build");
  const indexPath = path.join(distDir, "index.html");
  const aboutPath = path.join(distDir, "about.html");
  let indexHtml = "", aboutHtml = "";
  try {
    indexHtml = readFileSync(indexPath, "utf8");
    aboutHtml = readFileSync(aboutPath, "utf8");
  } catch {
    // leave blank; checked below
  }
  const ok =
    result.status === 0 &&
    indexHtml.includes("<title>NOVA</title>") &&
    indexHtml.includes("<h1>Welcome to NOVA</h1>") &&
    aboutHtml.includes("<title>About</title>");
  if (ok) {
    console.log(`  OK   website.nova -> dist/index.html, dist/about.html`);
    passed++;
  } else {
    console.log(`  FAIL website.nova build (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

// ADR-012 — data-bound PAGE: `nova build` must actually run the script
// (silently) to populate SAVE'd data before compiling FOR EACH...IN GET.
{
  const source = path.join(examplesDir, "data_bound_website.nova");
  const distDir = path.join(examplesDir, "dist");
  const result = runCli(source, undefined, "build");
  let html = "";
  try {
    html = readFileSync(path.join(distDir, "catalog.html"), "utf8");
  } catch {
    // leave blank; checked below
  }
  const ok =
    result.status === 0 &&
    result.stdout.trim() !== "" && // "Wrote ..." lines only - no SHOW output leaked through
    !result.stdout.includes("This only prints with") &&
    html.includes("<h1>Widget</h1>") &&
    html.includes("<p>9.99</p>") &&
    html.includes("<h1>Gizmo</h1>");
  if (ok) {
    console.log(`  OK   data_bound_website.nova -> dist/catalog.html (data-bound, build-time SAVE populated it)`);
    passed++;
  } else {
    console.log(`  FAIL data_bound_website.nova build (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

// ADR-013 — interactive PAGE: real CLI build, then EXECUTE the generated
// <script> against a DOM stub and call the button functions
// programmatically - a string match on the HTML cannot catch a codegen
// bug (wrong operator, render() never called); actually running it can.
{
  const source = path.join(examplesDir, "interactive_counter.nova");
  const distDir = path.join(examplesDir, "dist");
  const result = runCli(source, undefined, "build");
  let html = "";
  try {
    html = readFileSync(path.join(distDir, "counter.html"), "utf8");
  } catch {
    // leave blank; checked below
  }
  let chainOk = false;
  try {
    const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    for (const m of html.matchAll(/id="(nova-el-\d+)"/g)) {
      if (!elements.has(m[1])) {
        elements.set(m[1], {
          _text: "",
          set textContent(v) { this._text = v; },
          get textContent() { return this._text; },
        });
      }
    }
    const sandbox = { document: { getElementById: (id) => elements.get(id) } };
    vm.createContext(sandbox);
    vm.runInContext(scriptSrc, sandbox);
    const el = elements.get("nova-el-0");
    sandbox.novaClick_0(); // +1
    sandbox.novaClick_0(); // +1
    sandbox.novaClick_1(); // -1
    chainOk = sandbox.state.count === 1 && el.textContent === "1";
    sandbox.novaClick_2(); // Reset
    chainOk = chainOk && sandbox.state.count === 0 && el.textContent === "0";
  } catch {
    chainOk = false;
  }
  const ok = result.status === 0 && chainOk;
  if (ok) {
    console.log(`  OK   interactive_counter.nova -> dist/counter.html (generated JS executed, click chain verified)`);
    passed++;
  } else {
    console.log(`  FAIL interactive_counter.nova build/execute (exit ${result.status})`);
    console.log(indent(result.stderr || result.stdout));
    failed++;
  }
}

// ADR-014 — SERVICE/API: `nova serve` is a long-running process, not a
// one-shot command, so it needs its own real end-to-end check: spawn the
// actual CLI as a real child process (not the in-process interpreter),
// wait for it to report it's actually listening, then issue real HTTP
// requests against it (Node's global fetch) and assert on the real JSON
// responses - the same "actual CLI output" standard as `nova build`
// above, extended here to a live server instead of generated files.
console.log("\n== SERVICE/API (nova serve, expect exit 0 + real HTTP responses) ==");
{
  const source = path.join(examplesDir, "api_service.nova");
  const dataFile = `${source}.data.json`;
  // ADR-018 — `nova serve` is now durable, so a stray data file from a
  // prior run of this test would break the exact-count assertions below.
  // Guaranteeing a clean slate is this test's own job now, not the CLI's.
  deleteStoreFileIfExists(dataFile);
  let ok = false;
  let failureDetail = "";
  const child = spawn(process.execPath, [cli, "serve", source, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdoutBuf = "";
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the server to report it's listening.")), 5000);
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const m = stdoutBuf.match(/listening on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server process exited early (code ${code}).`));
      });
    });

    const hello = await fetch(`http://localhost:${port}/hello`);
    const helloBody = await hello.json();
    const products = await fetch(`http://localhost:${port}/products`);
    const productsBody = await products.json();
    const missing = await fetch(`http://localhost:${port}/nope`);

    // ADR-015 — API POST + REQUEST AS: post a real JSON body to the real
    // spawned server, then confirm a later GET sees it (genuinely live,
    // not just an in-process assertion).
    const created = await fetch(`http://localhost:${port}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sprocket", price: 4.25 }),
    });
    const createdBody = await created.json();
    const badPost = await fetch(`http://localhost:${port}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Missing price" }),
    });
    const productsAfterPost = await (await fetch(`http://localhost:${port}/products`)).json();

    ok =
      hello.status === 200 &&
      helloBody === "Hello from NOVA" &&
      products.status === 200 &&
      Array.isArray(productsBody) &&
      productsBody.length === 2 &&
      productsBody[0].name === "Widget" &&
      productsBody[0].price === 9.99 &&
      missing.status === 404 &&
      created.status === 200 &&
      createdBody.name === "Sprocket" &&
      createdBody.price === 4.25 &&
      badPost.status === 400 &&
      productsAfterPost.length === 3;
    if (!ok) {
      failureDetail = `hello=${JSON.stringify(helloBody)} products=${JSON.stringify(productsBody)} missing.status=${missing.status} created.status=${created.status} createdBody=${JSON.stringify(createdBody)} badPost.status=${badPost.status} productsAfterPost=${JSON.stringify(productsAfterPost)}`;
    }
  } catch (e) {
    failureDetail = String(e.stack ?? e);
  } finally {
    child.kill();
    deleteStoreFileIfExists(dataFile);
  }

  if (ok) {
    console.log(`  OK   api_service.nova serve -> real HTTP responses verified`);
    passed++;
  } else {
    console.log(`  FAIL api_service.nova serve`);
    console.log(indent(failureDetail));
    failed++;
  }
}

// ADR-016 — PAGE/SERVICE integration: spawn the real `nova serve` (so the
// PAGE route is genuinely being served by the same process as the API,
// not just compiled in isolation), then run its generated <script> in a
// DOM-stub vm sandbox (same technique as interactive_counter.nova above)
// - except its `fetch` is a thin shim resolving CALL API's relative path
// against the real spawned server before delegating to Node's real global
// fetch. Calling the generated (now-async) novaClick_N() therefore issues
// a genuinely real HTTP POST against the genuinely live server; a
// separate real GET afterward confirms the reservation actually landed -
// not an in-process assertion at any point.
console.log("\n== PAGE + SERVICE integration (nova serve, expect a real click to really book a room) ==");
{
  const source = path.join(examplesDir, "booking_page.nova");
  const dataFile = `${source}.data.json`;
  deleteStoreFileIfExists(dataFile); // ADR-018 — see the api_service.nova block above
  let ok = false;
  let failureDetail = "";
  const child = spawn(process.execPath, [cli, "serve", source, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdoutBuf = "";
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the server to report it's listening.")), 5000);
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const m = stdoutBuf.match(/listening on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server process exited early (code ${code}).`));
      });
    });

    const before = await (await fetch(`http://localhost:${port}/reservations`)).json();

    const pageHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const scriptSrc = pageHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    for (const m of pageHtml.matchAll(/id="(novaBtn_\d+)"/g)) {
      if (!elements.has(m[1])) {
        elements.set(m[1], {
          disabled: false,
          _text: "",
          set textContent(v) { this._text = v; },
          get textContent() { return this._text; },
        });
      }
    }
    const sandbox = {
      document: { getElementById: (id) => elements.get(id) },
      fetch: (url, opts) => fetch(`http://localhost:${port}${url}`, opts),
    };
    vm.createContext(sandbox);
    vm.runInContext(scriptSrc, sandbox);

    const btn = elements.get("novaBtn_1"); // the Double room (roomNumber 201)
    await sandbox.novaClick_1();

    const after = await (await fetch(`http://localhost:${port}/reservations`)).json();

    ok =
      before.length === 0 &&
      btn.textContent === "Done" &&
      btn.disabled === true &&
      after.length === 1 &&
      after[0].roomNumber === 201;
    if (!ok) {
      failureDetail = `before=${JSON.stringify(before)} btn=${JSON.stringify({ text: btn.textContent, disabled: btn.disabled })} after=${JSON.stringify(after)}`;
    }
  } catch (e) {
    failureDetail = String(e.stack ?? e);
  } finally {
    child.kill();
    deleteStoreFileIfExists(dataFile);
  }

  if (ok) {
    console.log(`  OK   booking_page.nova serve -> a real click really booked a room`);
    passed++;
  } else {
    console.log(`  FAIL booking_page.nova serve`);
    console.log(indent(failureDetail));
    failed++;
  }
}

// ADR-017 — FORM/INPUT: same real-server, real-generated-script technique
// as booking_page.nova above, except the DOM stub's INPUT elements get
// their `.value` set programmatically (standing in for a visitor typing)
// before the button is "clicked" - so this proves genuinely typed input,
// not data already known at compile time, reaches the live API intact.
console.log("\n== PAGE FORM (nova serve, expect typed input to really reach the API) ==");
{
  const source = path.join(examplesDir, "guest_book.nova");
  const dataFile = `${source}.data.json`;
  deleteStoreFileIfExists(dataFile); // ADR-018 — see the api_service.nova block above
  let ok = false;
  let failureDetail = "";
  const child = spawn(process.execPath, [cli, "serve", source, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdoutBuf = "";
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the server to report it's listening.")), 5000);
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const m = stdoutBuf.match(/listening on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server process exited early (code ${code}).`));
      });
    });

    const before = await (await fetch(`http://localhost:${port}/messages`)).json();

    const pageHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const scriptSrc = pageHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    for (const m of pageHtml.matchAll(/id="(novaBtn_\d+|novaInput_\d+)"/g)) {
      if (!elements.has(m[1])) {
        elements.set(m[1], {
          value: "",
          checked: false,
          disabled: false,
          _text: "",
          set textContent(v) { this._text = v; },
          get textContent() { return this._text; },
        });
      }
    }
    const sandbox = {
      document: { getElementById: (id) => elements.get(id) },
      fetch: (url, opts) => fetch(`http://localhost:${port}${url}`, opts),
    };
    vm.createContext(sandbox);
    vm.runInContext(scriptSrc, sandbox);

    elements.get("novaInput_0").value = "Ada Lovelace";
    elements.get("novaInput_1").value = "Loved the analytical engine!";
    await sandbox.novaClick_0();

    const after = await (await fetch(`http://localhost:${port}/messages`)).json();

    ok =
      before.length === 0 &&
      elements.get("novaBtn_0").textContent === "Done" &&
      after.length === 1 &&
      after[0].author === "Ada Lovelace" &&
      after[0].body === "Loved the analytical engine!";
    if (!ok) {
      failureDetail = `before=${JSON.stringify(before)} after=${JSON.stringify(after)} btnText=${elements.get("novaBtn_0").textContent}`;
    }
  } catch (e) {
    failureDetail = String(e.stack ?? e);
  } finally {
    child.kill();
    deleteStoreFileIfExists(dataFile);
  }

  if (ok) {
    console.log(`  OK   guest_book.nova serve -> typed form input really reached the API`);
    passed++;
  } else {
    console.log(`  FAIL guest_book.nova serve`);
    console.log(indent(failureDetail));
    failed++;
  }
}

// ADR-018 — durable persistence: the actual payoff is a genuine process
// restart, not just requests against one long-running process (every check
// above already covers that). Spawn `nova serve`, add a product over real
// HTTP, kill the process, spawn a SECOND, completely separate process
// against the same file, and confirm both the seeded AND the added data
// are still there - and that the seed guard (IF LENGTH(GET Product) == 0
// in api_service.nova) stopped the seed products from being re-added.
console.log("\n== Durable persistence (nova serve, expect data to survive a real restart) ==");
{
  const source = path.join(examplesDir, "api_service.nova");
  const dataFile = `${source}.data.json`;
  deleteStoreFileIfExists(dataFile);
  let ok = false;
  let failureDetail = "";

  function spawnServe() {
    const child = spawn(process.execPath, [cli, "serve", source, "0"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    const port = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the server to report it's listening.")), 5000);
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const m = stdoutBuf.match(/listening on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server process exited early (code ${code}).`));
      });
    });
    return { child, port };
  }

  let first, second;
  try {
    first = spawnServe();
    const port1 = await first.port;
    const beforeRestart = await (await fetch(`http://localhost:${port1}/products`)).json();
    await fetch(`http://localhost:${port1}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Doohickey", price: 2.5 }),
    });
    const beforeKill = await (await fetch(`http://localhost:${port1}/products`)).json();
    first.child.kill();
    await new Promise((resolve) => first.child.on("exit", resolve));

    // A genuinely separate process, started fresh, reading the same
    // <file>.nova.data.json the first process wrote.
    second = spawnServe();
    const port2 = await second.port;
    const afterRestart = await (await fetch(`http://localhost:${port2}/products`)).json();

    ok =
      beforeRestart.length === 2 && // the two seeded products, first boot
      beforeKill.length === 3 && // + the one added over HTTP, same process
      afterRestart.length === 3 && // survived the restart intact
      afterRestart.some((p) => p.name === "Doohickey" && p.price === 2.5) &&
      // the seed guard stopped a second boot from re-adding the seed pair
      afterRestart.filter((p) => p.name === "Widget").length === 1;
    if (!ok) {
      failureDetail = `beforeRestart=${JSON.stringify(beforeRestart)} beforeKill=${JSON.stringify(beforeKill)} afterRestart=${JSON.stringify(afterRestart)}`;
    }
  } catch (e) {
    failureDetail = String(e.stack ?? e);
  } finally {
    first?.child.kill();
    second?.child.kill();
    deleteStoreFileIfExists(dataFile);
  }

  if (ok) {
    console.log(`  OK   api_service.nova serve, restarted -> seeded + added data both survived, no re-seed`);
    passed++;
  } else {
    console.log(`  FAIL api_service.nova serve, restarted`);
    console.log(indent(failureDetail));
    failed++;
  }
}

function indent(s) {
  return (s ?? "").split("\n").map((l) => "    " + l).join("\n");
}

console.log(`\n${passed}/${passed + failed} examples behaved as expected.`);
process.exit(failed === 0 ? 0 : 1);
