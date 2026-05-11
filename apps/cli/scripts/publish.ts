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
const umbrellaVersion: string = cliPkgJson.version;

const dryRunFlag = dryRun ? ["--dry-run"] : [];
const tagFlag = ["--tag", tag];
const provenanceFlag = ["--provenance"];
const noGitChecksFlag = ["--no-git-checks"];

// Reads the active npm registry once. We honour `npm config get registry`
// rather than hard-coding registry.npmjs.org so the existence probe and the
// publish target stay aligned — important for the local Verdaccio harness
// (`pnpm local-registry`), which rewrites the global npm/pnpm registry config.
const registryUrl = (await $`npm config get registry`.quiet().text()).trim().replace(/\/$/, "");

// Probes the registry for `<name>@<version>`:
//   200 → already published, 404 → not, anything else throws.
// Used both as a pre-flight skip check and as a post-failure reconciliation
// when the actual publish errors with E403 (registry CDN cache may lag).
async function isAlreadyPublished(name: string, version: string): Promise<boolean> {
  const encodedName = name.replace("/", "%2F");
  const res = await fetch(`${registryUrl}/${encodedName}/${version}`, { method: "GET" });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`npm registry probe for ${name}@${version} returned HTTP ${res.status}`);
}

type PublishResult = "published" | "skipped";

// Publishes one workspace package idempotently. If the version is already
// on the registry — either before we start or after a publish-time conflict
// — we skip and return "skipped". Any other failure propagates.
async function publishPackage(opts: {
  name: string;
  version: string;
  cwd: string;
  extraFlags?: string[];
}): Promise<PublishResult> {
  const { name, version, cwd, extraFlags = [] } = opts;
  const label = `${name}@${version}`;

  if (await isAlreadyPublished(name, version)) {
    console.log(`  [skip] ${label} already published.`);
    return "skipped";
  }

  console.log(`  Publishing ${label}...`);
  try {
    await $`pnpm publish ${extraFlags} ${provenanceFlag} ${tagFlag} ${noGitChecksFlag} ${dryRunFlag}`.cwd(
      cwd,
    );
    console.log(`  ${label} published.`);
    return "published";
  } catch (error) {
    if (await isAlreadyPublished(name, version)) {
      console.log(
        `  [skip] ${label} reported a conflict but is now present on the registry; treating as success.`,
      );
      return "skipped";
    }
    throw error;
  }
}

console.log(
  dryRun
    ? `Publishing to npm with tag "${tag}" (dry run)...\n`
    : `Publishing to npm with tag "${tag}"...\n`,
);

// Defensive: every platform package must already be at the umbrella version.
// `sync-versions.ts` runs in the workflow before publish (`release-shared.yml`),
// so a mismatch here means the script was invoked out of order — fail loud
// rather than publishing an inconsistent set of packages.
for (const pkg of PLATFORM_PACKAGES) {
  const pkgJson = await Bun.file(path.join(root, "packages", pkg, "package.json")).json();
  if (pkgJson.version !== umbrellaVersion) {
    console.error(
      `Version mismatch: @supabase/${pkg} is ${pkgJson.version}, expected ${umbrellaVersion}. Run sync-versions.ts first.`,
    );
    process.exit(1);
  }
}

// Publish all platform packages in parallel
console.log("Publishing platform packages...");
const platformResults = await Promise.all(
  PLATFORM_PACKAGES.map((pkg) =>
    publishPackage({
      name: `@supabase/${pkg}`,
      version: umbrellaVersion,
      cwd: path.join(root, "packages", pkg),
      extraFlags: ["--access", "public"],
    }),
  ),
);

// Build the umbrella package bin shim, then publish
console.log("\nBuilding umbrella package shim...");
await $`pnpm build:shim`.cwd(cliDir);

console.log(`Publishing umbrella package ${umbrellaName}...`);
const umbrellaResult = await publishPackage({
  name: umbrellaName,
  version: umbrellaVersion,
  cwd: cliDir,
});

const results = [...platformResults, umbrellaResult];
const publishedCount = results.filter((r) => r === "published").length;
const skippedCount = results.filter((r) => r === "skipped").length;

console.log(`\nPublished: ${publishedCount}, Skipped: ${skippedCount}.`);

// All-skipped is ambiguous: it can mean "recovering from a downstream-only
// failure (GH release / brew / scoop) — bytes already on npm, just continue"
// OR "semantic-release re-computed a version whose bytes are already live, so
// today's commits silently did not ship". Since we cannot tell those apart
// here, log a loud warning so the human reviewing the workflow run can decide
// whether to re-cut as a fresh version via `workflow_dispatch`.
if (publishedCount === 0) {
  console.warn(
    `\n[warn] No packages were published — every package was already on the registry at ${umbrellaVersion}.\n` +
      `       If today's commits were expected to ship, the version did not advance.\n` +
      `       Re-cut as a fresh version via the Release workflow (workflow_dispatch).`,
  );
}

console.log("\nAll packages published successfully.");
