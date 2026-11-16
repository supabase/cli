import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import {
  Cause,
  Clock,
  Console,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
import process from "node:process";
import {
  jsonQuote,
  ReleaseStepError,
  releaseStep,
  runCliEffect,
  verifyExpectedShellEffect,
} from "./release-shell.ts";

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

/** The local Verdaccio registry never answered its ping. */
class VerdaccioStartTimeout extends Data.TaggedError("VerdaccioStartTimeout")<{
  readonly message: string;
}> {}

type RegistryServices = FileSystem.FileSystem | Path.Path | HttpClient.HttpClient;

const registryLayer: Layer.Layer<RegistryServices> = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

/** A resource release failed after its use had already failed; `suppressed` is the use's cause. */
class DisposalSuppressedError extends Data.TaggedError("DisposalSuppressedError")<{
  readonly error: unknown;
  readonly suppressed: Cause.Cause<unknown>;
}> {}

type RegistryFailure =
  | ReleaseStepError
  | PlatformError
  | VerdaccioStartTimeout
  | Schema.SchemaError
  | DisposalSuppressedError;

/* What a facade rejects with: the original error, or a SuppressedError as `await using` builds. */
function thrownValue(error: unknown): unknown {
  if (error instanceof ReleaseStepError) return error.cause;
  if (error instanceof VerdaccioStartTimeout) return new Error(error.message);
  if (error instanceof DisposalSuppressedError) {
    return new SuppressedError(
      thrownValue(error.error),
      thrownValue(Cause.squash(error.suppressed)),
    );
  }
  if (Predicate.isTagged(error, "PlatformError") && Predicate.hasProperty(error, "cause")) {
    return error.cause ?? error;
  }
  return error;
}

/* Promise facades reject with the original thrown value. */
const runRegistry = <A>(effect: Effect.Effect<A, RegistryFailure, RegistryServices>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.catch((error) => Effect.die(thrownValue(error))),
      Effect.provide(registryLayer),
    ),
  );

/** Uses then releases a resource like `await using`: both failures surface when use and release fail. */
const usingResource = <A, B, E1, R1, E2, R2, E3, R3>(
  acquire: Effect.Effect<A, E1, R1>,
  use: (resource: A) => Effect.Effect<B, E2, R2>,
  release: (resource: A) => Effect.Effect<void, E3, R3>,
) =>
  Effect.acquireUseRelease(
    acquire,
    (resource) => Effect.exit(use(resource)),
    (resource, used) =>
      release(resource).pipe(
        Effect.mapError((error) =>
          Exit.isSuccess(used) && Exit.isFailure(used.value)
            ? new DisposalSuppressedError({ error, suppressed: used.value.cause })
            : error,
        ),
      ),
  ).pipe(Effect.flatten);

/* Reads UTF-8 text and keeps a leading byte order mark, like `readFile(path, "utf-8")`. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const readUtf8 = (fs: FileSystem.FileSystem, pathname: string) =>
  fs.readFile(pathname).pipe(Effect.map((bytes) => utf8.decode(bytes)));

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dir, "../../../..");
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodePackageIdentity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.Unknown),
      version: Schema.optional(Schema.Unknown),
    }),
  ),
);

const decodePackageName = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

/* Renders a caught platform failure as `${error}` renders its host error. */
const foreignText = (error: PlatformError) =>
  error.cause instanceof Error ? error.cause.toString() : error.toString();

const isNotFound = (error: PlatformError) => Predicate.isTagged(error.reason, "NotFound");

export function createTmpDir(prefix: string): Promise<AsyncDisposable & { path: string }> {
  return runRegistry(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix });
      return {
        path: dir,
        [Symbol.asyncDispose]: () => runRegistry(fs.remove(dir, { recursive: true })),
      };
    }),
  );
}

