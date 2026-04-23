import { $ } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { verifyExpectedShell } from "./release-shell.ts";

const root = path.resolve(import.meta.dir, "../../../..");

const PACKAGE_PATHS = {
  "cli-darwin-arm64": ["packages", "cli-darwin-arm64"],
  "cli-darwin-x64": ["packages", "cli-darwin-x64"],
  "cli-linux-arm64": ["packages", "cli-linux-arm64"],
  "cli-linux-arm64-musl": ["packages", "cli-linux-arm64-musl"],
  "cli-linux-x64": ["packages", "cli-linux-x64"],
  "cli-linux-x64-musl": ["packages", "cli-linux-x64-musl"],
  "cli-windows-arm64": ["packages", "cli-windows-arm64"],
  "cli-windows-x64": ["packages", "cli-windows-x64"],
  cli: ["apps", "cli"],
} as const;

const ALL_PACKAGES = Object.keys(PACKAGE_PATHS) as Array<keyof typeof PACKAGE_PATHS>;

export async function createTmpDir(prefix: string): Promise<AsyncDisposable & { path: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true });
    },
  };
}

async function startVerdaccio(
  configPath: string,
  port: number,
): Promise<AsyncDisposable & { url: string }> {
  const url = `http://localhost:${port}`;
  const proc = Bun.spawn(["bunx", "verdaccio", "--config", configPath], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const timeout = 120_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/-/ping`);
      if (res.ok) return { url, [Symbol.asyncDispose]: async () => proc.kill() };
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }

  proc.kill();
  throw new Error(`Verdaccio failed to start within ${timeout / 1000}s`);
}

async function savePackageJsons() {
  const originals = new Map<string, string>();
  for (const pkg of ALL_PACKAGES) {
    const p = path.join(root, ...PACKAGE_PATHS[pkg], "package.json");
    originals.set(p, await readFile(p, "utf-8"));
  }
  return {
    async [Symbol.asyncDispose]() {
      for (const [p, content] of originals) {
        await writeFile(p, content);
      }
    },
  };
}

export async function runNpmTest(
  version: string,
  tag: "latest" | "alpha" = "latest",
): Promise<boolean> {
  const publishEnv = { ...process.env, NPM_CONFIG_TOKEN: "dummy" };

  await using _pkgJsons = await savePackageJsons();
  await using tmp = await createTmpDir("npm-smoke-");

  const PORT = 4873;
  const configPath = path.join(tmp.path, "config.yaml");

  await writeFile(
    configPath,
    `storage: ${path.join(tmp.path, "storage")}
auth:
  htpasswd:
    file: ${path.join(tmp.path, "htpasswd")}
    max_users: 100
uplinks: {}
packages:
  "**":
    access: $all
    publish: $all
max_body_size: 200mb
listen: 0.0.0.0:${PORT}
`,
  );

  // Sync versions across all packages
  console.log(`Syncing versions to ${version}...`);
  await $`pnpm exec bun apps/cli/scripts/sync-versions.ts --version ${version}`.cwd(root).quiet();

  console.log("Starting local npm registry...");
  await using registry = await startVerdaccio(configPath, PORT);
  console.log(`Registry ready at ${registry.url}\n`);

  // Publish platform packages in parallel
  const platformPackages = ALL_PACKAGES.filter((p) => p !== "cli");
  console.log("Publishing platform packages...");
  await Promise.all(
    platformPackages.map(async (pkg) => {
      const pkgDir = path.join(root, "packages", pkg);
      await $`bun publish --registry ${registry.url} --tag ${tag}`
        .cwd(pkgDir)
        .env(publishEnv)
        .quiet();
      console.log(`  @supabase/${pkg}`);
    }),
  );

  // Build and publish umbrella package
  const cliDir = path.join(root, "apps", "cli");
  console.log("\nBuilding umbrella package shim...");
  await $`pnpm build:shim`.cwd(cliDir).quiet();

  console.log("Publishing umbrella package...");
  await $`bun publish --registry ${registry.url} --tag ${tag}`.cwd(cliDir).env(publishEnv).quiet();
  console.log("  @supabase/cli\n");

  // Create test project
  const testDir = path.join(tmp.path, "test-project");
  await mkdir(testDir);
  await writeFile(
    path.join(testDir, "package.json"),
    JSON.stringify({ name: "test-npm-smoke", version: "0.0.0", private: true }),
  );
  await writeFile(
    path.join(testDir, ".npmrc"),
    `registry=${registry.url}\n//localhost:${PORT}/:_authToken=dummy\n`,
  );

  // Install
  const installSpec = tag === "alpha" ? "@supabase/cli@alpha" : "@supabase/cli";
  console.log(`Installing ${installSpec}...`);
  await $`npm install ${installSpec}`.cwd(testDir);

  // Verify
  console.log("\nVerifying...");
  const ext = process.platform === "win32" ? ".cmd" : "";
  const binPath = path.join(testDir, "node_modules", ".bin", `supabase${ext}`);
  const versionOutput = (await $`${binPath} --version`.text()).trim();
  const hasValidVersion = /^\d+\.\d+\.\d+/.test(versionOutput);
  const shellCheck = await verifyExpectedShell(binPath, tag);
  const passed = hasValidVersion && shellCheck.passed;

  console.log(`\n${passed ? "PASS" : "FAIL"} — supabase --version: ${versionOutput}`);
  console.log(shellCheck.detail);

  return passed;
}
