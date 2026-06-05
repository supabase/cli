import { $ } from "bun";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { runCli, verifyExpectedShell } from "./release-shell.ts";

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

function modeOctal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function describePath(p: string): Promise<string> {
  try {
    const ls = await lstat(p);
    if (ls.isSymbolicLink()) {
      const target = await readlink(p);
      try {
        const st = await stat(p);
        return `symlink ${modeOctal(ls.mode)} -> ${target} (target ${modeOctal(st.mode)} ${st.size}B)`;
      } catch (e) {
        return `symlink ${modeOctal(ls.mode)} -> ${target} (target unreadable: ${e})`;
      }
    }
    return `file ${modeOctal(ls.mode)} ${ls.size}B`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    return `unstattable: ${e}`;
  }
}

async function dumpInstalledTree(testDir: string, ext: string): Promise<void> {
  console.log("\nInstalled tree state:");
  const interesting = [
    path.join(testDir, "node_modules", ".bin", `supabase${ext}`),
    path.join(testDir, "node_modules", "supabase", "package.json"),
    path.join(testDir, "node_modules", "supabase", "dist", "supabase.js"),
  ];
  for (const p of interesting) {
    console.log(`  ${path.relative(testDir, p)}: ${await describePath(p)}`);
  }

  const supabaseScope = path.join(testDir, "node_modules", "@supabase");
  let scopeEntries: string[] = [];
  try {
    scopeEntries = await readdir(supabaseScope);
  } catch {
    console.log(`  node_modules/@supabase: MISSING`);
    return;
  }
  for (const entry of scopeEntries.sort()) {
    const pkgDir = path.join(supabaseScope, entry);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    try {
      const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
      console.log(`  node_modules/@supabase/${entry}: ${pkgJson.name}@${pkgJson.version}`);
    } catch {
      console.log(`  node_modules/@supabase/${entry}: <unreadable package.json>`);
    }
    const binDir = path.join(pkgDir, "bin");
    try {
      const binEntries = await readdir(binDir);
      for (const b of binEntries.sort()) {
        const bp = path.join(binDir, b);
        console.log(`    bin/${b}: ${await describePath(bp)}`);
      }
    } catch {
      // no bin/
    }
  }
}

