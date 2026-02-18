import { $ } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../../..");

const ALL_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-x64",
  "cli",
];

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
    const p = path.join(root, "packages", pkg, "package.json");
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

export async function runNpmTest(version: string): Promise<boolean> {
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
  await $`bun run packages/cli/scripts/sync-versions.ts --version ${version}`.cwd(root).quiet();

  console.log("Starting local npm registry...");
  await using registry = await startVerdaccio(configPath, PORT);
  console.log(`Registry ready at ${registry.url}\n`);

  // Publish platform packages in parallel
  const platformPackages = ALL_PACKAGES.filter((p) => p !== "cli");
  console.log("Publishing platform packages...");
  await Promise.all(
    platformPackages.map(async (pkg) => {
      const pkgDir = path.join(root, "packages", pkg);
      await $`bun publish --registry ${registry.url}`.cwd(pkgDir).env(publishEnv).quiet();
      console.log(`  @supabase/${pkg}`);
    }),
  );

  // Build and publish umbrella package
  const cliDir = path.join(root, "packages", "cli");
  console.log("\nBuilding umbrella package...");
  await $`bun run build`.cwd(cliDir).quiet();

  console.log("Publishing umbrella package...");
  await $`bun publish --registry ${registry.url}`.cwd(cliDir).env(publishEnv).quiet();
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
  console.log("Installing @supabase/cli...");
  await $`npm install @supabase/cli`.cwd(testDir);

  // Verify
  console.log("\nVerifying...");
  const ext = process.platform === "win32" ? ".cmd" : "";
  const binPath = path.join(testDir, "node_modules", ".bin", `supabase${ext}`);
  const output = await $`${binPath} --version`.text();
  const trimmed = output.trim();
  const passed = /^\d+\.\d+\.\d+/.test(trimmed);

  console.log(`\n${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`);

  return passed;
}