const spawnVerdaccio = (configPath: string) =>
  Effect.try({
    try: () =>
      Bun.spawn(["bunx", "verdaccio", "--config", configPath], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    catch: (cause) => new ReleaseStepError({ cause }),
  });

type PingState = "ready" | "pending" | "expired";

const awaitVerdaccio = Effect.fnUntraced(function* (url: string) {
  const timeout = 120_000;
  const deadline = (yield* Clock.currentTimeMillis) + timeout;
  /* Each round checks the deadline before it pings; an unready ping waits 500 ms for the next. */
  const ping = Effect.flatMap(
    Clock.currentTimeMillis,
    (now): Effect.Effect<PingState, never, HttpClient.HttpClient> =>
      now < deadline
        ? HttpClient.get(`${url}/-/ping`).pipe(
            Effect.map((res): PingState =>
              res.status >= 200 && res.status < 300 ? "ready" : "pending",
            ),
            Effect.orElseSucceed((): PingState => "pending"),
          )
        : Effect.succeed("expired"),
  );
  const state = yield* ping.pipe(
    Effect.repeat({ schedule: Schedule.spaced(500), while: (current) => current === "pending" }),
  );
  if (state === "ready") return;

  return yield* new VerdaccioStartTimeout({
    message: `Verdaccio failed to start within ${timeout / 1000}s`,
  });
});

const savePackageJsons = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const originals = new Map<string, string>();
  for (const pkg of ALL_PACKAGES) {
    const p = path.join(root, ...PACKAGE_PATHS[pkg], "package.json");
    originals.set(p, yield* readUtf8(fs, p));
  }
  return originals;
});

const restorePackageJsons = Effect.fnUntraced(function* (originals: ReadonlyMap<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  for (const [p, content] of originals) {
    yield* fs.writeFileString(p, content);
  }
});

function modeOctal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/* `FileSystem` has no `lstat`: a readable link marks a symlink, and the link's own mode is unknown. */
const describePath = Effect.fnUntraced(function* (p: string) {
  const fs = yield* FileSystem.FileSystem;
  const linkTarget = yield* fs.readLink(p).pipe(Effect.option);
  if (Option.isSome(linkTarget)) {
    return yield* fs.stat(p).pipe(
      Effect.map(
        (st) => `symlink -> ${linkTarget.value} (target ${modeOctal(st.mode)} ${st.size}B)`,
      ),
      Effect.catch((e) =>
        Effect.succeed(`symlink -> ${linkTarget.value} (target unreadable: ${foreignText(e)})`),
      ),
    );
  }
  return yield* fs.stat(p).pipe(
    Effect.map((st) => `file ${modeOctal(st.mode)} ${st.size}B`),
    Effect.catch((e) =>
      Effect.succeed(isNotFound(e) ? "MISSING" : `unstattable: ${foreignText(e)}`),
    ),
  );
});

const dumpInstalledTree = Effect.fnUntraced(function* (testDir: string, ext: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Console.log("\nInstalled tree state:");
  const interesting = [
    path.join(testDir, "node_modules", ".bin", `supabase${ext}`),
    path.join(testDir, "node_modules", "supabase", "package.json"),
    path.join(testDir, "node_modules", "supabase", "dist", "supabase.js"),
  ];
  for (const p of interesting) {
    yield* Console.log(`  ${path.relative(testDir, p)}: ${yield* describePath(p)}`);
  }

  const supabaseScope = path.join(testDir, "node_modules", "@supabase");
  const scopeEntries = yield* fs.readDirectory(supabaseScope).pipe(Effect.option);
  if (Option.isNone(scopeEntries)) {
    yield* Console.log(`  node_modules/@supabase: MISSING`);
    return;
  }
  for (const entry of scopeEntries.value.sort()) {
    const pkgDir = path.join(supabaseScope, entry);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    yield* readUtf8(fs, pkgJsonPath).pipe(
      Effect.flatMap(decodePackageIdentity),
      Effect.flatMap((pkgJson) =>
        Console.log(
          `  node_modules/@supabase/${entry}: ${String(pkgJson.name)}@${String(pkgJson.version)}`,
        ),
      ),
      Effect.catch(() =>
        Console.log(`  node_modules/@supabase/${entry}: <unreadable package.json>`),
      ),
    );
    const binDir = path.join(pkgDir, "bin");
    const binEntries = yield* fs.readDirectory(binDir).pipe(Effect.option);
    if (Option.isSome(binEntries)) {
      for (const b of binEntries.value.sort()) {
        const bp = path.join(binDir, b);
        yield* Console.log(`    bin/${b}: ${yield* describePath(bp)}`);
      }
    }
  }
});

