import { stripVTControlCharacters } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Clock, DateTime, Effect, Fiber, FileSystem, Layer, Option, Path, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import { CLI_VERSION } from "../shared/cli/version.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import {
  type UpgradeNoticeDeps,
  UpgradeNoticeFetchError,
  formatUpgradeNotice,
  isNewerCliVersion,
  runUpgradeNotice,
  updateNotifierDisabled,
  upgradeNoticeHook,
} from "./upgrade-notice.ts";

describe("updateNotifierDisabled", () => {
  it.each(["1", "t", "T", "TRUE", "true", "True"])("suppresses for ParseBool-true %j", (value) => {
    expect(updateNotifierDisabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "FALSE", "f", "garbage", "yes", "on"])(
    "keeps the notifier enabled for %j",
    (value) => {
      expect(updateNotifierDisabled(value)).toBe(false);
    },
  );
});

describe("isNewerCliVersion", () => {
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
    // A bare tag (no leading "v") is invalid.
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
    expect(isNewerCliVersion(latest, current)).toBe(expected);
  });
});

describe("formatUpgradeNotice", () => {
  it("matches the Go CLI's message bytes modulo styling", () => {
    expect(stripVTControlCharacters(formatUpgradeNotice("v2.114.0", "2.113.0"))).toBe(
      "A new version of Supabase CLI is available: v2.114.0 (currently installed v2.113.0)\n" +
        "We recommend updating regularly for new features and bug fixes: " +
        "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli",
    );
  });
});

const isRoot = process.getuid?.() === 0;

const hookLayer = Layer.mergeAll(BunServices.layer, runtimeInfoLayer);

const notice = (deps: UpgradeNoticeDeps) => runUpgradeNotice(deps);

/** Runs `body` with `target` at `mode`, then restores `restore` so the temp dir can be removed. */
const withMode = <A, E, R>(
  target: string,
  mode: number,
  restore: number,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.acquireUseRelease(
      fs.chmod(target, mode),
      () => body,
      () => Effect.orDie(fs.chmod(target, restore)),
    ),
  );

