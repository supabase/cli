import { $ } from "bun";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dir, "../../..");

const PLATFORM_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-arm64",
  "cli-windows-x64",
];

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    tag: { type: "string", default: "latest" },
  },
});

const dryRun = values["dry-run"];
const tag = values.tag;
if (tag !== "latest" && tag !== "alpha") {
  console.error(`Invalid --tag value: ${String(tag)}. Expected "latest" or "alpha".`);
  process.exit(1);
}

const dryRunFlag = dryRun ? ["--dry-run"] : [];
const tagFlag = ["--tag", tag];

console.log(
  dryRun
    ? `Publishing to npm with tag "${tag}" (dry run)...\n`
    : `Publishing to npm with tag "${tag}"...\n`,
);

// Publish all platform packages in parallel
console.log("Publishing platform packages...");
await Promise.all(
  PLATFORM_PACKAGES.map(async (pkg) => {
    const pkgDir = path.join(root, "packages", pkg);
    console.log(`  Publishing @supabase/${pkg}...`);
    await $`bun publish --access public ${tagFlag} ${dryRunFlag}`.cwd(pkgDir);
    console.log(`  @supabase/${pkg} published.`);
  }),
);

// Build the umbrella package bin shim, then publish
const cliDir = path.join(root, "apps/cli");
console.log("\nBuilding umbrella package shim...");
await $`pnpm build:shim`.cwd(cliDir);

console.log("Publishing umbrella package @supabase/cli...");
await $`bun publish --access public ${tagFlag} ${dryRunFlag}`.cwd(cliDir);
console.log("@supabase/cli published.");

console.log("\nAll packages published successfully.");
