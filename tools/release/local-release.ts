/**
 * Builds the CLI for the current platform and publishes it to the local
 * Verdaccio registry. Never modifies any git-tracked files — all version
 * mutations happen inside a system temp directory that is deleted on exit.
 *
 * Usage:
 *   pnpm cli-release [--version 0.0.0-local.1234567890]
 *
 * Requires `pnpm local-registry` to be running in another terminal.
 * Requires Go in PATH to build the `supabase-go` sidecar.
 */

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Clock, Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import process from "node:process";
import { parseArgs } from "node:util";
import { compileOptions, stackReleaseDefine } from "../../apps/cli/scripts/compile-options.ts";

const PORT = 4873;
const REGISTRY = `http://localhost:${PORT}`;

class LocalReleaseError extends Schema.TaggedError<LocalReleaseError>()("LocalReleaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const foreignFailure = (cause: unknown) =>
  new LocalReleaseError({ message: cause instanceof Error ? cause.message : String(cause), cause });

const tryAsync = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: foreignFailure });

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
  goos: string;
  goarch: string;
};

const PLATFORM_MAP: Record<string, PlatformInfo> = {
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    platformPkg: "cli-darwin-arm64",
    ext: "",
    goos: "darwin",
    goarch: "arm64",
  },
  "darwin-x64": {
    bunTarget: "bun-darwin-x64",
    platformPkg: "cli-darwin-x64",
    ext: "",
    goos: "darwin",
    goarch: "amd64",
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    platformPkg: "cli-linux-arm64",
    ext: "",
    goos: "linux",
    goarch: "arm64",
  },
  "linux-x64": {
    bunTarget: "bun-linux-x64-baseline",
    platformPkg: "cli-linux-x64",
    ext: "",
    goos: "linux",
    goarch: "amd64",
  },
  "win32-x64": {
    bunTarget: "bun-windows-x64-baseline",
    platformPkg: "cli-windows-x64",
    ext: ".exe",
    goos: "windows",
    goarch: "amd64",
  },
  "win32-arm64": {
    bunTarget: "bun-windows-arm64",
    platformPkg: "cli-windows-arm64",
    ext: ".exe",
    goos: "windows",
    goarch: "arm64",
  },
};

const getPlatformInfo = Effect.fnUntraced(function* () {
  const key = `${process.platform}-${process.arch}`;
  const info = PLATFORM_MAP[key];
  if (!info) {
    yield* Console.error(`\nError: Unsupported platform: ${key}`);
    yield* Console.error(
      "Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64\n",
    );
    process.exit(1);
  }
  return info;
});

/* Only `AbortSignal.timeout`, so the deadline alone bounds the request and its unread response body. */
const abortAfter = (ms: number) =>
  Effect.updateService(FetchHttpClient.Fetch, (fetch) =>
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(ms) }),
      { preconnect: fetch.preconnect },
    ),
  );

const checkRegistry = Effect.fnUntraced(function* () {
  const client = yield* HttpClient.HttpClient;
  yield* client.get(`${REGISTRY}/-/ping`).pipe(
    abortAfter(3000),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.catch(() =>
      Effect.gen(function* () {
        yield* Console.error(`\nError: Local registry not responding at ${REGISTRY}`);
        yield* Console.error("Start it first with: pnpm local-registry\n");
        return process.exit(1);
      }),
    ),
  );
});

const readToken = Effect.fnUntraced(function* (tokenPath: string) {
  return yield* tryAsync(() => Bun.file(tokenPath).text()).pipe(
    Effect.map((token) => token.trim()),
    Effect.catch(() =>
      Effect.gen(function* () {
        yield* Console.error(`\nError: Auth token not found at ${tokenPath}`);
        yield* Console.error(
          "The local registry must be running before you release: pnpm local-registry\n",
        );
        return process.exit(1);
      }),
    ),
  );
});

const checkGo = Effect.fnUntraced(function* () {
  yield* tryAsync(() => $`go version`.quiet()).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        yield* Console.error("\nError: `go` not found in PATH.");
        yield* Console.error("Install Go from https://go.dev/dl/ to build the CLI.\n");
        return process.exit(1);
      }),
    ),
  );
});

const checkGoSource = Effect.fnUntraced(function* (path: Path.Path, root: string) {
  const goSource = path.join(root, "apps", "cli-go");
  const goMod = Bun.file(path.join(goSource, "go.mod"));
  if (!(yield* tryAsync(() => goMod.exists()))) {
    yield* Console.error("\nError: Go CLI source not found at apps/cli-go");
    yield* Console.error("Run: pnpm repos:install\n");
    process.exit(1);
  }
  return goSource;
});