layer(BunServices.layer)("runUpgradeNotice", (it) => {
  const setup = Effect.fnUntraced(function* (opts: {
    readonly env?: Record<string, string>;
    readonly args?: ReadonlyArray<string>;
    readonly latestTag?: string;
    readonly fetchFails?: boolean;
    readonly project?: boolean;
    readonly cacheContent?: string;
    readonly cacheAgeMs?: number;
    readonly currentVersion?: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    /* Caches the notice itself writes carry real mtimes, which this earlier
       clock always sees as fresh. */
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2020-01-01T00:00:00Z")));
    const clock = yield* Clock.Clock;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-upgrade-notice-" });
    if (opts.project !== false) {
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "config.toml"),
        'project_id = "demo"\n',
      );
    }
    const cachePath = path.join(workdir, "supabase", ".temp", "cli-latest");
    if (opts.cacheContent !== undefined) {
      yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(cachePath, opts.cacheContent);
      if (opts.cacheAgeMs !== undefined) {
        const then = DateTime.toDateUtc(
          DateTime.makeUnsafe(clock.currentTimeMillisUnsafe() - opts.cacheAgeMs),
        );
        yield* fs.utimes(cachePath, then, then);
      }
    }
    // A symlinked SUPABASE_HOME disables the user-level cache, so runs outside a
    // project record no backoff.
    const supabaseHome = path.join(workdir, "home");
    yield* fs.makeDirectory(path.join(workdir, "home-target"));
    yield* fs.symlink(path.join(workdir, "home-target"), supabaseHome);
    let fetchCalls = 0;
    const stderr: Array<string> = [];
    const deps: UpgradeNoticeDeps = {
      env: opts.env ?? {},
      args: opts.args ?? ["db", "start"],
      cwd: workdir,
      currentVersion: opts.currentVersion ?? "2.113.0",
      supabaseHome,
      now: () => clock.currentTimeMillisUnsafe(),
      fetchLatestTag: Effect.suspend(() => {
        fetchCalls += 1;
        return opts.fetchFails === true
          ? Effect.fail(new UpgradeNoticeFetchError({ message: "offline" }))
          : Effect.succeed(opts.latestTag ?? "v2.114.0");
      }),
      writeStderr: (text) => {
        stderr.push(text);
      },
    };
    return {
      fs,
      path,
      workdir,
      deps,
      get fetchCalls() {
        return fetchCalls;
      },
      get stderr() {
        return stripVTControlCharacters(stderr.join(""));
      },
      cachePath,
    };
  });

  it.effect("prints the notice and caches the tag when a newer release exists", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({});
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(1);
      expect(ctx.stderr).toContain("A new version of Supabase CLI is available: v2.114.0");
      expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.114.0");
    }),
  );

  it.effect("SUPABASE_NO_UPDATE_NOTIFIER=1 skips the fetch and the notice entirely", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "1" } });
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toBe("");
    }),
  );

  it.effect("stays silent when already on the latest release", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ latestTag: "v2.113.0" });
      yield* notice(ctx.deps);
      expect(ctx.stderr).toBe("");
    }),
  );

  it.effect("reads a fresh cache instead of fetching", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }),
  );

  it.effect("keeps a cache fresh at the exact ten-hour boundary", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ cacheContent: "v2.115.0", cacheAgeMs: 60_000 });
      const mtime = Option.getOrThrow((yield* ctx.fs.stat(ctx.cachePath)).mtime).getTime();
      yield* notice({ ...ctx.deps, now: () => mtime + 10 * 60 * 60 * 1000 });
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }),
  );

  it.effect("refetches when the cache is older than ten hours", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({
        cacheContent: "v2.115.0-beta.1234567890",
        cacheAgeMs: 11 * 60 * 60 * 1000,
      });
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(1);
      expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.114.0");
    }),
  );

  it.effect("--version reads a fresh cache instead of fetching", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({
        args: ["--version"],
        cacheContent: "v2.115.0",
        cacheAgeMs: 60_000,
      });
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }),
  );

  it.effect(
    "SUPABASE_DEBUG surfaces fetch failures without the --debug flag, like viper's AutomaticEnv",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({
          fetchFails: true,
          project: false,
          env: { SUPABASE_DEBUG: "1" },
        });
        yield* notice(ctx.deps);
        expect(ctx.stderr).toContain("Failed to fetch latest release");
      }),
  );

  it.effect(
    "--debug=true surfaces fetch failures and --debug=false silences them, like pflag",
    () =>
      Effect.gen(function* () {
        const on = yield* setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--debug=true"],
        });
        yield* notice(on.deps);
        expect(on.stderr).toContain("Failed to fetch latest release");

        // A set flag (`--debug=false`) beats SUPABASE_DEBUG.
        const off = yield* setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--debug=false"],
          env: { SUPABASE_DEBUG: "1" },
        });
        yield* notice(off.deps);
        expect(off.stderr).toBe("");
      }),
  );

  it.effect(
    "a built-in ignores SUPABASE_DEBUG but still honors the --debug flag, like cobra's init order",
    () =>
      Effect.gen(function* () {
        const viaEnv = yield* setup({
          fetchFails: true,
          project: false,
          env: { SUPABASE_DEBUG: "1" },
          args: ["--version"],
        });
        yield* notice(viaEnv.deps);
        expect(viaEnv.stderr).toBe("");

        const viaFlag = yield* setup({
          fetchFails: true,
          project: false,
          args: ["--version", "--debug"],
        });
        yield* notice(viaFlag.deps);
        expect(viaFlag.stderr).toContain("Failed to fetch latest release: offline");
      }),
  );

  it.effect("a failed fetch stays silent and writes an empty cache to back off", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ fetchFails: true });
      yield* notice(ctx.deps);
      expect(ctx.stderr).toBe("");
      expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("");
    }),
  );

  it.effect(
    "a failed fetch surfaces its error under --debug when no cache can record the backoff",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--debug"],
        });
        yield* notice(ctx.deps);
        expect(ctx.stderr).toContain("Failed to fetch latest release");
        expect(ctx.stderr).not.toContain("A new version of Supabase CLI is available");
      }),
  );

  it.effect(
    "a --debug operand after -- or consumed by a value flag is not the debug flag, like pflag",
    () =>
      Effect.gen(function* () {
        const afterTerminator = yield* setup({
          fetchFails: true,
          project: false,
          args: ["db", "start", "--", "--debug"],
        });
        yield* notice(afterTerminator.deps);
        expect(afterTerminator.stderr).toBe("");

        const consumedValue = yield* setup({
          fetchFails: true,
          project: false,
          args: ["--profile", "--debug", "db", "start"],
        });
        yield* notice(consumedValue.deps);
        expect(consumedValue.stderr).toBe("");
      }),
  );

  it.effect.skipIf(isRoot)("a cache write failure reports the stable cli-latest path", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ args: ["db", "start", "--debug"] });
      const tempDir = ctx.path.join(ctx.workdir, "supabase", ".temp");
      yield* ctx.fs.makeDirectory(tempDir, { recursive: true });
      yield* withMode(tempDir, 0o555, 0o755, notice(ctx.deps));
      expect(ctx.stderr).toContain("failed to write file");
      expect(ctx.stderr).toContain("cli-latest");
    }),
  );

  it.effect.skipIf(process.platform === "win32")(
    "creates the cache directory and file with Go-compatible modes",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({});
        yield* Effect.acquireUseRelease(
          Effect.sync(() => process.umask(0)),
          () => notice(ctx.deps),
          (previousUmask) => Effect.sync(() => process.umask(previousUmask)),
        );
        const tempDir = ctx.path.join(ctx.workdir, "supabase", ".temp");
        expect((yield* ctx.fs.stat(tempDir)).mode & 0o777).toBe(0o755);
        expect((yield* ctx.fs.stat(ctx.cachePath)).mode & 0o777).toBe(0o644);
      }),
  );

  it.effect.skipIf(isRoot || process.platform === "win32")(
    "a read-only cache directory fails the backoff write and leaves the cache untouched",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({
          args: ["db", "start", "--debug"],
          cacheContent: "v2.115.0",
          cacheAgeMs: 11 * 60 * 60 * 1000,
        });
        const tempDir = ctx.path.join(ctx.workdir, "supabase", ".temp");
        yield* withMode(tempDir, 0o555, 0o755, notice(ctx.deps));
        expect(ctx.stderr).toContain("failed to write file: EACCES: permission denied");
        expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.115.0");
      }),
  );

  it.effect(
    "a --debug consumed by the leaf command's own value flag is not the debug flag, like pflag",
    () =>
      Effect.gen(function* () {
        // `login --name --debug`: `--debug` is consumed as `--name`'s value; the
        // real CLI passes the resolved leaf's value-flag predicate into the hook.
        const ctx = yield* setup({
          fetchFails: true,
          project: false,
          args: ["login", "--name", "--debug"],
        });
        yield* notice({ ...ctx.deps, isValueTakingFlagToken: (token) => token === "--name" });
        expect(ctx.stderr).toBe("");
      }),
  );

  it.effect("a false root version flag before a leaf runs the normal path, workdir included", () =>
    Effect.gen(function* () {
      // `--version=false <leaf>` is not the version built-in, so the cache
      // resolves under `--workdir`.
      const ctx = yield* setup({ project: false });
      const flagged = ctx.path.join(ctx.workdir, "flagged");
      yield* ctx.fs.makeDirectory(ctx.path.join(flagged, "supabase"), { recursive: true });
      yield* notice({
        ...ctx.deps,
        args: ["--workdir", flagged, "--version=false", "db", "push"],
      });
      expect(
        yield* ctx.fs.readFileString(ctx.path.join(flagged, "supabase", ".temp", "cli-latest")),
      ).toBe("v2.114.0");
    }),
  );

  it.effect.skipIf(process.platform === "win32")(
    "replaces a read-only cache file, which only its directory entry guards",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({
          args: ["db", "start", "--debug"],
          cacheContent: "v2.115.0",
          cacheAgeMs: 11 * 60 * 60 * 1000,
        });
        yield* ctx.fs.chmod(ctx.cachePath, 0o444);
        yield* notice(ctx.deps);
        expect(ctx.stderr).not.toContain("failed to write file");
        expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.114.0");
      }),
  );

  it.effect(
    "project dotenv SUPABASE_DEBUG surfaces diagnostics, like godotenv before the Execute tail",
    () =>
      Effect.gen(function* () {
        // The symlinked .temp disables the backoff write, so the fetch error is
        // what remains to log.
        const ctx = yield* setup({ fetchFails: true });
        const { fs, path } = ctx;
        yield* fs.writeFileString(path.join(ctx.workdir, "supabase", ".env"), "SUPABASE_DEBUG=1\n");
        yield* fs.makeDirectory(path.join(ctx.workdir, "elsewhere"), { recursive: true });
        yield* fs.symlink(
          path.join(ctx.workdir, "elsewhere"),
          path.join(ctx.workdir, "supabase", ".temp"),
        );
        yield* notice(ctx.deps);
        expect(ctx.stderr).toContain("Failed to fetch latest release");

        // A shell env that defines the key blocks the chain.
        const blocked = yield* setup({ fetchFails: true, env: { SUPABASE_DEBUG: "" } });
        yield* fs.writeFileString(
          path.join(blocked.workdir, "supabase", ".env"),
          "SUPABASE_DEBUG=1\n",
        );
        yield* fs.makeDirectory(path.join(blocked.workdir, "elsewhere"), { recursive: true });
        yield* fs.symlink(
          path.join(blocked.workdir, "elsewhere"),
          path.join(blocked.workdir, "supabase", ".temp"),
        );
        yield* notice(blocked.deps);
        expect(blocked.stderr).toBe("");
      }),
  );

  it.effect(
    "a failed fetch inside a project stays silent under --debug, matching Go's backoff",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({ fetchFails: true, args: ["db", "start", "--debug"] });
        yield* notice(ctx.deps);
        // The empty-cache backoff write succeeds, so no debug line is emitted.
        expect(ctx.stderr).toBe("");
        expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("");
      }),
  );

  it.effect(
    "resolves the cache under --workdir, then SUPABASE_WORKDIR, ahead of the cwd walk",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({ project: false });
        const { fs, path } = ctx;
        const flagDir = path.join(ctx.workdir, "flag-project");
        const envDir = path.join(ctx.workdir, "env-project");
        for (const dir of [flagDir, envDir]) {
          yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
        }
        const flagCtx = { ...ctx.deps, args: ["db", "start", "--workdir", flagDir] };
        yield* notice(flagCtx);
        expect(
          yield* fs.readFileString(path.join(flagDir, "supabase", ".temp", "cli-latest")),
        ).toBe("v2.114.0");

        const lastWinsCtx = {
          ...ctx.deps,
          args: [
            "db",
            "start",
            "--workdir",
            path.join(ctx.workdir, "ignored"),
            `--workdir=${flagDir}`,
          ],
        };
        yield* notice(lastWinsCtx);
        expect(
          yield* fs.readFileString(path.join(flagDir, "supabase", ".temp", "cli-latest")),
        ).toBe("v2.114.0");

        const envCtx = { ...ctx.deps, env: { SUPABASE_WORKDIR: envDir } };
        yield* notice(envCtx);
        expect(yield* fs.readFileString(path.join(envDir, "supabase", ".temp", "cli-latest"))).toBe(
          "v2.114.0",
        );
      }),
  );

  it.effect(
    "uses the successful command's resolved working directory without re-resolving flags",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({ project: false, args: ["bootstrap", "--workdir", "prompted"] });
        const prompted = ctx.path.join(ctx.workdir, "prompted");
        yield* ctx.fs.makeDirectory(ctx.path.join(prompted, "supabase"), { recursive: true });

        yield* notice({ ...ctx.deps, resolvedCwd: prompted });

        expect(
          yield* ctx.fs.readFileString(ctx.path.join(prompted, "supabase", ".temp", "cli-latest")),
        ).toBe("v2.114.0");
        expect(yield* ctx.fs.exists(ctx.cachePath)).toBe(false);
      }),
  );

  it.effect(
    "an explicit empty --workdir beats SUPABASE_WORKDIR and falls back to the walk, like viper",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({});
        const envDir = ctx.path.join(ctx.workdir, "env-project");
        yield* ctx.fs.makeDirectory(ctx.path.join(envDir, "supabase"), { recursive: true });
        yield* notice({
          ...ctx.deps,
          args: ["db", "start", "--workdir="],
          env: { SUPABASE_WORKDIR: envDir },
        });
        // The set-but-empty flag suppresses the env, so the walk finds the real project.
        expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.114.0");
        expect(yield* ctx.fs.exists(ctx.path.join(envDir, "supabase", ".temp", "cli-latest"))).toBe(
          false,
        );
      }),
  );

  it.effect(
    "a project dotenv SUPABASE_NO_UPDATE_NOTIFIER opt-out suppresses the notice, like godotenv",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({});
        yield* ctx.fs.writeFileString(
          ctx.path.join(ctx.workdir, "supabase", ".env"),
          "SUPABASE_NO_UPDATE_NOTIFIER=1\n",
        );
        yield* notice(ctx.deps);
        expect(ctx.fetchCalls).toBe(0);
        expect(ctx.stderr).toBe("");
      }),
  );

  it.effect(
    "a shell env that defines the key beats the project dotenv, like godotenv's no-override",
    () =>
      Effect.gen(function* () {
        // Defined-but-unparseable in the shell env still blocks the project
        // dotenv from overriding, and an empty value keeps the notifier on.
        const ctx = yield* setup({ env: { SUPABASE_NO_UPDATE_NOTIFIER: "" } });
        yield* ctx.fs.writeFileString(
          ctx.path.join(ctx.workdir, "supabase", ".env"),
          "SUPABASE_NO_UPDATE_NOTIFIER=1\n",
        );
        yield* notice(ctx.deps);
        expect(ctx.stderr).toContain("A new version of Supabase CLI is available");
      }),
  );

  it.effect(
    "--help ignores the project dotenv opt-out — Go never loads config for the built-ins",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({ args: ["--help"] });
        yield* ctx.fs.writeFileString(
          ctx.path.join(ctx.workdir, "supabase", ".env"),
          "SUPABASE_NO_UPDATE_NOTIFIER=1\n",
        );
        yield* notice(ctx.deps);
        expect(ctx.stderr).toContain("A new version of Supabase CLI is available");
      }),
  );

  it.effect("resolves --help and --version against the bare cwd, ignoring --workdir, like Go", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ project: false });
      const flagged = ctx.path.join(ctx.workdir, "flagged");
      const flaggedCache = ctx.path.join(flagged, "supabase", ".temp", "cli-latest");
      yield* ctx.fs.makeDirectory(ctx.path.join(flagged, "supabase"), { recursive: true });
      for (const args of [
        ["--workdir", flagged, "--help"],
        ["--workdir", flagged, "--version"],
        // Valued spellings request the same built-ins; even a false value does,
        // since the non-runnable root/group serves help before running anything.
        ["--workdir", flagged, "--help=true"],
        ["branches", "--workdir", flagged, "-h=1"],
        ["--workdir", flagged, "--version=true"],
        ["branches", "--workdir", flagged, "--help=true", "--help=false"],
        // The space-form operand never stops the root version built-in.
        ["--workdir", flagged, "--version", "true"],
      ]) {
        yield* notice({ ...ctx.deps, args });
      }
      expect(yield* ctx.fs.exists(flaggedCache)).toBe(false);
      // A subcommand's own value-taking --version still resolves the project.
      yield* notice({
        ...ctx.deps,
        args: ["db", "reset", "--workdir", flagged, "--version", "20240101000000"],
      });
      expect(yield* ctx.fs.readFileString(flaggedCache)).toBe("v2.114.0");
    }),
  );

  it.effect("does not treat Effect's -v shorthand as Go's root version flag", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ project: false });
      const flagged = ctx.path.join(ctx.workdir, "flagged");
      const cacheFile = ctx.path.join(flagged, "supabase", ".temp", "cli-latest");
      yield* ctx.fs.makeDirectory(ctx.path.join(flagged, "supabase", ".temp"), { recursive: true });
      yield* ctx.fs.writeFileString(cacheFile, "v2.115.0");

      yield* notice({
        ...ctx.deps,
        args: ["--workdir", flagged, "-v"],
      });

      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toContain("v2.115.0");
    }),
  );

  it.effect("a clean group-help exit resolves against the bare cwd, ignoring --workdir", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ project: false });
      const flagged = ctx.path.join(ctx.workdir, "flagged");
      yield* ctx.fs.makeDirectory(ctx.path.join(flagged, "supabase"), { recursive: true });
      yield* notice({
        ...ctx.deps,
        args: ["branches", "--workdir", flagged],
        cleanShowHelp: true,
      });
      expect(yield* ctx.fs.exists(ctx.path.join(flagged, "supabase", ".temp", "cli-latest"))).toBe(
        false,
      );
      expect(ctx.stderr).toContain("v2.114.0");
    }),
  );

  it.effect("ignores a --workdir operand after the -- terminator, like cobra", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({});
      const elsewhere = ctx.path.join(ctx.workdir, "elsewhere");
      yield* ctx.fs.makeDirectory(ctx.path.join(elsewhere, "supabase"), { recursive: true });
      const opCtx = { ...ctx.deps, args: ["db", "start", "--", "--workdir", elsewhere] };
      yield* notice(opCtx);
      expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.114.0");
      expect(
        yield* ctx.fs.exists(ctx.path.join(elsewhere, "supabase", ".temp", "cli-latest")),
      ).toBe(false);
    }),
  );

  it.effect("never reads through or writes through a symlinked cache file", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({});
      const victim = ctx.path.join(ctx.workdir, "victim.txt");
      yield* ctx.fs.writeFileString(victim, "v9.9.9");
      yield* ctx.fs.makeDirectory(ctx.path.join(ctx.workdir, "supabase", ".temp"), {
        recursive: true,
      });
      yield* ctx.fs.symlink(victim, ctx.cachePath);
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(1);
      expect(ctx.stderr).toContain("v2.114.0");
      expect(ctx.stderr).not.toContain("v9.9.9");
      expect(yield* ctx.fs.readFileString(victim)).toBe("v9.9.9");
      expect(yield* ctx.fs.readLink(ctx.cachePath)).toBe(victim);
    }),
  );

  it.effect("never writes through a cache symlink planted during the release fetch", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({});
      const victim = ctx.path.join(ctx.workdir, "victim.txt");
      yield* ctx.fs.writeFileString(victim, "v9.9.9");
      yield* ctx.fs.makeDirectory(ctx.path.join(ctx.workdir, "supabase", ".temp"), {
        recursive: true,
      });
      // Planting the symlink inside `fetchLatestTag` simulates a concurrent
      // swap landing in the check-then-write window; removing the old entry
      // deletes the link itself, and the exclusive create writes a fresh file.
      yield* notice({
        ...ctx.deps,
        fetchLatestTag: ctx.fs
          .symlink(victim, ctx.cachePath)
          .pipe(Effect.orDie, Effect.as("v2.114.0")),
      });

      expect(ctx.stderr).toContain("A new version of Supabase CLI is available: v2.114.0");
      expect(yield* ctx.fs.readFileString(victim)).toBe("v9.9.9");
      expect(Option.isNone(yield* ctx.fs.readLink(ctx.cachePath).pipe(Effect.option))).toBe(true);
      expect(yield* ctx.fs.readFileString(ctx.cachePath)).toBe("v2.114.0");
    }),
  );

  it.effect("refuses a symlink planted between removing the old cache and creating the new", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({
        args: ["db", "start", "--debug"],
        cacheContent: "v2.115.0",
        cacheAgeMs: 11 * 60 * 60 * 1000,
      });
      const victim = ctx.path.join(ctx.workdir, "victim.txt");
      yield* ctx.fs.writeFileString(victim, "v9.9.9");
      const realFs = ctx.fs;
      /* The link lands right after the old entry is removed, so only the
         exclusive create stands between the write and the victim. */
      const planting = FileSystem.FileSystem.of({
        ...realFs,
        remove: (path, options) =>
          realFs
            .remove(path, options)
            .pipe(Effect.andThen(realFs.symlink(victim, path).pipe(Effect.orDie))),
      });
      yield* notice(ctx.deps).pipe(Effect.provideService(FileSystem.FileSystem, planting));
      expect(ctx.stderr).not.toContain("failed to write file");
      expect(yield* realFs.readFileString(victim)).toBe("v9.9.9");
      expect(yield* realFs.readLink(ctx.cachePath)).toBe(victim);
    }),
  );

  it.effect("keeps a leading BOM in the cached tag, so it never reads as a release", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ cacheContent: "\uFEFFv99.99.99", cacheAgeMs: 60 * 1000 });
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(0);
      expect(ctx.stderr).toBe("");
    }),
  );

  it.effect("a directory at the cache path fails the backoff write", () =>
    Effect.gen(function* () {
      const ctx = yield* setup({ args: ["db", "start", "--debug"] });
      yield* ctx.fs.makeDirectory(ctx.cachePath, { recursive: true });
      /* Older than the TTL against the setup clock, so the write path runs. */
      const stale = DateTime.toDateUtc(DateTime.makeUnsafe("2019-01-01T00:00:00Z"));
      yield* ctx.fs.utimes(ctx.cachePath, stale, stale);
      yield* notice(ctx.deps);
      expect(ctx.fetchCalls).toBe(1);
      expect(ctx.stderr).toContain("failed to write file");
      expect((yield* ctx.fs.stat(ctx.cachePath)).type).toBe("Directory");
    }),
  );

  it.effect.each(["supabase", "supabase/.temp"])(
    "never writes through a symlinked %s directory",
    (linked) =>
      Effect.gen(function* () {
        const ctx = yield* setup({ project: false });
        const outside = ctx.path.join(ctx.workdir, "outside");
        yield* ctx.fs.makeDirectory(outside, { recursive: true });
        if (linked !== "supabase") {
          yield* ctx.fs.makeDirectory(ctx.path.join(ctx.workdir, "supabase"), { recursive: true });
        }
        yield* ctx.fs.symlink(outside, ctx.path.join(ctx.workdir, linked));

        yield* notice(ctx.deps);

        expect(ctx.stderr).toContain("v2.114.0");
        expect(yield* ctx.fs.readDirectory(outside)).toEqual([]);
      }),
  );

  it.effect.each(["", "/", "/."])(
    "never writes through a symlinked SUPABASE_HOME spelled with suffix %j",
    (suffix) =>
      Effect.gen(function* () {
        const ctx = yield* setup({ project: false });
        yield* notice({ ...ctx.deps, supabaseHome: `${ctx.deps.supabaseHome}${suffix}` });
        expect(yield* ctx.fs.readDirectory(ctx.path.join(ctx.workdir, "home-target"))).toEqual([]);
      }),
  );

  it.effect("validates exact cache bytes and rejects embedded escape bytes", () =>
    Effect.gen(function* () {
      for (const cacheContent of ["v2.115.0\n", "v2.115.0\r\n", "v2.115.0\u001b[31mboo"]) {
        const ctx = yield* setup({ cacheContent, cacheAgeMs: 60_000 });
        yield* notice(ctx.deps);
        expect(ctx.stderr).toBe("");
      }
    }),
  );
});