const findPlatformBinary = Effect.fnUntraced(function* (testDir: string, ext: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabaseScope = path.join(testDir, "node_modules", "@supabase");
  const entries = yield* fs.readDirectory(supabaseScope).pipe(Effect.option);
  if (Option.isNone(entries)) {
    return null;
  }
  for (const entry of entries.value) {
    const candidate = path.join(supabaseScope, entry, "bin", `supabase${ext}`);
    const found = yield* fs.stat(candidate).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (found) return candidate;
  }
  return null;
});

const inspectVerdaccioTarball = Effect.fnUntraced(function* (storageDir: string, pkg: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pkgStorage = path.join(storageDir, "@supabase", pkg);
  const files = yield* fs.readDirectory(pkgStorage).pipe(Effect.option);
  if (Option.isNone(files)) {
    yield* Console.log(`  @supabase/${pkg}: <no tarball in verdaccio storage>`);
    return;
  }
  const tarball = files.value.find((f) => f.endsWith(".tgz"));
  if (!tarball) {
    yield* Console.log(`  @supabase/${pkg}: <no .tgz under ${pkgStorage}>`);
    return;
  }
  const tarballPath = path.join(pkgStorage, tarball);
  const listing = yield* releaseStep(() => $`tar -tvf ${tarballPath}`.text());
  // Surface only the bin entries — full listings drown the log.
  const binLines = listing
    .split("\n")
    .filter((line) => line.includes("/bin/"))
    .map((line) => `    ${line.trim()}`);
  if (binLines.length === 0) {
    yield* Console.log(`  @supabase/${pkg} (${tarball}): <no bin/ entries>`);
    return;
  }
  yield* Console.log(`  @supabase/${pkg} (${tarball}):`);
  for (const line of binLines) yield* Console.log(line);
});

const hasVerdaccioTarball = Effect.fnUntraced(function* (storageDir: string, pkg: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pkgStorage = path.join(storageDir, "@supabase", pkg);
  return yield* fs.readDirectory(pkgStorage).pipe(
    Effect.map((files) => files.some((f) => f.endsWith(".tgz"))),
    Effect.orElseSucceed(() => false),
  );
});

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return JSON.stringify(value) ?? "";
}

export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const parts = [e.stack ?? `${e.name}: ${e.message}`];
    const stdout = (e as { stdout?: unknown }).stdout;
    const stderr = (e as { stderr?: unknown }).stderr;
    if (stdout != null) parts.push(`stdout: ${outputText(stdout).trim()}`);
    if (stderr != null) parts.push(`stderr: ${outputText(stderr).trim()}`);
    return parts.join("\n");
  }
  return String(e);
}

const runNpmTestEffect = Effect.fnUntraced(function* (version: string, tag: string) {
  const root = yield* repoRoot;
  const fs = yield* FileSystem.FileSystem;
  return yield* usingResource(
    savePackageJsons(root),
    () =>
      usingResource(
        fs.makeTempDirectory({ prefix: "npm-smoke-" }),
        (tmpPath) => publishAndVerify(root, tmpPath, version, tag),
        (tmpPath) => fs.remove(tmpPath, { recursive: true }),
      ),
    restorePackageJsons,
  );
});

