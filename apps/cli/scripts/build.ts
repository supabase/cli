import { $ } from "bun";
import { createHash } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Config, Console, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";
import { compileOptions, stackReleaseDefine } from "./compile-options.ts";
import { darwinBinaries, MACOS_IDENTIFIERS } from "./macos-signing.ts";

const MUSL_TARGETS = [
  {
    bunTarget: "bun-linux-arm64-musl",
    pkg: "cli-linux-arm64-musl",
    nfpmArch: "arm64",
  },
  {
    bunTarget: "bun-linux-x64-baseline-musl",
    pkg: "cli-linux-x64-musl",
    nfpmArch: "amd64",
  },
] as const;

const LINUX_PKG_FORMATS = ["deb", "rpm", "apk"] as const;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
  },
});

class BuildStepFailed extends Data.TaggedError("BuildStepFailed")<{ readonly cause: unknown }> {}

const step = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new BuildStepFailed({ cause }) });

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/* Native `JSON.parse`, so a malformed package.json fails with its own `SyntaxError`. */
const parsePackageJson = (text: string) => JSON.parse(text) as { version?: string };

const envOrEmpty = (name: string) => Config.String(name).pipe(Config.withDefault(""));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /* Concurrent jobs run as promises joined by `Promise.all`, so one failed job does not
     interrupt the others. */
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const runJob = <E extends { readonly message: string; readonly cause?: unknown }>(
    job: Effect.Effect<void, E>,
  ) => runPromise(job.pipe(Effect.catch((error) => Effect.die(thrownValue(error)))));

  const root = path.resolve(import.meta.dir, "../../..");
  const packageJsonPath = path.join(root, "apps/cli/package.json");
  const packageJsonText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    yield* fs.readFile(packageJsonPath),
  );
  const packageVersion = yield* Effect.try({
    try: () => parsePackageJson(packageJsonText),
    catch: (cause) => new BuildStepFailed({ cause }),
  });
  const version = values.version ?? packageVersion.version;
  if (!version) {
    yield* Console.error("Usage: bun apps/cli/scripts/build.ts [--version <npm-version>]");
    process.exit(1);
  }
  if (values.version === undefined) {
    yield* Console.warn(
      `[build] --version not provided; falling back to package.json version "${version}". Pass --version explicitly in release builds.`,
    );
  }

  const TARGETS = [
    {
      bunTarget: "bun-darwin-arm64",
      pkg: "cli-darwin-arm64",
      archive: `supabase_${version}_darwin_arm64.tar.gz`,
      ext: "",
    },
    {
      bunTarget: "bun-darwin-x64",
      pkg: "cli-darwin-x64",
      archive: `supabase_${version}_darwin_amd64.tar.gz`,
      ext: "",
    },
    {
      bunTarget: "bun-linux-arm64",
      pkg: "cli-linux-arm64",
      archive: `supabase_${version}_linux_arm64.tar.gz`,
      nfpmArch: "arm64",
      ext: "",
    },
    {
      bunTarget: "bun-linux-x64-baseline",
      pkg: "cli-linux-x64",
      archive: `supabase_${version}_linux_amd64.tar.gz`,
      nfpmArch: "amd64",
      ext: "",
    },
    {
      bunTarget: "bun-windows-x64-baseline",
      pkg: "cli-windows-x64",
      archive: `supabase_${version}_windows_amd64.zip`,
      ext: ".exe",
    },
    {
      bunTarget: "bun-windows-arm64",
      pkg: "cli-windows-arm64",
      archive: `supabase_${version}_windows_arm64.zip`,
      ext: ".exe",
    },
  ] as const;

  const entrypoint = path.join(root, "apps/cli/src/main.ts");
  const distDir = path.join(root, "dist");
  const goSource = path.resolve(root, "apps/cli-go");
  const buildDefines = {
    ...(yield* step(() => stackReleaseDefine())),
    SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: yield* encodeJson(yield* bundleServeMainTemplate()),
    SUPABASE_CLI_POSTHOG_KEY: yield* encodeJson(yield* envOrEmpty("POSTHOG_API_KEY")),
    SUPABASE_CLI_POSTHOG_HOST: yield* encodeJson(yield* envOrEmpty("POSTHOG_ENDPOINT")),
    // Skips msgpackr's startup probe for its native addon at the build host's store path, which
    // on macOS goes through the automounter and can hang every command (supabase/cli#6771).
    "process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED": yield* encodeJson("true"),
  };

  type BunTarget = (typeof TARGETS)[number]["bunTarget"];

  const GO_TARGETS: Record<BunTarget, { goos: string; goarch: string }> = {
    "bun-darwin-arm64": { goos: "darwin", goarch: "arm64" },
    "bun-darwin-x64": { goos: "darwin", goarch: "amd64" },
    "bun-linux-arm64": { goos: "linux", goarch: "arm64" },
    "bun-linux-x64-baseline": { goos: "linux", goarch: "amd64" },
    "bun-windows-x64-baseline": { goos: "windows", goarch: "amd64" },
    "bun-windows-arm64": { goos: "windows", goarch: "arm64" },
  };

  type SignMode = "adhoc" | "off";

  const runBunBuild = Effect.fnUntraced(function* (config: Bun.BuildConfig) {
    const result = yield* step(() =>
      Bun.build({
        ...config,
        ...compileOptions,
        plugins: config.plugins ?? [],
      }),
    );
    for (const log of result.logs) {
      yield* Console.warn(log);
    }
  });

  const buildTarget = Effect.fnUntraced(function* (target: (typeof TARGETS)[number]) {
    const binDir = path.join(root, "packages", target.pkg, "bin");
    yield* fs.makeDirectory(binDir, { recursive: true });

    const outfile = path.join(binDir, `supabase${target.ext}`);

    yield* Console.log(`[${target.pkg}] Compiling Bun CLI...`);
    yield* runBunBuild({
      entrypoints: [entrypoint],
      compile: { target: target.bunTarget, outfile },
      define: {
        ...buildDefines,
        SUPABASE_CLI_VERSION: yield* encodeJson(version),
      },
    });
    yield* Console.log(`[${target.pkg}] Done.`);
  });

  const buildGoTarget = Effect.fnUntraced(function* (target: (typeof TARGETS)[number]) {
    const binDir = path.join(root, "packages", target.pkg, "bin");
    yield* fs.makeDirectory(binDir, { recursive: true });

    const { goos, goarch } = GO_TARGETS[target.bunTarget];
    const outfile = path.join(binDir, `supabase-go${target.ext}`);

    yield* Console.log(`[${target.pkg}] Compiling Go CLI (${goos}/${goarch})...`);
    const ldflagParts = [
      "-s",
      "-w",
      `-X github.com/supabase/cli/internal/utils.Version=${version}`,
    ];
    const { SENTRY_DSN, POSTHOG_API_KEY, POSTHOG_ENDPOINT } = process.env;
    if (SENTRY_DSN) {
      ldflagParts.push(`-X github.com/supabase/cli/internal/utils.SentryDsn=${SENTRY_DSN}`);
    }
    if (POSTHOG_API_KEY) {
      ldflagParts.push(
        `-X github.com/supabase/cli/internal/utils.PostHogAPIKey=${POSTHOG_API_KEY}`,
      );
    }
    if (POSTHOG_ENDPOINT) {
      ldflagParts.push(
        `-X github.com/supabase/cli/internal/utils.PostHogEndpoint=${POSTHOG_ENDPOINT}`,
      );
    }
    const goLdflags = ldflagParts.join(" ");
    yield* step(() =>
      $`go build -trimpath -ldflags=${goLdflags} -o ${outfile} .`.cwd(goSource).env({
        ...process.env,
        GOOS: goos,
        GOARCH: goarch,
        CGO_ENABLED: "0",
      }),
    );
    yield* Console.log(`[${target.pkg}] Go binary done.`);
  });

  /**
   * Decides how to sign macOS binaries. `rcodesign` signs Mach-O binaries from Linux, so signing
   * runs inline on this build runner; falls back to "off" with a warning unless
   * SUPABASE_CLI_REQUIRE_SIGNING=1, which fails the build when the tool is missing.
   */
  const resolveSignMode = Effect.fnUntraced(function* () {
    if (Bun.which("rcodesign")) {
      return "adhoc";
    }
    if ((yield* envOrEmpty("SUPABASE_CLI_REQUIRE_SIGNING")) === "1") {
      yield* Console.error(
        "rcodesign not found but SUPABASE_CLI_REQUIRE_SIGNING=1 is set. Release builds " +
          "must sign the macOS binaries. Install rcodesign (https://github.com/indygreg/apple-platform-rs).",
      );
      process.exit(1);
    }
    yield* Console.warn(
      "WARNING: rcodesign not found — macOS binaries will keep Bun's linker-signed ad-hoc " +
        "signature, which macOS 26+ SIGKILLs at launch (CLI-1621). Install rcodesign to " +
        "produce runnable macOS binaries locally.",
    );
    return "off";
  });

  const signDarwinBinaries = Effect.fnUntraced(function* (mode: SignMode) {
    if (mode === "off") {
      return;
    }

    const darwinTargets = TARGETS.filter((target) => target.bunTarget.startsWith("bun-darwin"));
    const binaries = darwinBinaries();

    for (const target of darwinTargets) {
      const binDir = path.join(root, "packages", target.pkg, "bin");

      for (const binary of binaries) {
        const binPath = path.join(binDir, binary);
        const identifier = MACOS_IDENTIFIERS[binary];

        yield* Console.log(`[${target.pkg}] Ad-hoc signing ${binary} (${identifier})...`);
        // No key material, so rcodesign produces an ad-hoc signature, equivalent to
        // `codesign --sign -`, replacing Bun/Go's linker-signed one.
        yield* step(() => $`rcodesign sign --binary-identifier ${identifier} ${binPath}`);

        // Matches the identifier's whole value, so the SFE's `com.supabase.cli` can't satisfy
        // the sidecar's `com.supabase.cli-go`, and confirms the signature is no longer linker-signed.
        const info = yield* step(() => $`rcodesign print-signature-info ${binPath}`.text());
        const signedIdentifier = info.match(/^\s*identifier:\s*(\S+)\s*$/m)?.[1];
        if (signedIdentifier !== identifier) {
          throw new Error(
            `Signing ${binPath} failed: expected identifier ${identifier}, got ${signedIdentifier ?? "none"}`,
          );
        }
        if (info.includes("LINKER_SIGNED")) {
          throw new Error(`Signing ${binPath} failed: signature is still linker-signed`);
        }
      }
    }
  });

  const archiveTarget = Effect.fnUntraced(function* (target: (typeof TARGETS)[number]) {
    const binDir = path.join(root, "packages", target.pkg, "bin");
    const archivePath = path.join(distDir, target.archive);

    yield* Console.log(`[${target.pkg}] Creating archive ${target.archive}...`);

    if (target.archive.endsWith(".zip")) {
      const files = [
        path.join(binDir, `supabase${target.ext}`),
        path.join(binDir, `supabase-go${target.ext}`),
      ];
      yield* step(() => $`zip -j ${archivePath} ${files}`);

      // setup-cli and other download clients always fetch a .tar.gz, even on Windows, so
      // publish one alongside the .zip. See #5257.
      const tarArchive = target.archive.replace(/\.zip$/, ".tar.gz");
      const tarArchivePath = path.join(distDir, tarArchive);
      const tarFiles = [`supabase${target.ext}`, `supabase-go${target.ext}`];
      yield* Console.log(`[${target.pkg}] Creating archive ${tarArchive}...`);
      yield* step(() => $`tar -czf ${tarArchivePath} -C ${binDir} ${tarFiles}`);
    } else {
      const files = [`supabase${target.ext}`, `supabase-go${target.ext}`];
      yield* step(() => $`tar -czf ${archivePath} -C ${binDir} ${files}`);
    }
  });

  const buildMuslBinaries = Effect.fnUntraced(function* () {
    yield* step(() =>
      Promise.all(
        MUSL_TARGETS.map((target) =>
          runJob(
            Effect.gen(function* () {
              const binDir = path.join(root, "packages", target.pkg, "bin");
              yield* fs.makeDirectory(binDir, { recursive: true });

              const outfile = path.join(binDir, "supabase");
              yield* Console.log(`[${target.pkg}] Compiling Bun CLI (musl)...`);
              yield* runBunBuild({
                entrypoints: [entrypoint],
                compile: { target: target.bunTarget, outfile },
                define: {
                  ...buildDefines,
                  SUPABASE_CLI_VERSION: yield* encodeJson(version),
                },
              });

              // The Go binary is fully static (CGO_ENABLED=0), so the glibc build works on musl too;
              // copy it into the musl package so GoProxy finds supabase-go there.
              const glibcTarget = TARGETS.find(
                (candidate) => "nfpmArch" in candidate && candidate.nfpmArch === target.nfpmArch,
              );
              if (!glibcTarget) {
                throw new Error(`No glibc Linux target found for musl arch ${target.nfpmArch}`);
              }
              const src = path.join(root, "packages", glibcTarget.pkg, "bin", "supabase-go");
              const dst = path.join(binDir, "supabase-go");
              yield* Console.log(`[${target.pkg}] Copying Go binary from ${glibcTarget.pkg}...`);
              yield* fs.copyFile(src, dst);

              yield* Console.log(`[${target.pkg}] Done.`);
            }),
          ),
        ),
      ),
    );
  });

  const buildLinuxPackages = Effect.fnUntraced(function* (version: string) {
    const linuxTargets = TARGETS.filter((target) => "nfpmArch" in target);
    const jobs: Promise<void>[] = [];

    for (const target of linuxTargets) {
      const glibcBinDir = path.join(root, "packages", target.pkg, "bin");
      const muslTarget = MUSL_TARGETS.find((candidate) => candidate.nfpmArch === target.nfpmArch)!;
      const muslBinDir = path.join(root, "packages", muslTarget.pkg, "bin");

      for (const fmt of LINUX_PKG_FORMATS) {
        const outFile = `supabase_${version}_linux_${target.nfpmArch}.${fmt}`;
        const outPath = path.join(distDir, outFile);
        const binDir = fmt === "apk" ? muslBinDir : glibcBinDir;

        // The Go binary is fully static, so apk (musl) still references supabase-go
        // from the glibc dir where it was built.
        const contents: Array<{ src: string; dst: string }> = [
          { src: path.join(binDir, "supabase"), dst: "/usr/bin/supabase" },
          { src: path.join(glibcBinDir, "supabase-go"), dst: "/usr/bin/supabase-go" },
        ];

        const nfpmConfig: Record<string, unknown> = {
          name: "supabase",
          arch: target.nfpmArch,
          platform: "linux",
          version,
          maintainer: "Supabase <support@supabase.io>",
          description: "Supabase CLI",
          homepage: "https://supabase.com",
          license: "MIT",
          contents,
        };

        if (fmt === "apk") {
          nfpmConfig.depends = ["libstdc++", "libgcc"];
        }

        const configPath = path.join(distDir, `nfpm-${target.nfpmArch}-${fmt}.yaml`);
        yield* fs.writeFileString(configPath, yield* encodeJson(nfpmConfig));

        jobs.push(
          runJob(
            Effect.gen(function* () {
              yield* Console.log(`[${target.pkg}] Creating ${outFile}...`);
              yield* step(
                () => $`nfpm package --config ${configPath} --packager ${fmt} --target ${outPath}`,
              );
              yield* fs.remove(configPath);
            }),
          ),
        );
      }
    }

    yield* step(() => Promise.all(jobs));
  });

  const generateChecksums = Effect.fnUntraced(function* () {
    const lines: string[] = [];

    for (const target of TARGETS) {
      const archivePath = path.join(distDir, target.archive);
      const data = yield* fs.readFile(archivePath);
      const hash = createHash("sha256").update(data).digest("hex");
      lines.push(`${hash}  ${target.archive}`);

      if (target.archive.endsWith(".zip")) {
        const tarArchive = target.archive.replace(/\.zip$/, ".tar.gz");
        const tarData = yield* fs.readFile(path.join(distDir, tarArchive));
        const tarHash = createHash("sha256").update(tarData).digest("hex");
        lines.push(`${tarHash}  ${tarArchive}`);
      }
    }

    const linuxTargets = TARGETS.filter((target) => "nfpmArch" in target);
    for (const target of linuxTargets) {
      for (const fmt of LINUX_PKG_FORMATS) {
        const filename = `supabase_${version}_linux_${target.nfpmArch}.${fmt}`;
        const data = yield* fs.readFile(path.join(distDir, filename));
        const hash = createHash("sha256").update(data).digest("hex");
        lines.push(`${hash}  ${filename}`);
      }
    }

    const checksumsPath = path.join(distDir, "checksums.txt");
    yield* fs.writeFileString(checksumsPath, `${lines.join("\n")}\n`);
    yield* Console.log("Checksums written to dist/checksums.txt");
  });

  yield* Console.log(`Building the CLI for ${TARGETS.length} targets...\n`);

  yield* step(() => Promise.all(TARGETS.map((target) => runJob(buildTarget(target)))));

  yield* Console.log("\nCompiling Go CLI for all targets...");
  yield* step(() => Promise.all(TARGETS.map((target) => runJob(buildGoTarget(target)))));

  // Must run before archiveTarget / buildLinuxPackages / generateChecksums so every
  // distribution channel ships the signed bytes.
  const signMode = yield* resolveSignMode();
  yield* Console.log(`\nSigning macOS binaries (mode: ${signMode})...`);
  yield* signDarwinBinaries(signMode);

  yield* fs.makeDirectory(distDir, { recursive: true });
  yield* step(() => Promise.all(TARGETS.map((target) => runJob(archiveTarget(target)))));

  yield* buildMuslBinaries();
  yield* buildLinuxPackages(version);
  yield* generateChecksums();

  yield* Console.log("\nAll targets built successfully.");
});

function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.catch((error) => Effect.die(thrownValue(error))),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);
