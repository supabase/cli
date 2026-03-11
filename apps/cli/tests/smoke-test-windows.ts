import { $ } from "bun";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

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
  const name = "native-windows-x64";
  const binPath = path.join(root, "packages", "cli-windows-x64", "bin", "supabase.exe");

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

// --- Scoop ---

console.log(`\n${"=".repeat(60)}`);
console.log("Scoop test");
console.log("=".repeat(60));

const hasScoop = await $`scoop --version`.quiet().then(
  () => true,
  () => false,
);

if (!hasScoop) {
  console.log("[scoop] SKIP — scoop not found");
} else {
  const manifest = path.join(root, "dist", "supabase.json");

  try {
    // Generate the manifest with local file:/// URLs
    console.log("Generating Scoop manifest...");
    await $`bun run apps/cli/scripts/update-scoop.ts --version ${version} --local`.cwd(root);

    console.log("Installing via Scoop...");
    await $`scoop install ${manifest}`;

    try {
      const output = await $`supabase --version`.text();
      const trimmed = output.trim();
      const passed = /^\d+\.\d+\.\d+/.test(trimmed);

      console.log(`[scoop] ${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`);
      results.push({ name: "scoop", status: passed ? "pass" : "fail" });
    } finally {
      await $`scoop uninstall supabase`.nothrow();
    }
  } catch (e) {
    console.error(`[scoop] Error: ${e}`);
    results.push({ name: "scoop", status: "fail" });
  }
}

// --- Summary ---

console.log(`\n${"=".repeat(60)}`);
console.log("Windows Smoke Test Summary");
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
