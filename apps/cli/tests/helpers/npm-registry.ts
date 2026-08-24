import { BunPath, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import * as EffectPath from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { runCli, verifyExpectedShell } from "./release-shell.ts";

const { resolve, join, relative } = Effect.runSync(
  EffectPath.Path.pipe(Effect.provide(BunPath.layer)),
);
const root = resolve(import.meta.dir, "../../../..");

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

const ALL_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-arm64",
  "cli-windows-x64",
  "cli",
] as const;

type PackageName = (typeof ALL_PACKAGES)[number];

class NpmRegistryError extends Data.TaggedError("NpmRegistryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly ignoreOutput?: boolean;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly extendEnv?: boolean;
}

const runCommand = (
  command: string | ReadonlyArray<string>,
  args: ReadonlyArray<string> = [],
  options: CommandOptions = {},
): Effect.Effect<CommandResult, PlatformError, never> => {
  const cmd = typeof command === "string" ? [command, ...args] : [...command];
  const executable = cmd[0];
  if (executable === undefined) {
    return Effect.die("command cannot be empty");
  }
  const captureOutput = options.ignoreOutput !== true;
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, cmd.slice(1), {
          cwd: options.cwd,
          env: options.env,
          extendEnv: options.extendEnv,
          stdout: captureOutput ? "pipe" : "ignore",
          stderr: captureOutput ? "pipe" : "ignore",
        }),
      );
      return yield* Effect.all(
        {
          status: handle.exitCode,
          stdout: captureOutput
            ? Stream.mkString(Stream.decodeText(handle.stdout))
            : Effect.succeed(""),
          stderr: captureOutput
            ? Stream.mkString(Stream.decodeText(handle.stderr))
            : Effect.succeed(""),
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(Effect.provide(BunServices.layer));
};

const readFileString = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path, "utf8");
  });

const writeFileString = (path: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, contents);
  });

const remove = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { recursive: true, force: true });
  });

const encodeJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError((cause) => new NpmRegistryError({ message: "JSON encoding failed", cause })),
  );

interface TmpDir {
  readonly path: string;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

const createTmpDirEffect = (
  prefix: string,
): Effect.Effect<TmpDir, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempDirectory({ prefix });
    return {
      path,
      [Symbol.asyncDispose]: () => disposeTmpDir(path),
    } satisfies TmpDir;
  });

const disposeTmpDir = (path: string): Promise<void> =>
  Effect.runPromise(remove(path).pipe(Effect.provide(BunServices.layer)));

/** Promise facade consumed by the outer smoke scripts. Core setup is Effect-native. */
export function createTmpDir(prefix: string): Promise<TmpDir> {
  return Effect.runPromise(createTmpDirEffect(prefix).pipe(Effect.provide(BunServices.layer)));
}

const httpPing = (url: string): Effect.Effect<void, NpmRegistryError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(`${url}/-/ping`))
      .pipe(
        Effect.mapError(
          (cause) => new NpmRegistryError({ message: "registry readiness request failed", cause }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new NpmRegistryError({ message: `registry returned HTTP ${response.status}` });
    }
    yield* response.text.pipe(
      Effect.mapError(
        (cause) => new NpmRegistryError({ message: "registry readiness body failed", cause }),
      ),
    );
  });

