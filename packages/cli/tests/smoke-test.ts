import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
  },
});

const version = values.version!;
const testsDir = import.meta.dir;

const tests = [
  { name: "native", script: "smoke-test-native.ts", passVersion: false },
  { name: "docker", script: "smoke-test-docker.ts", passVersion: true },
  { name: "npm", script: "smoke-test-npm.ts", passVersion: true },
  { name: "brew", script: "smoke-test-brew.ts", passVersion: true },
  { name: "scoop", script: "smoke-test-scoop.ts", passVersion: true },
];

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
}

const results: TestResult[] = [];

for (const test of tests) {
  const scriptPath = path.join(testsDir, test.script);
  const args = test.passVersion ? ["--version", version] : [];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running: ${test.name}`);
  console.log("=".repeat(60));

  try {
    const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
      stdout: "pipe",
      stderr: "inherit",
      env: process.env,
    });

    const output = await new Response(proc.stdout).text();
    process.stdout.write(output);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      results.push({ name: test.name, status: "fail" });
    } else if (output.includes("SKIP")) {
      results.push({ name: test.name, status: "skip" });
    } else {
      results.push({ name: test.name, status: "pass" });
    }
  } catch (e) {
    console.error(`[${test.name}] Error: ${e}`);
    results.push({ name: test.name, status: "fail" });
  }
}

// --- Summary ---

console.log(`\n${"=".repeat(60)}`);
console.log("Smoke Test Summary");
console.log("=".repeat(60));

for (const r of results) {
  const icon = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
  console.log(`  ${icon}  ${r.name}`);
}

const passed = results.filter((r) => r.status === "pass").length;
const skipped = results.filter((r) => r.status === "skip").length;
const failed = results.filter((r) => r.status === "fail").length;

console.log(
  `\n${passed} passed, ${skipped} skipped, ${failed} failed out of ${results.length} tests`,
);

if (failed > 0) {
  process.exit(1);
}