const publishAndVerify = Effect.fnUntraced(function* (
  root: string,
  tmpPath: string,
  version: string,
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const PORT = 4873;
  const configPath = path.join(tmpPath, "config.yaml");
  const storageDir = path.join(tmpPath, "storage");

  // Stores our published tarballs; the umbrella package's `@supabase/cli-*`
  // optional deps resolve here, while the public npm uplink stays available
  // for npm installer internals and other tooling.
  yield* fs.writeFileString(
    configPath,
    `storage: ${storageDir}
auth:
  htpasswd:
    file: ${path.join(tmpPath, "htpasswd")}
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
  // in an .npmrc (not `NPM_CONFIG_TOKEN`); write one and point npm at it via
  // `npm_config_userconfig`.
  const publishNpmrc = path.join(tmpPath, "publish.npmrc");
  yield* fs.writeFileString(publishNpmrc, `//localhost:${PORT}/:_authToken=dummy\n`);
  const publishEnv = { ...process.env, npm_config_userconfig: publishNpmrc };

  // Sync versions across all packages
  yield* Console.log(`Syncing versions to ${version}...`);
  yield* releaseStep(() =>
    $`bun ../../scripts/sync-versions.ts --version ${version}`.cwd(import.meta.dir).quiet(),
  );

  yield* Console.log("Starting local npm registry...");
  const registryUrl = `http://localhost:${PORT}`;
  return yield* Effect.acquireUseRelease(
    spawnVerdaccio(configPath),
    () =>
      awaitVerdaccio(registryUrl).pipe(
        Effect.andThen(
          verifyWithRegistry(root, tmpPath, storageDir, registryUrl, PORT, tag, publishEnv),
        ),
      ),
    (proc) => Effect.sync(() => proc.kill()),
  );
});

const verifyWithRegistry = Effect.fnUntraced(function* (
  root: string,
  tmpPath: string,
  storageDir: string,
  registryUrl: string,
  PORT: number,
  tag: string,
  publishEnv: Record<string, string | undefined>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Console.log(`Registry ready at ${registryUrl}\n`);

  const platformPackages = ALL_PACKAGES.filter((p) => p !== "cli");
  yield* Console.log("Publishing platform packages...");
  for (const pkg of platformPackages) {
    const pkgDir = path.join(root, "packages", pkg);
    const published = yield* releaseStep(() =>
      $`pnpm publish --registry ${registryUrl} --tag ${tag} --no-git-checks`
        .cwd(pkgDir)
        .env(publishEnv),
    ).pipe(
      Effect.as(true),
      Effect.catch((e) =>
        Effect.flatMap(hasVerdaccioTarball(storageDir, pkg), (present) =>
          present ? Effect.succeed(false) : Effect.fail(e),
        ),
      ),
    );
    yield* Console.log(
      published ? `  @supabase/${pkg}` : `  @supabase/${pkg} (already present in local registry)`,
    );
  }

  // Confirms `publishConfig.executableFiles` made it into the published tarball.
  yield* Console.log("\nVerdaccio tarball contents (bin entries only):");
  for (const pkg of platformPackages) {
    yield* inspectVerdaccioTarball(storageDir, pkg);
  }

  const cliDir = path.join(root, "apps", "cli");
  yield* Console.log("\nBuilding umbrella package shim...");
  yield* releaseStep(() => $`pnpm build:shim`.cwd(cliDir).quiet());

  const cliPkgJson = yield* readUtf8(fs, path.join(cliDir, "package.json")).pipe(
    Effect.flatMap(decodePackageName),
  );
  const umbrellaName: string = cliPkgJson.name;

  yield* Console.log("Publishing umbrella package...");
  yield* releaseStep(() =>
    $`pnpm publish --registry ${registryUrl} --tag ${tag} --no-git-checks`
      .cwd(cliDir)
      .env(publishEnv),
  );
  yield* Console.log(`  ${umbrellaName}\n`);

  yield* Console.log("Verdaccio umbrella tarball contents:");
  const umbrellaStorage = path.join(storageDir, umbrellaName);
  yield* Effect.gen(function* () {
    const files = yield* fs.readDirectory(umbrellaStorage);
    const tarball = files.find((f) => f.endsWith(".tgz"));
    if (tarball) {
      const listing = yield* releaseStep(() =>
        $`tar -tvf ${path.join(umbrellaStorage, tarball)}`.text(),
      );
      for (const line of listing.split("\n").filter(Boolean)) {
        yield* Console.log(`    ${line.trim()}`);
      }
    } else {
      yield* Console.log(`  <no .tgz under ${umbrellaStorage}>`);
    }
  }).pipe(Effect.catch(() => Console.log(`  <no umbrella tarball storage at ${umbrellaStorage}>`)));

  const testDir = path.join(tmpPath, "test-project");
  yield* fs.makeDirectory(testDir);
  yield* fs.writeFileString(
    path.join(testDir, "package.json"),
    yield* encodeJson({ name: "test-npm-smoke", version: "0.0.0", private: true }),
  );
  yield* fs.writeFileString(
    path.join(testDir, ".npmrc"),
    `registry=${registryUrl}\n//localhost:${PORT}/:_authToken=dummy\n`,
  );

  // Pass --registry explicitly: pnpm-set `npm_config_*` env vars can override the
  // project .npmrc and silently fetch from registry.npmjs.org instead, installing
  // the published CLI rather than the umbrella just packed. The CLI flag wins over
  // both env vars and .npmrc.
  const installSpec = tag === "latest" ? umbrellaName : `${umbrellaName}@${tag}`;
  yield* Console.log(`\nInstalling ${installSpec}...`);
  yield* releaseStep(() => $`npm install --registry ${registryUrl} ${installSpec}`.cwd(testDir));

  yield* Console.log("\nVerifying...");
  const ext = process.platform === "win32" ? ".cmd" : "";
  const binPath = path.join(testDir, "node_modules", ".bin", `supabase${ext}`);

  yield* dumpInstalledTree(testDir, ext);

  const versionResult = yield* runCliEffect(binPath, ["--version"]);
  const hasValidVersion =
    versionResult.exitCode === 0 && /^\d+\.\d+\.\d+/.test(versionResult.stdout);

  if (!hasValidVersion) {
    yield* Console.log(`\n[verify] supabase --version FAILED:`);
    yield* Console.log(`  exit=${versionResult.exitCode}`);
    yield* Console.log(`  stdout=${yield* jsonQuote(versionResult.stdout)}`);
    yield* Console.log(`  stderr=${yield* jsonQuote(versionResult.stderr)}`);

    // Isolate "shim broken" from "platform binary broken".
    const platformBin = yield* findPlatformBinary(testDir, ext);
    if (platformBin) {
      yield* Console.log(`\n[verify] retrying via platform binary: ${platformBin}`);
      const direct = yield* runCliEffect(platformBin, ["--version"]);
      yield* Console.log(`  exit=${direct.exitCode}`);
      yield* Console.log(`  stdout=${yield* jsonQuote(direct.stdout)}`);
      yield* Console.log(`  stderr=${yield* jsonQuote(direct.stderr)}`);
    } else {
      yield* Console.log(`\n[verify] no platform binary found under node_modules/@supabase/*/bin/`);
    }
  }

  const shellCheck = yield* verifyExpectedShellEffect(binPath);
  const passed = hasValidVersion && shellCheck.passed;

  yield* Console.log(
    `\n${passed ? "PASS" : "FAIL"} — supabase --version exit=${versionResult.exitCode} stdout=${yield* jsonQuote(versionResult.stdout)}`,
  );
  yield* Console.log(shellCheck.detail);

  return passed;
});

export function runNpmTest(version: string, tag = "latest"): Promise<boolean> {
  return runRegistry(runNpmTestEffect(version, tag));
}
