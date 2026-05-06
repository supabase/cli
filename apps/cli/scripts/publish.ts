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

const VALID_TAGS = new Set(["latest", "alpha", "beta"]);

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    tag: { type: "string", default: "latest" },
  },
});

const dryRun = values["dry-run"];
const tag = values.tag;
if (!VALID_TAGS.has(tag)) {
  console.error(
    `Invalid --tag value: ${String(tag)}. Expected one of: ${[...VALID_TAGS].join(", ")}.`,
  );
  process.exit(1);
}

const cliDir = path.join(root, "apps/cli");
const cliPkgJson = await Bun.file(path.join(cliDir, "package.json")).json();
const umbrellaName: string = cliPkgJson.name;

const dryRunFlag = dryRun ? ["--dry-run"] : [];
const tagFlag = ["--tag", tag];
const provenanceFlag = ["--provenance"];

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
    await $`bun publish --access public ${provenanceFlag} ${tagFlag} ${dryRunFlag}`.cwd(pkgDir);
    console.log(`  @supabase/${pkg} published.`);
  }),
);

// Build the umbrella package bin shim, then publish
console.log("\nBuilding umbrella package shim...");
await $`pnpm build:shim`.cwd(cliDir);

console.log(`Publishing umbrella package ${umbrellaName}...`);
await $`bun publish ${provenanceFlag} ${tagFlag} ${dryRunFlag}`.cwd(cliDir);
console.log(`${umbrellaName} published.`);

console.log("\nAll packages published successfully.");
