// Zero-dependency test harness. No npm packages are required to build,
// test, or run this project (see HANDOFF.md for why that's a deliberate
// choice in this repo, not an oversight).
const registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

export function assertEqual(actual, expected, message = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

export function assertTrue(value, message = "expected true") {
  if (value !== true) throw new Error(message);
}

export function assertThrows(fn, check, message = "expected a throw") {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(message);
  if (check) check(threw);
}

export async function runAll() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const { name, fn } of registry) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ name, error: e });
    }
  }
  console.log(`\n${passed}/${passed + failed} tests passed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const { name, error } of failures) {
      console.log(`\n  FAIL: ${name}`);
      console.log(
        "    " + String(error.stack ?? error.message).split("\n").join("\n    ")
      );
    }
  }
  return failed === 0;
}

export function testCount() {
  return registry.length;
}
