import { stripVTControlCharacters } from "node:util";

import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect";
import * as PlatformError from "effect/PlatformError";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";

import {
  type LegacyUpgradeNoticeDeps,
  LegacyUpgradeNoticeError,
  legacyFormatUpgradeNotice,
  legacyIsNewerCliVersion,
  legacyRunUpgradeNotice,
  legacyUpdateNotifierDisabled,
  legacyUpgradeNoticeHook,
} from "./legacy-upgrade-notice.ts";

describe("legacyUpdateNotifierDisabled", () => {
  it.each(["1", "t", "T", "TRUE", "true", "True"])("suppresses for ParseBool-true %j", (value) => {
    expect(legacyUpdateNotifierDisabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "FALSE", "f", "garbage", "yes", "on"])(
    "keeps the notifier enabled for %j",
    (value) => {
      expect(legacyUpdateNotifierDisabled(value)).toBe(false);
    },
  );
});

describe("legacyIsNewerCliVersion", () => {
  it.each([
    ["v2.114.0", "2.113.0", true],
    ["v2.113.1", "2.113.0", true],
    ["v3.0.0", "2.999.999", true],
    ["v2.113.0", "2.113.0", false],
    ["v2.112.9", "2.113.0", false],
    ["v2.114.0", "2.114.0-beta.1", true],
    ["v2.114.0-beta.1", "2.114.0", false],
    ["", "2.113.0", false],
    ["not-a-version", "2.113.0", false],
    // x/mod/semver requires the leading v: a bare tag is invalid to Go.
    ["2.114.0", "2.113.0", false],
    ["v2.114.0", "0.0.0-dev", true],
    ["v2.114.0", "", true],
    ["v2.114.0-beta.10", "2.114.0-beta.9", true],
    ["v2.114.0-beta.9", "2.114.0-beta.10", false],
    ["v2.114.0-rc.1", "2.114.0-beta.2", true],
    ["v2.114.0-beta.2", "2.114.0-beta.11", false],
    ["v3", "2.999.999", true],
    ["v2.114", "2.113.999", true],
    ["v2.114.0+new", "2.114.0+old", false],
    ["v999999999999999999999999.0.0", "999999999999999999999998.0.0", true],
    ["v02.114.0", "2.113.0", false],
    ["v2.114.00", "2.113.0", false],
    ["v2.114.0-01", "2.113.0", false],
    ["v2.114.0-alpha..1", "2.113.0", false],
  ])("latest %j vs current %j -> %s", (latest, current, expected) => {
    expect(legacyIsNewerCliVersion(latest, current)).toBe(expected);
  });
});

describe("legacyFormatUpgradeNotice", () => {
  it("matches the Go CLI's message bytes modulo styling", () => {
    expect(stripVTControlCharacters(legacyFormatUpgradeNotice("v2.114.0", "2.113.0"))).toBe(
      "A new version of Supabase CLI is available: v2.114.0 (currently installed v2.113.0)\n" +
        "We recommend updating regularly for new features and bug fixes: " +
        "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli",
    );
  });
});

describe("legacyRunUpgradeNotice", () => {
  const tempRoot = useLegacyTempWorkdir("supabase-legacy-upgrade-notice-");
  const pathService = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
  const join = (...segments: ReadonlyArray<string>): string => pathService.join(...segments);
  const runNotice = (
    ctx: ReturnType<typeof setup>,
    deps: LegacyUpgradeNoticeDeps = ctx.deps,
  ): Effect.Effect<
    void,
    PlatformError.PlatformError | LegacyUpgradeNoticeError,
    FileSystem.FileSystem | Path.Path
  > => ctx.fixtures.pipe(Effect.andThen(legacyRunUpgradeNotice(deps)));
  const readText = (file: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(file);
    });
  const readTextOption = (file: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(file).pipe(Effect.option);
    });
  const makeDirectory = (directory: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(directory, { recursive: true });
    });

  const fixtureFs = (
    workdir: string,
    opts: {
      readonly project?: boolean;
      readonly cacheContent?: string;
      readonly cacheAgeMs?: number;
    },
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(workdir, { recursive: true });
      if (opts.project !== false) {
        yield* fs.makeDirectory(join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(workdir, "supabase", "config.toml"),
          'project_id = "demo"\n',
        );
      }
      if (opts.cacheContent !== undefined) {
        const tempDir = join(workdir, "supabase", ".temp");
        yield* fs.makeDirectory(tempDir, { recursive: true });
        const cacheFile = join(tempDir, "cli-latest");
        const existing = yield* fs.readFileString(cacheFile).pipe(Effect.option);
        if (Option.isNone(existing)) {
          yield* fs.writeFileString(cacheFile, opts.cacheContent);
          if (opts.cacheAgeMs !== undefined) {
            const then = DateTime.toDate(DateTime.makeUnsafe(0 - opts.cacheAgeMs));
            yield* fs.utimes(cacheFile, then, then);
          }
        }
      }
    });

  let workdir: string;
  let contextIndex = 0;

  function setup(opts: {
    readonly env?: Record<string, string>;
    readonly args?: ReadonlyArray<string>;
    readonly latestTag?: string;
    readonly fetchFails?: boolean;
    readonly project?: boolean;
    readonly cacheContent?: string;
    readonly cacheAgeMs?: number;
    readonly currentVersion?: string;
  }) {
    workdir = join(tempRoot.current, `case-${contextIndex++}`);
    let fetchCalls = 0;
    const stderr: Array<string> = [];
    const deps: LegacyUpgradeNoticeDeps = {
      env: opts.env ?? {},
      args: opts.args ?? ["db", "start"],
      cwd: workdir,
      currentVersion: opts.currentVersion ?? "2.113.0",
      now: () => 0,
      fetchLatestTag: Effect.suspend(() => {
        fetchCalls += 1;
        return opts.fetchFails === true
          ? Effect.fail(new LegacyUpgradeNoticeError({ message: "offline" }))
          : Effect.succeed(opts.latestTag ?? "v2.114.0");
      }),
      writeStderr: (text) => {
        stderr.push(text);
      },
    };
    return {
      deps,
      get fetchCalls() {
        return fetchCalls;
      },
      get stderr() {
        return stripVTControlCharacters(stderr.join(""));
      },
      cachePath: join(workdir, "supabase", ".temp", "cli-latest"),
      fixtures: fixtureFs(workdir, opts),
    };
  }

  it.effect("prints the notice and caches the tag when a newer release exists", () =>
    Effect.gen(function* () {
      const ctx = setup({});
      yield* runNotice(ctx);
      expect(ctx.fetchCalls).toBe(1);
      expect(ctx.stderr).toContain("A new version of Supabase CLI is available: v2.114.0");
      expect(yield* readText(ctx.cachePath)).toBe("v2.114.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("SUPABASE_NO_UPDATE_NOTIFIER=1 skips the fetch and the notice entirely", () =>
    Effect.gen(function* () {
      const ctx = setup({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "1" } });
      yield* runNotice(ctx);
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("stays silent when already on the latest release", () =>
    Effect.gen(function* () {
      const ctx = setup({ latestTag: "v2.113.0" });
      yield* runNotice(ctx);
      expect(ctx.stderr).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reads a fresh cache instead of fetching", () =>
    Effect.gen(function* () {
      const ctx = setup({ cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
      yield* runNotice(ctx);
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps a cache fresh at the exact ten-hour boundary", () =>
    Effect.gen(function* () {
      const ctx = setup({ cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
      yield* ctx.fixtures;
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(ctx.cachePath);
      const now = Option.isSome(info.mtime) ? info.mtime.value.getTime() + 10 * 60 * 60 * 1000 : 0;
      yield* runNotice(ctx, { ...ctx.deps, now: () => now });
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refetches when the cache is older than ten hours", () =>
    Effect.gen(function* () {
      const ctx = setup({ cacheContent: "v2.115.0", cacheAgeMs: 11 * 60 * 60 * 1000 });
      yield* runNotice(ctx);
      expect(ctx.fetchCalls).toBe(1);
      expect(yield* readText(ctx.cachePath)).toBe("v2.114.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("--version forces a fetch through a fresh cache", () =>
    Effect.gen(function* () {
      const ctx = setup({ args: ["--version"], cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
      yield* runNotice(ctx);
      expect(ctx.fetchCalls).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "SUPABASE_DEBUG surfaces fetch failures without the --debug flag, like viper's AutomaticEnv",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ fetchFails: true, project: false, env: { SUPABASE_DEBUG: "1" } });
        yield* runNotice(ctx);
        expect(ctx.stderr).toContain("Failed to fetch latest release");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "--debug=true surfaces fetch failures and --debug=false silences them, like pflag",
    () =>
      Effect.gen(function* () {
        const on = setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--debug=true"],
        });
        yield* runNotice(on);
        expect(on.stderr).toContain("Failed to fetch latest release");

        // A set flag (`--debug=false`) beats SUPABASE_DEBUG, like viper.
        const off = setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--debug=false"],
          env: { SUPABASE_DEBUG: "1" },
        });
        yield* runNotice(off);
        expect(off.stderr).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a built-in ignores SUPABASE_DEBUG but still honors the --debug flag, like cobra's init order",
    () =>
      Effect.gen(function* () {
        // AutomaticEnv binds inside cobra.OnInitialize, which --help/--version
        // never reach; BindPFlags runs at package init, so the flag still reads.
        const viaEnv = setup({
          fetchFails: true,
          project: false,
          env: { SUPABASE_DEBUG: "1" },
          args: ["--version"],
        });
        yield* runNotice(viaEnv);
        expect(viaEnv.stderr).toBe("");

        const viaFlag = setup({ fetchFails: true, project: false, args: ["--version", "--debug"] });
        yield* runNotice(viaFlag);
        expect(viaFlag.stderr).toContain("Failed to fetch latest release: offline");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("a failed fetch stays silent and writes an empty cache to back off", () =>
    Effect.gen(function* () {
      const ctx = setup({ fetchFails: true });
      yield* runNotice(ctx);
      expect(ctx.stderr).toBe("");
      expect(yield* readText(ctx.cachePath)).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a failed fetch surfaces its error under --debug when there is no project to back off in",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ fetchFails: true, project: false, args: ["db", "start", "--debug"] });
        yield* runNotice(ctx);
        expect(ctx.stderr).toContain("Failed to fetch latest release");
        expect(ctx.stderr).not.toContain("A new version of Supabase CLI is available");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a --debug operand after -- or consumed by a value flag is not the debug flag, like pflag",
    () =>
      Effect.gen(function* () {
        const afterTerminator = setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--", "--debug"],
        });
        yield* runNotice(afterTerminator);
        expect(afterTerminator.stderr).toBe("");

        const consumedValue = setup({
          fetchFails: true,
          project: false,
          args: ["--profile", "--debug", "db", "start"],
        });
        yield* runNotice(consumedValue);
        expect(consumedValue.stderr).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    "a cache write failure reports the stable cli-latest path",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ args: ["db", "start", "--debug"] });
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        const tempDir = join(workdir, "supabase", ".temp");
        yield* makeDirectory(tempDir);
        yield* fs.chmod(tempDir, 0o555);
        yield* runNotice(ctx);
        yield* fs.chmod(tempDir, 0o755);
        expect(ctx.stderr).toContain("failed to write file");
        expect(ctx.stderr).toContain("cli-latest");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(process.platform === "win32")(
    "creates the cache directory and file with Go-compatible modes",
    () =>
      Effect.gen(function* () {
        const ctx = setup({});
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        const previousUmask = process.umask(0);
        yield* runNotice(ctx).pipe(
          Effect.ensuring(Effect.sync(() => process.umask(previousUmask))),
        );
        const tempInfo = yield* fs.stat(join(workdir, "supabase", ".temp"));
        const cacheInfo = yield* fs.stat(ctx.cachePath);
        expect(tempInfo.mode & 0o777).toBe(0o755);
        expect(cacheInfo.mode & 0o777).toBe(0o644);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(process.platform === "win32")(
    "updates a writable cache without requiring write access to its directory",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ cacheContent: "v2.115.0", cacheAgeMs: 11 * 60 * 60 * 1000 });
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        const tempDir = join(workdir, "supabase", ".temp");
        yield* fs.chmod(tempDir, 0o555);
        yield* runNotice(ctx).pipe(Effect.ensuring(fs.chmod(tempDir, 0o755).pipe(Effect.ignore)));
        expect(ctx.stderr).not.toContain("failed to write file");
        expect(yield* readText(ctx.cachePath)).toBe("v2.114.0");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a --debug consumed by the leaf command's own value flag is not the debug flag, like pflag",
    () =>
      Effect.gen(function* () {
        // `login --name --debug`: pflag hands `--debug` to `--name`. The real CLI
        // passes the resolved leaf's value-flag predicate into the hook.
        const ctx = setup({
          fetchFails: true,
          project: false,
          args: ["login", "--name", "--debug"],
        });
        yield* runNotice(ctx, {
          ...ctx.deps,
          isValueTakingFlagToken: (token) => token === "--name",
        });
        expect(ctx.stderr).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("a false root version flag before a leaf runs the normal path, workdir included", () =>
    Effect.gen(function* () {
      // `--version=false <leaf>`: cobra parses false, runs the leaf with
      // `ChangeWorkDir` — but pflag still marks the flag changed, forcing the
      // fetch. Only the built-in classification must not trigger.
      const ctx = setup({ project: false });
      const flagged = join(workdir, "flagged");
      yield* makeDirectory(join(flagged, "supabase"));
      yield* runNotice(ctx, {
        ...ctx.deps,
        args: ["--workdir", flagged, "--version=false", "db", "push"],
      });
      expect(yield* readText(join(flagged, "supabase", ".temp", "cli-latest"))).toBe("v2.114.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    "an existing read-only cache file fails the backoff write, like Go's direct open",
    () =>
      Effect.gen(function* () {
        const ctx = setup({
          args: ["db", "start", "--debug"],
          cacheContent: "v2.115.0",
          cacheAgeMs: 11 * 60 * 60 * 1000,
        });
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.chmod(ctx.cachePath, 0o444);
        yield* runNotice(ctx);
        yield* fs.chmod(ctx.cachePath, 0o644);
        expect(ctx.stderr).toContain("failed to write file");
        // The stale cache survives, exactly like Go's failed open.
        expect(yield* readText(ctx.cachePath)).toBe("v2.115.0");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "project dotenv SUPABASE_DEBUG surfaces diagnostics, like godotenv before the Execute tail",
    () =>
      Effect.gen(function* () {
        // A symlinked .temp disables the backoff write, so the fetch error is what
        // remains to log — and the debug gate resolves through the project chain.
        const ctx = setup({ fetchFails: true });
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(join(workdir, "supabase", ".env"), "SUPABASE_DEBUG=1\n");
        yield* makeDirectory(join(workdir, "elsewhere"));
        yield* fs.symlink(join(workdir, "elsewhere"), join(workdir, "supabase", ".temp"));
        yield* runNotice(ctx);
        expect(ctx.stderr).toContain("Failed to fetch latest release");

        // A shell env that defines the key blocks the chain, like os.Environ.
        const blocked = setup({ fetchFails: true, env: { SUPABASE_DEBUG: "" } });
        yield* blocked.fixtures;
        yield* fs.writeFileString(join(workdir, "supabase", ".env"), "SUPABASE_DEBUG=1\n");
        yield* makeDirectory(join(workdir, "elsewhere"));
        yield* fs.symlink(join(workdir, "elsewhere"), join(workdir, "supabase", ".temp"));
        yield* runNotice(blocked);
        expect(blocked.stderr).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a failed fetch inside a project stays silent under --debug, matching Go's backoff",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ fetchFails: true, args: ["db", "start", "--debug"] });
        yield* runNotice(ctx);
        // The empty-cache backoff write succeeds, so Go emits no debug line.
        expect(ctx.stderr).toBe("");
        expect(yield* readText(ctx.cachePath)).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("outside a project the notice still prints but nothing is cached", () =>
    Effect.gen(function* () {
      const ctx = setup({ project: false });
      yield* runNotice(ctx);
      expect(ctx.stderr).toContain("v2.114.0");
      expect(Option.isNone(yield* readTextOption(ctx.cachePath))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "resolves the cache under --workdir, then SUPABASE_WORKDIR, ahead of the cwd walk",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ project: false });
        const flagDir = join(workdir, "flag-project");
        const envDir = join(workdir, "env-project");
        for (const dir of [flagDir, envDir]) {
          yield* makeDirectory(join(dir, "supabase"));
        }
        const flagCtx = { ...ctx.deps, args: ["db", "start", "--workdir", flagDir] };
        yield* runNotice(ctx, flagCtx);
        expect(yield* readText(join(flagDir, "supabase", ".temp", "cli-latest"))).toBe("v2.114.0");

        const lastWinsCtx = {
          ...ctx.deps,
          args: ["db", "start", "--workdir", join(workdir, "ignored"), `--workdir=${flagDir}`],
        };
        yield* runNotice(ctx, lastWinsCtx);
        expect(yield* readText(join(flagDir, "supabase", ".temp", "cli-latest"))).toBe("v2.114.0");

        const envCtx = { ...ctx.deps, env: { SUPABASE_WORKDIR: envDir } };
        yield* runNotice(ctx, envCtx);
        expect(yield* readText(join(envDir, "supabase", ".temp", "cli-latest"))).toBe("v2.114.0");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "uses the successful command's resolved working directory without re-resolving flags",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ project: false, args: ["bootstrap", "--workdir", "prompted"] });
        const prompted = join(workdir, "prompted");
        yield* makeDirectory(join(prompted, "supabase"));

        yield* runNotice(ctx, { ...ctx.deps, resolvedCwd: prompted });

        expect(yield* readText(join(prompted, "supabase", ".temp", "cli-latest"))).toBe("v2.114.0");
        expect(Option.isNone(yield* readTextOption(ctx.cachePath))).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "an explicit empty --workdir beats SUPABASE_WORKDIR and falls back to the walk, like viper",
    () =>
      Effect.gen(function* () {
        const ctx = setup({});
        const envDir = join(workdir, "env-project");
        yield* makeDirectory(join(envDir, "supabase"));
        yield* runNotice(ctx, {
          ...ctx.deps,
          args: ["db", "start", "--workdir="],
          env: { SUPABASE_WORKDIR: envDir },
        });
        // The set-but-empty flag suppresses the env, so the walk finds the real project.
        expect(yield* readText(ctx.cachePath)).toBe("v2.114.0");
        expect(
          Option.isNone(yield* readTextOption(join(envDir, "supabase", ".temp", "cli-latest"))),
        ).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a project dotenv SUPABASE_NO_UPDATE_NOTIFIER opt-out suppresses the notice, like godotenv",
    () =>
      Effect.gen(function* () {
        const ctx = setup({});
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          join(workdir, "supabase", ".env"),
          "SUPABASE_NO_UPDATE_NOTIFIER=1\n",
        );
        yield* runNotice(ctx);
        expect(ctx.fetchCalls).toBe(0);
        expect(ctx.stderr).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a shell env that defines the key beats the project dotenv, like godotenv's no-override",
    () =>
      Effect.gen(function* () {
        // Defined-but-unparseable in the shell env: Go's os.Environ presence stops
        // godotenv from overriding, and ParseBool("") keeps the notifier on.
        const ctx = setup({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "" } });
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          join(workdir, "supabase", ".env"),
          "SUPABASE_NO_UPDATE_NOTIFIER=1\n",
        );
        yield* runNotice(ctx);
        expect(ctx.stderr).toContain("A new version of Supabase CLI is available");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "--help ignores the project dotenv opt-out — Go never loads config for the built-ins",
    () =>
      Effect.gen(function* () {
        const ctx = setup({ args: ["--help"] });
        yield* ctx.fixtures;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          join(workdir, "supabase", ".env"),
          "SUPABASE_NO_UPDATE_NOTIFIER=1\n",
        );
        yield* runNotice(ctx);
        expect(ctx.stderr).toContain("A new version of Supabase CLI is available");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("resolves --help and --version against the bare cwd, ignoring --workdir, like Go", () =>
    Effect.gen(function* () {
      // Go serves the built-ins without `ChangeWorkDir`, so the flagged project
      // must not gain a cache entry; the caller's cwd (no supabase/) writes none.
      const ctx = setup({ project: false });
      const flagged = join(workdir, "flagged");
      yield* makeDirectory(join(flagged, "supabase"));
      for (const args of [
        ["--workdir", flagged, "--help"],
        ["--workdir", flagged, "--version"],
        ["--workdir", flagged, "--help=true"],
        ["branches", "--workdir", flagged, "-h=1"],
        ["--workdir", flagged, "--version=true"],
        ["branches", "--workdir", flagged, "--help=true", "--help=false"],
        ["--workdir", flagged, "--version", "true"],
      ]) {
        yield* runNotice(ctx, { ...ctx.deps, args });
      }
      expect(
        Option.isNone(yield* readTextOption(join(flagged, "supabase", ".temp", "cli-latest"))),
      ).toBe(true);
      // A subcommand's own value-taking --version still resolves the project.
      yield* runNotice(ctx, {
        ...ctx.deps,
        args: ["db", "reset", "--workdir", flagged, "--version", "20240101000000"],
      });
      expect(yield* readText(join(flagged, "supabase", ".temp", "cli-latest"))).toBe("v2.114.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not treat Effect's -v shorthand as Go's root version flag", () =>
    Effect.gen(function* () {
      const ctx = setup({ project: false });
      const fs = yield* FileSystem.FileSystem;
      const flagged = join(workdir, "flagged");
      const cacheFile = join(flagged, "supabase", ".temp", "cli-latest");
      yield* makeDirectory(join(flagged, "supabase", ".temp"));
      yield* fs.writeFileString(cacheFile, "v2.115.0");
      yield* runNotice(ctx, { ...ctx.deps, args: ["--workdir", flagged, "-v"] });
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("a clean group-help exit resolves against the bare cwd, ignoring --workdir", () =>
    Effect.gen(function* () {
      const ctx = setup({ project: false });
      const flagged = join(workdir, "flagged");
      yield* makeDirectory(join(flagged, "supabase"));
      yield* runNotice(ctx, {
        ...ctx.deps,
        args: ["branches", "--workdir", flagged],
        cleanShowHelp: true,
      });
      expect(
        Option.isNone(yield* readTextOption(join(flagged, "supabase", ".temp", "cli-latest"))),
      ).toBe(true);
      expect(ctx.stderr).toContain("v2.114.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("ignores a --workdir operand after the -- terminator, like cobra", () =>
    Effect.gen(function* () {
      const ctx = setup({});
      const elsewhere = join(workdir, "elsewhere");
      yield* makeDirectory(join(elsewhere, "supabase"));
      yield* runNotice(ctx, { ...ctx.deps, args: ["db", "start", "--", "--workdir", elsewhere] });
      expect(yield* readText(ctx.cachePath)).toBe("v2.114.0");
      expect(
        Option.isNone(yield* readTextOption(join(elsewhere, "supabase", ".temp", "cli-latest"))),
      ).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("never reads through or writes through a symlinked cache file", () =>
    Effect.gen(function* () {
      const ctx = setup({});
      const fs = yield* FileSystem.FileSystem;
      yield* ctx.fixtures;
      const victim = join(workdir, "victim.txt");
      yield* fs.writeFileString(victim, "v9.9.9");
      yield* makeDirectory(join(workdir, "supabase", ".temp"));
      yield* fs.symlink(victim, ctx.cachePath);
      yield* runNotice(ctx);
      expect(ctx.fetchCalls).toBe(1);
      expect(ctx.stderr).toContain("v2.114.0");
      expect(ctx.stderr).not.toContain("v9.9.9");
      expect(yield* readText(victim)).toBe("v9.9.9");
      expect(Option.isSome(yield* fs.readLink(ctx.cachePath).pipe(Effect.option))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("never writes through a cache symlink planted during the release fetch", () =>
    Effect.gen(function* () {
      const ctx = setup({});
      const fs = yield* FileSystem.FileSystem;
      yield* ctx.fixtures;
      const victim = join(workdir, "victim.txt");
      yield* fs.writeFileString(victim, "v9.9.9");
      yield* makeDirectory(join(workdir, "supabase", ".temp"));
      // Planting the symlink from inside the fetch lands it in the check-then-write window.
      const fetchLatestTag = Effect.gen(function* () {
        yield* fs.symlink(victim, ctx.cachePath);
        return "v2.114.0";
      }).pipe(
        Effect.mapError(
          (cause) => new LegacyUpgradeNoticeError({ message: "fixture symlink", cause }),
        ),
      );
      yield* runNotice(ctx, { ...ctx.deps, fetchLatestTag });
      expect(ctx.stderr).toContain("A new version of Supabase CLI is available: v2.114.0");
      expect(yield* readText(victim)).toBe("v9.9.9");
      expect(Option.isSome(yield* fs.readLink(ctx.cachePath).pipe(Effect.option))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("never writes through a cache symlink swapped after the final safety check", () =>
    Effect.gen(function* () {
      const ctx = setup({});
      const fs = yield* FileSystem.FileSystem;
      yield* ctx.fixtures;
      const victim = join(workdir, "victim.txt");
      yield* fs.writeFileString(victim, "v9.9.9");
      yield* makeDirectory(join(workdir, "supabase", ".temp"));
      let cacheChecks = 0;
      const raceLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem.FileSystem;
          return FileSystem.FileSystem.of({
            ...real,
            readLink: (path: string) => {
              if (path === ctx.cachePath) {
                cacheChecks += 1;
                if (cacheChecks === 2) {
                  return Effect.gen(function* () {
                    yield* real.symlink(victim, path);
                    return yield* PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "readLink",
                      pathOrDescriptor: path,
                    });
                  });
                }
              }
              return real.readLink(path);
            },
          });
        }),
      ).pipe(Layer.provide(BunServices.layer));
      yield* runNotice(ctx).pipe(Effect.provide(raceLayer));
      expect(ctx.fetchCalls).toBe(1);
      expect(yield* readText(victim)).toBe("v9.9.9");
      expect(Option.isSome(yield* fs.readLink(ctx.cachePath).pipe(Effect.option))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.each(["supabase", "supabase/.temp"])(
    "never writes through a symlinked %s directory",
    (linked) =>
      Effect.gen(function* () {
        const ctx = setup({ project: false });
        const fs = yield* FileSystem.FileSystem;
        const outside = join(workdir, "outside");
        yield* makeDirectory(outside);
        if (linked !== "supabase") yield* makeDirectory(join(workdir, "supabase"));
        yield* fs.symlink(outside, join(workdir, linked));
        yield* runNotice(ctx);
        expect(ctx.stderr).toContain("v2.114.0");
        expect(yield* fs.readDirectory(outside)).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("validates exact cache bytes and rejects embedded escape bytes", () =>
    Effect.gen(function* () {
      for (const cacheContent of ["v2.115.0\n", "v2.115.0\r\n", "v2.115.0\u001b[31mboo"]) {
        const ctx = setup({ cacheContent, cacheAgeMs: 60_000 });
        yield* runNotice(ctx);
        expect(ctx.stderr).toBe("");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

/**
 * The `delegatedToGo` guard is why a proxied command doesn't print the notice
 * twice: the Go child ran its own `checkUpgrade` and already printed one.
 *
 * Asserted here rather than by spawning a real Phase 0 command, so the coverage
 * doesn't depend on which commands are still Go wrappers — that set shrinks
 * every time one is ported (`docs/go-cli-porting-status.md`), and an e2e test
 * pinned to one breaks the moment it does.
 */
describe("legacyUpgradeNoticeHook", () => {
  const tempRoot = useLegacyTempWorkdir("supabase-upgrade-notice-hook-");

  const stderrFromHook = (
    delegatedToGo: boolean,
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = tempRoot.current;
      yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "config.toml"),
        'project_id = "demo"\n',
      );
      // Fresh cache: the hook reads it instead of fetching, so this never touches the network.
      yield* fs.writeFileString(path.join(workdir, "supabase", ".temp", "cli-latest"), "v99.99.99");

      const written: Array<string> = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      yield* legacyUpgradeNoticeHook(["db", "branch", "list"], {
        cleanShowHelp: false,
        delegatedToGo,
        workingDirectory: workdir,
        isValueTakingFlagToken: () => false,
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" } }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            process.stderr.write = realWrite;
          }),
        ),
      );
      return stripVTControlCharacters(written.join(""));
    }).pipe(Effect.provide(BunServices.layer));

  it.effect("prints the notice for a natively handled command", () =>
    Effect.gen(function* () {
      expect(yield* stderrFromHook(false)).toContain(
        "A new version of Supabase CLI is available: v99.99.99",
      );
    }),
  );

  it.effect("stays silent when the run delegated to Go, which printed its own notice", () =>
    Effect.gen(function* () {
      expect(yield* stderrFromHook(true)).toBe("");
    }),
  );
});