const captureStderr = <E, R>(body: Effect.Effect<void, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const written: Array<string> = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      return { written, realWrite };
    }),
    ({ written }) => Effect.as(body, written),
    ({ realWrite }) =>
      Effect.sync(() => {
        process.stderr.write = realWrite;
      }),
  );

/**
 * `delegatedToGo` is asserted directly rather than via a real proxied
 * command, so this doesn't depend on which commands still delegate to Go —
 * that set only shrinks (`docs/go-cli-porting-status.md`), and a test pinned
 * to one command would break the moment it's ported.
 */
layer(hookLayer)("upgradeNoticeHook", (it) => {
  const runHook = Effect.fnUntraced(function* (opts: {
    readonly delegatedToGo?: boolean;
    readonly cached?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-upgrade-notice-hook-" });
    yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n',
    );
    if (opts.cached !== false) {
      yield* fs.writeFileString(path.join(workdir, "supabase", ".temp", "cli-latest"), "v99.99.99");
    }
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });

    const written = yield* captureStderr(
      withConfigEnv(
        { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
        upgradeNoticeHook(
          ["db", "branch", "list"],
          {
            cleanShowHelp: false,
            delegatedToGo: opts.delegatedToGo === true,
            workingDirectory: workdir,
            isValueTakingFlagToken: () => false,
          },
          Effect.succeed("v99.99.99"),
        ).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true)),
      ),
    );
    const span = (name: string) => spans.find((candidate) => candidate.name === name);
    return { stderr: stripVTControlCharacters(written.join("")), span };
  });

  it.effect("prints the notice for a natively handled command", () =>
    Effect.gen(function* () {
      expect((yield* runHook({})).stderr).toContain(
        "A new version of Supabase CLI is available: v99.99.99",
      );
    }),
  );

  it.effect("stays silent when the run delegated to Go, which printed its own notice", () =>
    Effect.gen(function* () {
      expect((yield* runHook({ delegatedToGo: true })).stderr).toBe("");
    }),
  );

  it.effect("traces a cache hit on the check span without a fetch span", () =>
    Effect.gen(function* () {
      const { span } = yield* runHook({});
      expect(Object.fromEntries(span("UpgradeNotice.check")!.attributes)).toEqual({
        "cache.location": "project",
        "cache.hit": true,
      });
      expect(span("UpgradeNotice.fetch")).toBeUndefined();
    }),
  );

  it.effect("traces a cache miss with the release fetch as a child of the check span", () =>
    Effect.gen(function* () {
      const { span } = yield* runHook({ cached: false });
      const check = span("UpgradeNotice.check")!;
      expect(Object.fromEntries(check.attributes)).toEqual({
        "cache.location": "project",
        "cache.hit": false,
      });
      const parent = span("UpgradeNotice.fetch")!.parent;
      expect(Option.isSome(parent) ? parent.value.spanId : undefined).toBe(check.spanId);
    }),
  );
});

