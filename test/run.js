import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { runAll, testCount } from "./harness.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort();

for (const f of files) {
  await import(pathToFileURL(path.join(testDir, f)).href);
}

console.log(`Loaded ${files.length} test files, ${testCount()} tests.`);
const ok = await runAll();
process.exit(ok ? 0 : 1);