const main = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "../..");
  const tokenPath = path.join(root, "tmp", "verdaccio-token");

  const { values } = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          version: { type: "string" },
        },
      }),
    catch: foreignFailure,
  });

  const version =
    values.version ?? `0.0.0-local.${Math.floor((yield* Clock.currentTimeMillis) / 1000)}`;

  yield* checkRegistry();
  const token = yield* readToken(tokenPath);
  const platform = yield* getPlatformInfo();

  yield* checkGo();
  const goSource = yield* checkGoSource(path, root);

  if (process.platform === "linux") {
    yield* Console.warn(
      "Note: local-release builds the glibc variant only (cli-linux-*). " +
        "The musl variant is skipped for local dev.\n",
    );
  }

  const tmpDir = yield* fs.makeTempDirectory({ prefix: "supabase-local-release-" });

  const exit = yield* Effect.gen(function* () {
    // Read once up front so log lines and the published package.json agree.
    const cliPkgJson = yield* tryAsync(() =>
      Bun.file(path.join(root, "apps", "cli", "package.json")).json(),
    );
    const umbrellaName: string = cliPkgJson.name;

    yield* Console.log(`\nBuilding ${umbrellaName}@${version} (${platform.platformPkg})...\n`);

    const tmpPlatformDir = path.join(tmpDir, platform.platformPkg);
    const tmpPlatformBinDir = path.join(tmpPlatformDir, "bin");
    yield* fs.makeDirectory(tmpPlatformBinDir, { recursive: true });

    const entrypoint = path.join(root, "apps", "cli", "src", "main.ts");
    const bunBinary = path.join(tmpPlatformBinDir, `supabase${platform.ext}`);

    yield* Console.log("[1/3] Compiling CLI binary...");
    const define = yield* tryAsync(() => stackReleaseDefine());
    const buildResult = yield* tryAsync(() =>
      Bun.build({
        entrypoints: [entrypoint],
        compile: { target: platform.bunTarget, outfile: bunBinary },
        ...compileOptions,
        define,
      }),
    );
    for (const log of buildResult.logs) {
      yield* Console.warn(log);
    }
    if (!buildResult.success) {
      return yield* new LocalReleaseError({ message: "failed to compile the CLI binary" });
    }

    {
      const goBinary = path.join(tmpPlatformBinDir, `supabase-go${platform.ext}`);
      yield* Console.log(`[2/3] Compiling Go CLI binary (${platform.goos}/${platform.goarch})...`);
      // go build must run from the Go source directory: passing an absolute path as a positional
      // arg makes Go resolve the module from CWD instead, which fails because the repo root has
      // no go.mod.
      yield* tryAsync(() =>
        $`go build -trimpath -ldflags="-s -w" -o ${goBinary} .`.cwd(goSource).env({
          ...process.env,
          GOOS: platform.goos,
          GOARCH: platform.goarch,
          CGO_ENABLED: "0",
        }),
      );
    }

    const tmpCliDir = path.join(tmpDir, "cli");
    const tmpCliDistDir = path.join(tmpCliDir, "dist");
    yield* fs.makeDirectory(tmpCliDistDir, { recursive: true });

    const shimSrc = path.join(root, "apps", "cli", "src", "shared", "cli", "bin.ts");
    const shimOut = path.join(tmpCliDistDir, "supabase.js");
    yield* Console.log("[3/3] Building Node.js shim...");
    yield* tryAsync(() => $`bun build ${shimSrc} --outfile=${shimOut} --target=node`);

    const platformPkgJson = yield* tryAsync(() =>
      Bun.file(path.join(root, "packages", platform.platformPkg, "package.json")).json(),
    );
    platformPkgJson.version = version;
    yield* tryAsync(() =>
      Bun.write(
        path.join(tmpPlatformDir, "package.json"),
        `${JSON.stringify(platformPkgJson, null, "\t")}\n`,
      ),
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
    yield* tryAsync(() =>
      Bun.write(
        path.join(tmpCliDir, "package.json"),
        `${JSON.stringify(publishPkgJson, null, "\t")}\n`,
      ),
    );

    const npmrc = [`registry=${REGISTRY}`, `//localhost:${PORT}/:_authToken=${token}`, ""].join(
      "\n",
    );
    yield* tryAsync(() => Bun.write(path.join(tmpPlatformDir, ".npmrc"), npmrc));
    yield* tryAsync(() => Bun.write(path.join(tmpCliDir, ".npmrc"), npmrc));

    yield* Console.log(
      `\nPublishing @supabase/${platform.platformPkg}@${version} to local registry...`,
    );
    // bun publish (not pnpm) for the platform binary package: pnpm normalizes tarball file modes
    // and strips the execute bit from files outside the package's `bin` field; bun publish
    // preserves modes, matching production.
    yield* tryAsync(() =>
      $`bun publish --access public --tag local --registry ${REGISTRY} --no-git-checks`.cwd(
        tmpPlatformDir,
      ),
    );

    yield* Console.log(`Publishing ${umbrellaName}@${version} to local registry...`);
    yield* tryAsync(() =>
      $`pnpm publish --access public --tag local --registry ${REGISTRY} --no-git-checks`.cwd(
        tmpCliDir,
      ),
    );

    yield* Console.log(`
✓ Published ${umbrellaName}@${version}

Test with npx:
  npx --registry ${REGISTRY} ${umbrellaName}@${version} --version

Or install globally:
  npm install -g --registry ${REGISTRY} ${umbrellaName}@${version}
  supabase --version
`);
  }).pipe(Effect.exit);
  yield* fs.remove(tmpDir, { recursive: true, force: true });
  return yield* exit;
});

await Effect.runPromise(
  main().pipe(
    /* Dies with the step's own cause, or a plain Error with its message, so the uncaught report has no `_tag` line. */
    Effect.catchTags({
      LocalReleaseError: (error) => Effect.die(error.cause ?? new Error(error.message)),
      PlatformError: (error) => Effect.die(error.cause ?? error),
    }),
    Effect.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        BunPath.layer,
        FetchHttpClient.layer,
        Layer.succeed(HttpClient.TracerPropagationEnabled, false),
      ),
    ),
  ),
);