async function findPlatformBinary(testDir: string, ext: string): Promise<string | null> {
  const supabaseScope = path.join(testDir, "node_modules", "@supabase");
  let entries: string[] = [];
  try {
    entries = await readdir(supabaseScope);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(supabaseScope, entry, "bin", `supabase${ext}`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

async function inspectVerdaccioTarball(storageDir: string, pkg: string): Promise<void> {
  const pkgStorage = path.join(storageDir, "@supabase", pkg);
  let files: string[] = [];
  try {
    files = await readdir(pkgStorage);
  } catch {
    console.log(`  @supabase/${pkg}: <no tarball in verdaccio storage>`);
    return;
  }
  const tarball = files.find((f) => f.endsWith(".tgz"));
  if (!tarball) {
    console.log(`  @supabase/${pkg}: <no .tgz under ${pkgStorage}>`);
    return;
  }
  const tarballPath = path.join(pkgStorage, tarball);
  const listing = await $`tar -tvf ${tarballPath}`.text();
  // Surface only the bin entries — full listings drown the log.
  const binLines = listing
    .split("\n")
    .filter((line) => line.includes("/bin/"))
    .map((line) => `    ${line.trim()}`);
  if (binLines.length === 0) {
    console.log(`  @supabase/${pkg} (${tarball}): <no bin/ entries>`);
    return;
  }
  console.log(`  @supabase/${pkg} (${tarball}):`);
  for (const line of binLines) console.log(line);
}

export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const parts = [e.stack ?? `${e.name}: ${e.message}`];
    const stdout = (e as { stdout?: unknown }).stdout;
    const stderr = (e as { stderr?: unknown }).stderr;
    if (stdout != null) parts.push(`stdout: ${String(stdout).trim()}`);
    if (stderr != null) parts.push(`stderr: ${String(stderr).trim()}`);
    return parts.join("\n");
  }
  return String(e);
}

export async function runNpmTest(
  version: string,
  tag: "latest" | "alpha" | "beta" = "latest",
): Promise<boolean> {
  await using _pkgJsons = await savePackageJsons();
  await using tmp = await createTmpDir("npm-smoke-");

  const PORT = 4873;
  const configPath = path.join(tmp.path, "config.yaml");
  const storageDir = path.join(tmp.path, "storage");

  // Verdaccio config: store our published tarballs locally. The umbrella
  // package is shim-only at runtime and should resolve only our own
  // `@supabase/cli-*` optional dependencies from this registry; the public npm
  // uplink is retained for npm installer internals and any incidental tooling.
  await writeFile(
    configPath,
    `storage: ${storageDir}
auth:
  htpasswd:
    file: ${path.join(tmp.path, "htpasswd")}
    max_users: 100
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  "supabase":
    access: $all
    publish: $all
  "@supabase/*":
    access: $all
    publish: $all
  "**":
    access: $all
    publish: $all
    proxy: npmjs
max_body_size: 200mb
listen: 0.0.0.0:${PORT}
`,
  );

  // pnpm publish delegates to npm internals, which only honor per-registry auth
  // configured in an .npmrc — `NPM_CONFIG_TOKEN` is not consulted. Write a temp
  // .npmrc with `_authToken` for the verdaccio host and point npm at it via
  // `npm_config_userconfig` so every publish call sees credentials.
  const publishNpmrc = path.join(tmp.path, "publish.npmrc");
  await writeFile(publishNpmrc, `//localhost:${PORT}/:_authToken=dummy\n`);
  const publishEnv = { ...process.env, npm_config_userconfig: publishNpmrc };

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
      await $`pnpm publish --registry ${registry.url} --tag ${tag} --no-git-checks`
        .cwd(pkgDir)
        .env(publishEnv);
      console.log(`  @supabase/${pkg}`);
    }),
  );

  // Inspect what Verdaccio actually received — directly answers whether
  // `publishConfig.executableFiles` is being applied to the published tarball.
  console.log("\nVerdaccio tarball contents (bin entries only):");
  for (const pkg of platformPackages) {
    await inspectVerdaccioTarball(storageDir, pkg);
  }

  // Build and publish umbrella package
  const cliDir = path.join(root, "apps", "cli");
  console.log("\nBuilding umbrella package shim...");
  await $`pnpm build:shim`.cwd(cliDir).quiet();

  const cliPkgJson = await readFile(path.join(cliDir, "package.json"), "utf-8").then(JSON.parse);
  const umbrellaName: string = cliPkgJson.name;

  console.log("Publishing umbrella package...");
  await $`pnpm publish --registry ${registry.url} --tag ${tag} --no-git-checks`
    .cwd(cliDir)
    .env(publishEnv);
  console.log(`  ${umbrellaName}\n`);

  console.log("Verdaccio umbrella tarball contents:");
  const umbrellaStorage = path.join(storageDir, umbrellaName);
  try {
    const files = await readdir(umbrellaStorage);
    const tarball = files.find((f) => f.endsWith(".tgz"));
    if (tarball) {
      const listing = await $`tar -tvf ${path.join(umbrellaStorage, tarball)}`.text();
      for (const line of listing.split("\n").filter(Boolean)) {
        console.log(`    ${line.trim()}`);
      }
    } else {
      console.log(`  <no .tgz under ${umbrellaStorage}>`);
    }
  } catch {
    console.log(`  <no umbrella tarball storage at ${umbrellaStorage}>`);
  }

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

  // Install. Pass --registry explicitly: in some environments (notably ones
  // where pnpm has set `npm_config_*` env vars) those override the project
  // .npmrc, and `npm install supabase` silently fetches from registry.npmjs.org
  // instead — the test then accidentally exercises the published 2.x CLI rather
  // than the umbrella we just packed. The CLI flag wins over both env vars and
  // .npmrc, so it is the only resolution path that is actually safe here.
  const installSpec = tag === "latest" ? umbrellaName : `${umbrellaName}@${tag}`;
  console.log(`\nInstalling ${installSpec}...`);
  await $`npm install --registry ${registry.url} ${installSpec}`.cwd(testDir);

  // Verify
  console.log("\nVerifying...");
  const ext = process.platform === "win32" ? ".cmd" : "";
  const binPath = path.join(testDir, "node_modules", ".bin", `supabase${ext}`);

  await dumpInstalledTree(testDir, ext);

  const versionResult = await runCli(binPath, ["--version"]);
  const hasValidVersion =
    versionResult.exitCode === 0 && /^\d+\.\d+\.\d+/.test(versionResult.stdout);

  if (!hasValidVersion) {
    console.log(`\n[verify] supabase --version FAILED:`);
    console.log(`  exit=${versionResult.exitCode}`);
    console.log(`  stdout=${JSON.stringify(versionResult.stdout)}`);
    console.log(`  stderr=${JSON.stringify(versionResult.stderr)}`);

    // Isolate "shim broken" vs "platform binary broken" by trying the
    // platform binary directly.
    const platformBin = await findPlatformBinary(testDir, ext);
    if (platformBin) {
      console.log(`\n[verify] retrying via platform binary: ${platformBin}`);
      const direct = await runCli(platformBin, ["--version"]);
      console.log(`  exit=${direct.exitCode}`);
      console.log(`  stdout=${JSON.stringify(direct.stdout)}`);
      console.log(`  stderr=${JSON.stringify(direct.stderr)}`);
    } else {
      console.log(`\n[verify] no platform binary found under node_modules/@supabase/*/bin/`);
    }
  }

  const shellCheck = await verifyExpectedShell(binPath);
  const passed = hasValidVersion && shellCheck.passed;

  console.log(
    `\n${passed ? "PASS" : "FAIL"} — supabase --version exit=${versionResult.exitCode} stdout=${JSON.stringify(versionResult.stdout)}`,
  );
  console.log(shellCheck.detail);

  return passed;
}
