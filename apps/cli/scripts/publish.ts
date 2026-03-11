import { $ } from "bun";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dir, "../../..");

const PLATFORM_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-x64",
];

const dryRun = process.argv.includes("--dry-run");
const dryRunFlag = dryRun ? "--dry-run" : [];

console.log(dryRun ? "Publishing (dry run)...\n" : "Publishing to npm...\n");

// Publish all platform packages in parallel
console.log("Publishing platform packages...");
await Promise.all(
  PLATFORM_PACKAGES.map(async (pkg) => {
    const pkgDir = path.join(root, "packages", pkg);
    console.log(`  Publishing @supabase/${pkg}...`);
    await $`bun publish --access public ${dryRunFlag}`.cwd(pkgDir);
    console.log(`  @supabase/${pkg} published.`);
  }),
);

// Build the umbrella package bin shim, then publish
const cliDir = path.join(root, "apps/cli");
console.log("\nBuilding umbrella package...");
await $`bun run build`.cwd(cliDir);

console.log("Publishing umbrella package @supabase/cli...");
await $`bun publish --access public ${dryRunFlag}`.cwd(cliDir);
console.log("@supabase/cli published.");

console.log("\nAll packages published successfully.");