const startVerdaccio = (
  configPath: string,
  port: number,
): Effect.Effect<
  { readonly url: string },
  PlatformError | NpmRegistryError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const url = `http://localhost:${port}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner.spawn(
      ChildProcess.make("bunx", ["verdaccio", "--config", configPath], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const readiness = Schedule.recurs(240).pipe(Schedule.addDelay(() => Effect.succeed(500)));
    yield* httpPing(url).pipe(Effect.retry(readiness), Effect.provide(FetchHttpClient.layer));
    return { url };
  });

const packageJsonPath = (pkg: PackageName): string =>
  join(root, ...PACKAGE_PATHS[pkg], "package.json");

const savePackageJsons = () =>
  Effect.gen(function* () {
    const originals = new Map<string, string>();
    for (const pkg of ALL_PACKAGES) {
      const path = packageJsonPath(pkg);
      originals.set(path, yield* readFileString(path));
    }
    return originals;
  });

const restorePackageJsons = (originals: ReadonlyMap<string, string>) =>
  Effect.forEach(originals, ([path, content]) => writeFileString(path, content), {
    concurrency: "unbounded",
    discard: true,
  });

const modeOctal = (mode: number): string => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;

const describePath = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    const link = yield* fs.readLink(path).pipe(Effect.option);
    if (Option.isSome(link)) {
      return `symlink ${modeOctal(info.mode)} -> ${link.value} (${info.size}B)`;
    }
    return `file ${modeOctal(info.mode)} ${info.size}B`;
  }).pipe(
    Effect.catch((error) =>
      error instanceof Error && error.message.includes("NotFound")
        ? Effect.succeed("MISSING")
        : Effect.succeed(`unstattable: ${String(error)}`),
    ),
  );

const dumpInstalledTree = (
  testDir: string,
  ext: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.log("\nInstalled tree state:");
    const interesting = [
      join(testDir, "node_modules", ".bin", `supabase${ext}`),
      join(testDir, "node_modules", "supabase", "package.json"),
      join(testDir, "node_modules", "supabase", "dist", "supabase.js"),
    ];
    for (const path of interesting) {
      yield* Effect.log(`  ${relative(testDir, path)}: ${yield* describePath(path)}`);
    }

    const supabaseScope = join(testDir, "node_modules", "@supabase");
    const scopeEntries = yield* fs
      .readDirectory(supabaseScope)
      .pipe(Effect.orElseSucceed(() => []));
    if (scopeEntries.length === 0) {
      yield* Effect.log("  node_modules/@supabase: MISSING");
      return;
    }
    for (const entry of scopeEntries.sort((left, right) => left.localeCompare(right))) {
      const pkgDir = join(supabaseScope, entry);
      const pkgJsonPath = join(pkgDir, "package.json");
      const pkgJsonText = yield* readFileString(pkgJsonPath).pipe(Effect.orElseSucceed(() => ""));
      const pkgJson = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
      )(pkgJsonText).pipe(
        Effect.mapError(
          (cause) => new NpmRegistryError({ message: "package JSON decoding failed", cause }),
        ),
        Effect.option,
      );
      if (Option.isSome(pkgJson)) {
        yield* Effect.log(
          `  node_modules/@supabase/${entry}: ${pkgJson.value.name}@${pkgJson.value.version}`,
        );
      } else {
        yield* Effect.log(`  node_modules/@supabase/${entry}: <unreadable package.json>`);
      }
      const binDir = join(pkgDir, "bin");
      const binEntries = yield* fs.readDirectory(binDir).pipe(Effect.orElseSucceed(() => []));
      for (const bin of binEntries.sort((left, right) => left.localeCompare(right))) {
        const binPath = join(binDir, bin);
        yield* Effect.log(`    bin/${bin}: ${yield* describePath(binPath)}`);
      }
    }
  });

const findPlatformBinary = (testDir: string, ext: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const supabaseScope = join(testDir, "node_modules", "@supabase");
    const entries = yield* fs.readDirectory(supabaseScope).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const candidate = join(supabaseScope, entry, "bin", `supabase${ext}`);
      if (yield* fs.exists(candidate)) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });

const inspectVerdaccioTarball = (storageDir: string, pkg: string) =>
  Effect.gen(function* () {
    const storage = join(storageDir, "@supabase", pkg);
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs.readDirectory(storage).pipe(Effect.orElseSucceed(() => []));
    const tarball = files.find((file) => file.endsWith(".tgz"));
    if (tarball === undefined) {
      yield* Effect.log(`  @supabase/${pkg}: <no tarball in verdaccio storage>`);
      return;
    }
    const listing = yield* runCommand("tar", ["-tvf", join(storage, tarball)]);
    const binLines = listing.stdout
      .split("\n")
      .filter((line) => line.includes("/bin/"))
      .map((line) => `    ${line.trim()}`);
    if (binLines.length === 0) {
      yield* Effect.log(`  @supabase/${pkg} (${tarball}): <no bin/ entries>`);
      return;
    }
    yield* Effect.log(`  @supabase/${pkg} (${tarball}):`);
    yield* Effect.forEach(binLines, (line) => Effect.log(line), { discard: true });
  });

const hasVerdaccioTarball = (
  storageDir: string,
  pkg: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(join(storageDir, "@supabase", pkg))
      .pipe(Effect.orElseSucceed(() => []));
    return files.some((file) => file.endsWith(".tgz"));
  });

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.stack ?? `${error.name}: ${error.message}`];
    const stdout = Reflect.get(error, "stdout");
    const stderr = Reflect.get(error, "stderr");
    if (stdout != null) parts.push(`stdout: ${String(stdout).trim()}`);
    if (stderr != null) parts.push(`stderr: ${String(stderr).trim()}`);
    return parts.join("\n");
  }
  return String(error);
}

const PackageManifest = Schema.Struct({ name: Schema.String, version: Schema.String });

const runNpmTestEffect = (
  version: string,
  tag: "latest" | "alpha" | "beta",
): Effect.Effect<
  boolean,
  NpmRegistryError | PlatformError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const originals = yield* savePackageJsons();
      yield* Effect.addFinalizer(() => restorePackageJsons(originals).pipe(Effect.ignoreCause));

      const tmpPath = yield* fs.makeTempDirectoryScoped({ prefix: "npm-smoke-" });
      const port = 4873;
      const configPath = join(tmpPath, "config.yaml");
      const storageDir = join(tmpPath, "storage");
      const configLines = [
        `storage: ${storageDir}`,
        "auth:",
        "  htpasswd:",
        `    file: ${join(tmpPath, "htpasswd")}`,
        "    max_users: 100",
        "uplinks:",
        "  npmjs:",
        "    url: https://registry.npmjs.org/",
        "packages:",
        '  "supabase":',
        "    access: $all",
        "    publish: $all",
        '  "@supabase/*":',
        "    access: $all",
        "    publish: $all",
        '  "**":',
        "    access: $all",
        "    publish: $all",
        "    proxy: npmjs",
        "max_body_size: 200mb",
        `listen: 0.0.0.0:${port}`,
        "",
      ];
      yield* writeFileString(configPath, configLines.join("\n"));
      const publishNpmrc = join(tmpPath, "publish.npmrc");
      yield* writeFileString(publishNpmrc, `//localhost:${port}/:_authToken=dummy\n`);

      yield* Effect.log(`Syncing versions to ${version}...`);
      const syncResult = yield* runCommand(
        "pnpm",
        ["exec", "bun", "apps/cli/scripts/sync-versions.ts", "--version", version],
        { cwd: root },
      );
      if (syncResult.status !== 0) {
        return yield* new NpmRegistryError({ message: syncResult.stderr || "version sync failed" });
      }

      yield* Effect.log("Starting local npm registry...");
      const registry = yield* startVerdaccio(configPath, port);
      yield* Effect.log(`Registry ready at ${registry.url}\n`);

      const platformPackages = ALL_PACKAGES.filter((pkg) => pkg !== "cli");
      yield* Effect.log("Publishing platform packages...");
      for (const pkg of platformPackages) {
        const pkgDir = join(root, "packages", pkg);
        const publish = yield* runCommand(
          "pnpm",
          ["publish", "--registry", registry.url, "--tag", tag, "--no-git-checks"],
          {
            cwd: pkgDir,
            env: { npm_config_userconfig: publishNpmrc },
            extendEnv: true,
          },
        );
        if (publish.status !== 0 && !(yield* hasVerdaccioTarball(storageDir, pkg))) {
          return yield* new NpmRegistryError({
            message: publish.stderr || `publishing @supabase/${pkg} failed`,
          });
        }
        yield* Effect.log(
          publish.status === 0
            ? `  @supabase/${pkg}`
            : `  @supabase/${pkg} (already present in local registry)`,
        );
      }

      yield* Effect.log("\nVerdaccio tarball contents (bin entries only):");
      yield* Effect.forEach(platformPackages, (pkg) => inspectVerdaccioTarball(storageDir, pkg), {
        discard: true,
      });

      const cliDir = join(root, "apps", "cli");
      yield* Effect.log("\nBuilding umbrella package shim...");
      const shim = yield* runCommand("pnpm", ["build:shim"], { cwd: cliDir, ignoreOutput: true });
      if (shim.status !== 0) {
        return yield* new NpmRegistryError({
          message: shim.stderr || "building umbrella shim failed",
        });
      }
      const cliManifest = yield* Schema.decodeEffect(Schema.fromJsonString(PackageManifest))(
        yield* readFileString(join(cliDir, "package.json")),
      ).pipe(
        Effect.mapError(
          (cause) => new NpmRegistryError({ message: "CLI package JSON decoding failed", cause }),
        ),
      );
      yield* Effect.log("Publishing umbrella package...");
      const umbrellaPublish = yield* runCommand(
        "pnpm",
        ["publish", "--registry", registry.url, "--tag", tag, "--no-git-checks"],
        {
          cwd: cliDir,
          env: { npm_config_userconfig: publishNpmrc },
          extendEnv: true,
        },
      );
      if (umbrellaPublish.status !== 0) {
        return yield* new NpmRegistryError({
          message: umbrellaPublish.stderr || "publishing umbrella package failed",
        });
      }
      yield* Effect.log(`  ${cliManifest.name}\n`);

      yield* Effect.log("Verdaccio umbrella tarball contents:");
      const umbrellaStorage = join(storageDir, cliManifest.name);
      const umbrellaFiles = yield* fs
        .readDirectory(umbrellaStorage)
        .pipe(Effect.orElseSucceed(() => []));
      const umbrellaTarball = umbrellaFiles.find((file) => file.endsWith(".tgz"));
      if (umbrellaTarball !== undefined) {
        const listing = yield* runCommand("tar", ["-tvf", join(umbrellaStorage, umbrellaTarball)]);
        yield* Effect.forEach(
          listing.stdout.split("\n").filter(Boolean),
          (line) => Effect.log(`    ${line.trim()}`),
          { discard: true },
        );
      } else {
        yield* Effect.log(`  <no .tgz under ${umbrellaStorage}>`);
      }

      const testDir = join(tmpPath, "test-project");
      yield* fs.makeDirectory(testDir);
      yield* writeFileString(
        join(testDir, "package.json"),
        yield* encodeJson({ name: "test-npm-smoke", version: "0.0.0", private: true }),
      );
      yield* writeFileString(
        join(testDir, ".npmrc"),
        `registry=${registry.url}\n//localhost:${port}/:_authToken=dummy\n`,
      );

      const installSpec = tag === "latest" ? cliManifest.name : `${cliManifest.name}@${tag}`;
      yield* Effect.log(`\nInstalling ${installSpec}...`);
      const install = yield* runCommand(
        "npm",
        ["install", "--registry", registry.url, installSpec],
        {
          cwd: testDir,
        },
      );
      if (install.status !== 0) {
        return yield* new NpmRegistryError({ message: install.stderr || "npm install failed" });
      }

      yield* Effect.log("\nVerifying...");
      const ext = process.platform === "win32" ? ".cmd" : "";
      const binPath = join(testDir, "node_modules", ".bin", `supabase${ext}`);
      yield* dumpInstalledTree(testDir, ext);

      const versionResult = yield* Effect.tryPromise({
        try: () => runCli(binPath, ["--version"]),
        catch: (cause) => new NpmRegistryError({ message: "running installed CLI failed", cause }),
      });
      const hasValidVersion =
        versionResult.exitCode === 0 && /^\d+\.\d+\.\d+/.test(versionResult.stdout);
      if (!hasValidVersion) {
        yield* Effect.log("\n[verify] supabase --version FAILED:");
        yield* Effect.log(`  exit=${versionResult.exitCode}`);
        yield* Effect.log(`  stdout=${versionResult.stdout}`);
        yield* Effect.log(`  stderr=${versionResult.stderr}`);

        const platformBin = yield* findPlatformBinary(testDir, ext);
        if (Option.isSome(platformBin)) {
          yield* Effect.log(`\n[verify] retrying via platform binary: ${platformBin.value}`);
          const direct = yield* Effect.tryPromise({
            try: () => runCli(platformBin.value, ["--version"]),
            catch: (cause) =>
              new NpmRegistryError({ message: "running platform CLI failed", cause }),
          });
          yield* Effect.log(`  exit=${direct.exitCode}`);
          yield* Effect.log(`  stdout=${direct.stdout}`);
          yield* Effect.log(`  stderr=${direct.stderr}`);
        } else {
          yield* Effect.log(
            "\n[verify] no platform binary found under node_modules/@supabase/*/bin/",
          );
        }
      }

      const shellCheck = yield* Effect.tryPromise({
        try: () => verifyExpectedShell(binPath),
        catch: (cause) => new NpmRegistryError({ message: "shell verification failed", cause }),
      });
      const passed = hasValidVersion && shellCheck.passed;
      yield* Effect.log(
        `\n${passed ? "PASS" : "FAIL"} — supabase --version exit=${versionResult.exitCode} stdout=${versionResult.stdout}`,
      );
      yield* Effect.log(shellCheck.detail);
      return passed;
    }),
  );

export function runNpmTest(
  version: string,
  tag: "latest" | "alpha" | "beta" = "latest",
): Promise<boolean> {
  return Effect.runPromise(runNpmTestEffect(version, tag).pipe(Effect.provide(BunServices.layer)));
}