layer(hookLayer)("upgradeNoticeHook release lookup", (it) => {
  /** The hook's own GitHub lookup against a stubbed `fetch`, from a project with no cache yet. */
  const runLookup = Effect.fnUntraced(function* (opts: {
    readonly env?: Record<string, string>;
    /** A symlinked `.temp` disables the cache, so a lookup failure stays the debug diagnostic. */
    readonly symlinkedTemp?: boolean;
    /** Resolve the project through `SUPABASE_WORKDIR` instead of the command's working directory. */
    readonly workdirFromEnv?: boolean;
    /** Extra project files, relative to the workdir. */
    readonly files?: Record<string, string>;
    readonly respond: (signal: AbortSignal | undefined) => Promise<Response>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({
      prefix: "supabase-upgrade-notice-lookup-",
    });
    if (opts.symlinkedTemp === true) {
      yield* fs.makeDirectory(path.join(workdir, "temp-target"));
      yield* fs.makeDirectory(path.join(workdir, "supabase"));
      yield* fs.symlink(path.join(workdir, "temp-target"), path.join(workdir, "supabase", ".temp"));
    } else {
      yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
    }
    yield* fs.writeFileString(
      path.join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n',
    );
    for (const [file, contents] of Object.entries(opts.files ?? {})) {
      yield* fs.writeFileString(path.join(workdir, file), contents);
    }
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return opts.respond(init?.signal ?? undefined);
      },
      { preconnect: () => Promise.resolve() },
    );
    const written = yield* captureStderr(
      withConfigEnv(
        {
          SUPABASE_NO_UPDATE_NOTIFIER: "0",
          ...(opts.workdirFromEnv === true ? { SUPABASE_WORKDIR: workdir } : {}),
          ...opts.env,
        },
        upgradeNoticeHook(["db", "branch", "list"], {
          cleanShowHelp: false,
          delegatedToGo: false,
          workingDirectory: opts.workdirFromEnv === true ? undefined : workdir,
          isValueTakingFlagToken: () => false,
        }),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    );
    const cache = yield* fs
      .readFileString(path.join(workdir, "supabase", ".temp", "cli-latest"))
      .pipe(Effect.option);
    return {
      requests,
      stderr: stripVTControlCharacters(written.join("")),
      cache: Option.getOrUndefined(cache),
    };
  });

  it.effect("asks GitHub for the latest release, with Bearer only for a non-empty token", () =>
    Effect.gen(function* () {
      const respond = () => Promise.resolve(Response.json({ tag_name: "v99.99.99" }));
      const withToken = yield* runLookup({ env: { GITHUB_TOKEN: "tok" }, respond });
      expect(withToken.requests).toHaveLength(1);
      const request = withToken.requests[0]!;
      expect(request.url).toBe("https://api.github.com/repos/supabase/cli/releases/latest");
      expect(request.headers.get("accept")).toBe("application/vnd.github+json");
      expect(request.headers.get("user-agent")).toBe(`SupabaseCLI/${CLI_VERSION}`);
      expect(request.headers.get("authorization")).toBe("Bearer tok");
      expect(request.headers.has("traceparent")).toBe(false);
      expect(withToken.cache).toBe("v99.99.99");
      expect(withToken.stderr).toContain("A new version of Supabase CLI is available: v99.99.99");

      const empty = yield* runLookup({ env: { GITHUB_TOKEN: "" }, respond });
      expect(empty.requests[0]!.headers.has("authorization")).toBe(false);
    }),
  );

  it.effect("backs off with an empty cache when the lookup fails", () =>
    Effect.gen(function* () {
      const failed = yield* runLookup({
        respond: () => Promise.resolve(Response.json({ tag_name: "v99.99.99" }, { status: 500 })),
      });
      expect(failed.cache).toBe("");
      expect(failed.stderr).toBe("");
    }),
  );

  it.effect("reads an empty release body as no tag and reports a malformed one", () =>
    Effect.gen(function* () {
      const body = (text: string) => () => Promise.resolve(new Response(text, { status: 200 }));
      const env = { SUPABASE_DEBUG: "1" };
      const quiet = yield* runLookup({ env, symlinkedTemp: true, respond: body("") });
      expect(quiet.requests).toHaveLength(1);
      expect(quiet.stderr).toBe("");
      const malformed = yield* runLookup({ env, symlinkedTemp: true, respond: body("not json") });
      expect(malformed.stderr).toBe(
        'Failed to fetch latest release: JSON Parse error: Unexpected identifier "not"\n',
      );
    }),
  );

  it.effect("cuts a hung lookup off at the fetch bound and aborts it", () =>
    Effect.gen(function* () {
      let aborted = false;
      const started = Promise.withResolvers<void>();
      const fiber = yield* Effect.forkChild(
        runLookup({
          respond: (signal) => {
            started.resolve();
            const hung = Promise.withResolvers<Response>();
            signal?.addEventListener("abort", () => {
              aborted = true;
              hung.reject(signal.reason);
            });
            return hung.promise;
          },
        }),
      );
      /* Advance the clock only once the lookup is in flight, so its bound is armed. */
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("799 millis");
      expect(aborted).toBe(false);
      yield* TestClock.adjust("1 millis");
      const hung = yield* Fiber.join(fiber);
      expect(aborted).toBe(true);
      expect(hung.cache).toBe("");
    }),
  );

  it.effect("finds the project through SUPABASE_WORKDIR", () =>
    Effect.gen(function* () {
      const located = yield* runLookup({
        workdirFromEnv: true,
        respond: () => Promise.resolve(Response.json({ tag_name: "v99.99.99" })),
      });
      expect(located.cache).toBe("v99.99.99");
    }),
  );

  it.effect("reads the SUPABASE_ENV dotenv file", () =>
    Effect.gen(function* () {
      const staged = yield* runLookup({
        env: { SUPABASE_ENV: "staging" },
        files: { "supabase/.env.staging": "SUPABASE_DEBUG=1\n" },
        symlinkedTemp: true,
        respond: () => Promise.resolve(new Response("{}", { status: 500 })),
      });
      expect(staged.stderr).toBe("Failed to fetch latest release: unexpected status 500\n");
    }),
  );

  it.effect("skips the lookup when SUPABASE_NO_UPDATE_NOTIFIER is set", () =>
    Effect.gen(function* () {
      const optedOut = yield* runLookup({
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "1" },
        respond: () => Promise.resolve(Response.json({ tag_name: "v99.99.99" })),
      });
      expect(optedOut.requests).toHaveLength(0);
      expect(optedOut.cache).toBeUndefined();
    }),
  );
});
