import { $ } from "bun";
import path from "node:path";
import { parseArgs } from "node:util";

try {
  await $`scoop --version`.quiet();
} catch {
  console.log("[scoop] SKIP — scoop not found");
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
  },
});

const version = values.version;
if (!version) {
  console.error("Usage: bun run smoke-test-scoop.ts --version <version>");
  process.exit(1);
}

const root = path.resolve(import.meta.dir, "../../..");
const manifest = path.join(root, "dist", "supabase.json");

// Generate the manifest with local file:/// URLs
console.log("Generating Scoop manifest...");
await $`bun run packages/cli-dist/scripts/update-scoop.ts --version ${version} --local`.cwd(root);

console.log("Installing via Scoop...");
await $`scoop install ${manifest}`;

try {
  const output = await $`supabase --version`.text();
  const trimmed = output.trim();
  const passed = /^\d+\.\d+\.\d+/.test(trimmed);

  console.log(`\n${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`);

  if (!passed) {
    process.exit(1);
  }
} finally {
  await $`scoop uninstall supabase`.nothrow();
}
