import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { createTmpDir, runNpmTest } from "./helpers/npm-registry.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
  },
});

const version = values.version!;
const root = path.resolve(import.meta.dir, "../../..");

interface TestResult {
  name: string;
  status: "pass" | "fail";
}

const results: TestResult[] = [];

// --- Native ---

console.log(`\n${"=".repeat(60)}`);
console.log("Native binary tests");
console.log("=".repeat(60));

{
  const arch = process.arch; // "arm64" or "x64"
  const name = `native-darwin-${arch}`;
  const binPath = path.join(root, "packages", `cli-darwin-${arch}`, "bin", "supabase");

  console.log(`[${name}] Running ${binPath} --version...`);
  try {
    const output = await $`${binPath} --version`.text();
    const trimmed = output.trim();
    const passed = /^\d+\.\d+\.\d+/.test(trimmed);
    console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);
    results.push({ name, status: passed ? "pass" : "fail" });
  } catch (e) {
    console.log(`[${name}] FAIL — ${e}`);
    results.push({ name, status: "fail" });
  }
}

// --- npm ---

console.log(`\n${"=".repeat(60)}`);
console.log("npm (Verdaccio) test");
console.log("=".repeat(60));

try {
  const npmPassed = await runNpmTest(version);
  results.push({ name: "npm", status: npmPassed ? "pass" : "fail" });
} catch (e) {
  console.error(`[npm] Error: ${e}`);
  results.push({ name: "npm", status: "fail" });
}

// --- Brew ---

console.log(`\n${"=".repeat(60)}`);
console.log("Homebrew test");
console.log("=".repeat(60));

const hasBrew = await $`brew --version`.quiet().then(
  () => true,
  () => false,
);

if (!hasBrew) {
  console.log("[brew] SKIP — brew not found");
} else {
  try {
    // Generate the formula with local file:// URLs
    console.log("Generating Homebrew formula...");
    await $`bun run packages/cli/scripts/update-homebrew.ts --version ${version} --local`.cwd(root);

    // Create a local git-backed tap
    await using tap = await createTmpDir("brew-smoke-");
    await mkdir(path.join(tap.path, "Formula"));
    await $`cp ${path.join(root, "dist", "supabase.rb")} ${path.join(tap.path, "Formula", "supabase.rb")}`;
    await $`git -C ${tap.path} init`.quiet();
    await $`git -C ${tap.path} add .`.quiet();
    await $`git -C ${tap.path} commit -m init`.quiet();

    console.log("Installing via Homebrew...");
    await $`brew tap --force supabase/test-tap ${tap.path}`;

    try {
      await $`brew install supabase/test-tap/supabase`;

      const output = await $`supabase --version`.text();
      const trimmed = output.trim();
      const passed = /^\d+\.\d+\.\d+/.test(trimmed);

      console.log(`[brew] ${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`);
      results.push({ name: "brew", status: passed ? "pass" : "fail" });
    } finally {
      await $`brew uninstall supabase`.nothrow();
      await $`brew untap supabase/test-tap`.nothrow();
    }
  } catch (e) {
    console.error(`[brew] Error: ${e}`);
    results.push({ name: "brew", status: "fail" });
  }
}

// --- Summary ---

console.log(`\n${"=".repeat(60)}`);
console.log("macOS Smoke Test Summary");
console.log("=".repeat(60));

for (const r of results) {
  console.log(`  ${r.status === "pass" ? "PASS" : "FAIL"}  ${r.name}`);
}

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;

console.log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

if (failed > 0) {
  process.exit(1);
}
