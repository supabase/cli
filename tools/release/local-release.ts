/**
 * Builds the CLI for the current platform and publishes it to the local
 * Verdaccio registry. Never modifies any git-tracked files — all version
 * mutations happen inside a system temp directory that is deleted on exit.
 *
 * Usage:
 *   pnpm cli-release [--version 0.0.0-local.1234567890]
 *
 * Requires `pnpm local-registry` to be running in another terminal.
 */

import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const PORT = 4873;
const REGISTRY = `http://localhost:${PORT}`;
const root = path.resolve(import.meta.dir, "../..");
const tokenPath = path.join(root, "tmp", "verdaccio-token");

// Every platform package that appears in optionalDependencies.
const PLATFORM_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-arm64",
  "cli-windows-x64",
] as const;

type PlatformInfo = {
  bunTarget: string;
  platformPkg: string;
  ext: string;
};

const PLATFORM_MAP: Record<string, PlatformInfo> = {
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    platformPkg: "cli-darwin-arm64",
    ext: "",
  },
  "darwin-x64": {
    bunTarget: "bun-darwin-x64",
    platformPkg: "cli-darwin-x64",
    ext: "",
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    platformPkg: "cli-linux-arm64",
    ext: "",
  },
  "linux-x64": {
    bunTarget: "bun-linux-x64-baseline",
    platformPkg: "cli-linux-x64",
    ext: "",
  },
  "win32-x64": {
    bunTarget: "bun-windows-x64-baseline",
    platformPkg: "cli-windows-x64",
    ext: ".exe",
  },
  "win32-arm64": {
    bunTarget: "bun-windows-arm64",
    platformPkg: "cli-windows-arm64",
    ext: ".exe",
  },
};

function getPlatformInfo(): PlatformInfo {
  const key = `${process.platform}-${process.arch}`;
  const info = PLATFORM_MAP[key];
  if (!info) {
    console.error(`\nError: Unsupported platform: ${key}`);
    console.error("Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64\n");
    process.exit(1);
  }
  return info;
}

function libcForBunTarget(target: string): "glibc" | "musl" | "" {
  if (!target.startsWith("bun-linux-")) {
    return "";
  }
  return target.includes("-musl") ? "musl" : "glibc";
}

async function checkRegistry(): Promise<void> {
  try {
    const res = await fetch(`${REGISTRY}/-/ping`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`\nError: Local registry not responding at ${REGISTRY}`);
    console.error("Start it first with: pnpm local-registry\n");
    process.exit(1);
  }
}

async function readToken(): Promise<string> {
  try {
    return (await Bun.file(tokenPath).text()).trim();
  } catch {
    console.error(`\nError: Auth token not found at ${tokenPath}`);
    console.error("The local registry must be running before you release: pnpm local-registry\n");
    process.exit(1);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
    },
  });

  const version = values.version ?? `0.0.0-local.${Math.floor(Date.now() / 1000)}`;

  await checkRegistry();
  const token = await readToken();
  const platform = getPlatformInfo();

  if (process.platform === "linux") {
    console.warn(
      "Note: local-release builds the glibc variant only (cli-linux-*). " +
        "The musl variant is skipped for local dev.\n",
    );
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "supabase-local-release-"));

  try {
    // Read once up front so log lines and the published package.json agree.
    const cliPkgJson = await Bun.file(path.join(root, "apps", "cli", "package.json")).json();
    const umbrellaName: string = cliPkgJson.name;

    console.log(`\nBuilding ${umbrellaName}@${version} (${platform.platformPkg})...\n`);

    const tmpPlatformDir = path.join(tmpDir, platform.platformPkg);
    const tmpPlatformBinDir = path.join(tmpPlatformDir, "bin");
    await mkdir(tmpPlatformBinDir, { recursive: true });

    const entrypoint = path.join(root, "apps", "cli", "src", "main.ts");
    const bunBinary = path.join(tmpPlatformBinDir, `supabase${platform.ext}`);
    const libc = libcForBunTarget(platform.bunTarget);

    console.log("[1/2] Compiling CLI binary...");
    await $`bun build ${entrypoint} --compile --target=${platform.bunTarget} --define=SUPABASE_LIBC=${JSON.stringify(libc)} --outfile=${bunBinary}`;

    const tmpCliDir = path.join(tmpDir, "cli");
    const tmpCliDistDir = path.join(tmpCliDir, "dist");
    await mkdir(tmpCliDistDir, { recursive: true });

    const shimSrc = path.join(root, "apps", "cli", "src", "shared", "cli", "bin.ts");
    const shimOut = path.join(tmpCliDistDir, "supabase.js");
    console.log("[2/2] Building Node.js shim...");
    await $`bun build ${shimSrc} --outfile=${shimOut} --target=node`;

    const platformPkgJson = await Bun.file(
      path.join(root, "packages", platform.platformPkg, "package.json"),
    ).json();
    platformPkgJson.version = version;
    await Bun.write(
      path.join(tmpPlatformDir, "package.json"),
      `${JSON.stringify(platformPkgJson, null, "\t")}\n`,
    );

    // The shim only uses Node built-ins; @supabase/* and catalog: deps are bundled in the platform
    // binary and must not appear here (catalog: and workspace:* are invalid outside pnpm workspaces).
    const resolvedOptionalDeps: Record<string, string> = {};
    for (const pkg of PLATFORM_PACKAGES) {
      resolvedOptionalDeps[`@supabase/${pkg}`] = version;
    }

    const publishPkgJson = {
      name: cliPkgJson.name,
      version,
      type: cliPkgJson.type,
      bin: cliPkgJson.bin,
      files: cliPkgJson.files,
      publishConfig: cliPkgJson.publishConfig,
      optionalDependencies: resolvedOptionalDeps,
    };
    await Bun.write(
      path.join(tmpCliDir, "package.json"),
      `${JSON.stringify(publishPkgJson, null, "\t")}\n`,
    );

    const npmrc = [`registry=${REGISTRY}`, `//localhost:${PORT}/:_authToken=${token}`, ""].join(
      "\n",
    );
    await Bun.write(path.join(tmpPlatformDir, ".npmrc"), npmrc);
    await Bun.write(path.join(tmpCliDir, ".npmrc"), npmrc);

    console.log(`\nPublishing @supabase/${platform.platformPkg}@${version} to local registry...`);
    // bun publish (not pnpm) for the platform binary package: pnpm normalizes tarball file modes
    // and strips the execute bit from files outside the package's `bin` field; bun publish
    // preserves modes, matching production.
    await $`bun publish --access public --tag local --registry ${REGISTRY} --no-git-checks`.cwd(
      tmpPlatformDir,
    );

    console.log(`Publishing ${umbrellaName}@${version} to local registry...`);
    await $`pnpm publish --access public --tag local --registry ${REGISTRY} --no-git-checks`.cwd(
      tmpCliDir,
    );

    console.log(`
✓ Published ${umbrellaName}@${version}

Test with npx:
  npx --registry ${REGISTRY} ${umbrellaName}@${version} --version

Or install globally:
  npm install -g --registry ${REGISTRY} ${umbrellaName}@${version}
  supabase --version
`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
