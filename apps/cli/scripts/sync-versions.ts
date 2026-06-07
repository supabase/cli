import { parseArgs } from "node:util";
import path from "node:path";
import process from "node:process";

const PACKAGE_PATHS = {
  cli: ["apps", "cli"],
  "cli-darwin-arm64": ["packages", "cli-darwin-arm64"],
  "cli-darwin-x64": ["packages", "cli-darwin-x64"],
  "cli-linux-arm64": ["packages", "cli-linux-arm64"],
  "cli-linux-arm64-musl": ["packages", "cli-linux-arm64-musl"],
  "cli-linux-x64": ["packages", "cli-linux-x64"],
  "cli-linux-x64-musl": ["packages", "cli-linux-x64-musl"],
  "cli-windows-arm64": ["packages", "cli-windows-arm64"],
  "cli-windows-x64": ["packages", "cli-windows-x64"],
} as const;

const ALL_PACKAGES = Object.keys(PACKAGE_PATHS) as Array<keyof typeof PACKAGE_PATHS>;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
  },
});

const version = values.version;
if (!version) {
  console.error("Usage: pnpm exec bun apps/cli/scripts/sync-versions.ts --version <version>");
  process.exit(1);
}

const root = path.resolve(import.meta.dir, "../../..");

for (const pkg of ALL_PACKAGES) {
  const pkgJsonPath = path.join(root, ...PACKAGE_PATHS[pkg], "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();

  pkgJson.version = version;

  await Bun.write(pkgJsonPath, `${JSON.stringify(pkgJson, null, "\t")}\n`);
  console.log(`Updated ${pkg} to v${version}`);
}

console.log(`\nAll packages synced to v${version}.`);
