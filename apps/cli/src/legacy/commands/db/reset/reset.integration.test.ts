import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { LegacyGoChildExitError } from "../../../../shared/legacy/legacy-go-child-exit.error.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbConfigConnectTempRoleError } from "../../../shared/legacy-db-config.errors.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDbBootstrapSeam } from "../shared/legacy-db-bootstrap.seam.service.ts";
import { legacyDbReset } from "./reset.handler.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";

const CONN: LegacyPgConnInput = {
  host: "db.example.supabase.co",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

const DEFAULT_FLAGS: LegacyDbResetFlags = {
  dbUrl: Option.none(),
  linked: false,
  local: false,
  noSeed: false,
  sqlPaths: [],
  version: Option.none(),
  last: Option.none(),
};

/**
 * Tracks every `resolve`/`resolvePoolerFallback` invocation so tests can prove a
 * connection was (or, for the delegated-experimental path, was NOT) resolved —
 * `resolve()` mints/verifies a temporary Postgres login role over the Management
 * API, so calling it on a path that immediately discards the result is wasted
 * (and duplicated) work (CLI-1879).
 */
function mockResolver(opts: {
  isLocal: boolean;
  ref?: string;
  omitRef?: boolean;
  resolveFails?: boolean;
}) {
  let calls = 0;
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) => {
      calls++;
      return opts.resolveFails === true
        ? Effect.fail(
            new LegacyDbConfigConnectTempRoleError({
              message: "failed to create login role: network error",
            }),
          )
        : Effect.succeed(
            (opts.omitRef === true
              ? { conn: CONN, isLocal: opts.isLocal }
              : {
                  conn: CONN,
                  isLocal: opts.isLocal,
                  ref: opts.ref !== undefined ? Option.some(opts.ref) : Option.none(),
                }) satisfies LegacyResolvedDbConfig,
          );
    },
    resolvePoolerFallback: () => {
      calls++;
      return Effect.succeed(Option.none());
    },
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

function mockConnection(opts: { remoteSeeds?: Readonly<Record<string, string>> }) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, LegacyDbExecError> =>
          Effect.sync(() => {
            execs.push(sql);
          }),
        query: (
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> =>
          Effect.suspend(
            (): Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError> => {
              queries.push({ sql, params });
              if (sql === SELECT_SEEDS) {
                return Effect.succeed(
                  Object.entries(opts.remoteSeeds ?? {}).map(([path, hash]) => ({ path, hash })),
                );
              }
              if (sql === LIST_MIGRATIONS) return Effect.succeed([]);
              return Effect.succeed([]);
            },
          ),
      }),
  });
  return {
    layer,
    get execs() {
      return execs;
    },
    get queries() {
      return queries;
    },
  };
}

/**
 * Stateful mock of the container-bootstrap seam. `running` drives
 * `AssertSupabaseDbIsRunning`; `storageReady` drives the bucket-seed gate. Records
 * the recreate args so tests can assert version / `--no-seed` propagation.
 * `awaitStorageReadyExitCode`, when set, fails `awaitStorageReady` with a
 * `LegacyGoChildExitError` carrying that code — simulating the seam's real
 * `captureStdout` bootstrap-child path exiting non-zero (CLI-1879).
 */
function mockBootstrapSeam(opts: {
  running?: boolean;
  storageReady?: boolean;
  awaitStorageReadyExitCode?: number;
}) {
  const recreateCalls: Array<{
    version: string;
    noSeed: boolean;
    sqlPaths: ReadonlyArray<string>;
  }> = [];
  let storageChecked = false;
  const layer = Layer.succeed(LegacyDbBootstrapSeam, {
    isDbRunning: () => Effect.succeed(opts.running ?? true),
    startDatabase: () => Effect.void,
    recreateDatabase: (args: {
      version: string;
      noSeed: boolean;
      sqlPaths: ReadonlyArray<string>;
    }) =>
      Effect.sync(() => {
        recreateCalls.push(args);
      }),
    awaitStorageReady: () =>
      Effect.sync(() => {
        storageChecked = true;
      }).pipe(
        Effect.flatMap(() =>
          opts.awaitStorageReadyExitCode !== undefined
            ? Effect.fail(
                new LegacyGoChildExitError({
                  exitCode: opts.awaitStorageReadyExitCode,
                  message: `failed to bootstrap the local database: exit ${opts.awaitStorageReadyExitCode}`,
                }),
              )
            : Effect.succeed(opts.storageReady ?? false),
        ),
      ),
  });
  return {
    layer,
    get recreateCalls() {
      return recreateCalls;
    },
    get storageChecked() {
      return storageChecked;
    },
  };
}

// Dummy HTTP client; the local-reset bucket-seed core only reaches it when storage
// is ready AND buckets are configured (no reset test configures buckets, so the
// gateway is never actually called). Present to satisfy the handler's R.
const mockStorageHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
  ),
);

/**
 * `execCaptureExitCode`, when set, makes `execCapture` fail with a
 * `LegacyGoChildExitError` carrying that code instead of succeeding — simulating
 * a delegated Go child exiting non-zero under a machine-output mode (CLI-1879).
 */
function mockProxy(opts: { execCaptureExitCode?: number } = {}) {
  const calls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args, execOpts) =>
      Effect.sync(() => {
        calls.push({ args, env: execOpts?.env });
      }),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        calls.push({ args, env: execOpts?.env });
      }).pipe(
        Effect.flatMap(() =>
          opts.execCaptureExitCode !== undefined
            ? Effect.fail(
                new LegacyGoChildExitError({
                  exitCode: opts.execCaptureExitCode,
                  message: `supabase-go exited with code ${opts.execCaptureExitCode}`,
                }),
              )
            : Effect.succeed(""),
        ),
      ),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

function setup(
  workdir: string,
  opts: {
    toml?: string;
    files?: Readonly<Record<string, string>>;
    format?: OutputFormat;
    confirm?: ReadonlyArray<boolean>;
    args?: ReadonlyArray<string>;
    isLocal?: boolean;
    ref?: string;
    experimental?: boolean;
    remoteSeeds?: Readonly<Record<string, string>>;
    yes?: boolean;
    omitRef?: boolean;
    resolveFails?: boolean;
    running?: boolean;
    storageReady?: boolean;
    awaitStorageReadyExitCode?: number;
    execCaptureExitCode?: number;
  },
) {
  if (opts.toml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.toml);
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(workdir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const out = mockOutput({ format: opts.format ?? "text", promptConfirmResponses: opts.confirm });
  const conn = mockConnection(opts);
  const proxy = mockProxy({ execCaptureExitCode: opts.execCaptureExitCode });
  const seam = mockBootstrapSeam({
    running: opts.running,
    storageReady: opts.storageReady,
    awaitStorageReadyExitCode: opts.awaitStorageReadyExitCode,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();
  // The local-reset bucket-seed core statically requires the (lazy) Management-API
  // factory; never invoked on `--local` (projectRef === "").
  const platformApi = mockLegacyPlatformApiService({});
  const resolver = mockResolver({
    isLocal: opts.isLocal ?? false,
    ref: opts.ref ?? LEGACY_VALID_REF,
    omitRef: opts.omitRef,
    resolveFails: opts.resolveFails,
  });

  const layer = Layer.mergeAll(
    out.layer,
    conn.layer,
    proxy.layer,
    seam.layer,
    resolver.layer,
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    mockRuntimeInfo(),
    // The remote-reset confirmation is answered through mockOutput's
    // `promptConfirmResponses` (the TTY/clack path), so mark stdin a TTY. Stdin is
    // only referenced by legacyPromptYesNo's non-TTY branch (unreached here) but must
    // be present to satisfy the effect's requirements.
    mockTty({ stdinIsTty: true }),
    mockStdin(true),
    // The linked ref is pre-loaded (for the post-run cache) before resolve,
    // mirroring Go's LoadProjectRef-before-NewDbConfigWithPassword order.
    Layer.succeed(LegacyProjectRefResolver, {
      resolve: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
      resolveForLink: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
      resolveOptional: () => Effect.succeed(Option.some(opts.ref ?? LEGACY_VALID_REF)),
      loadProjectRef: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
      promptProjectRef: () => Effect.succeed(opts.ref ?? LEGACY_VALID_REF),
    }),
    mockStorageHttp,
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    Layer.succeed(CliArgs, { args: opts.args ?? ["db", "reset", "--linked"] }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    telemetry.layer,
    linkedCache.layer,
  );
  return { layer, out, conn, proxy, seam, telemetry, linkedCache, resolver };
}

const migrationFile = (version: string, body = "create table t ();") => ({
  [`supabase/migrations/${version}_test.sql`]: body,
});

describe("legacy db reset", () => {
  const tmp = useLegacyTempWorkdir("supabase-db-reset-");

  it.live("resets the local database via the bootstrap seam", () => {
    const { layer, out, seam, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      // Native path — no Go delegation.
      expect(proxy.calls).toHaveLength(0);
      expect(out.stderrText).toContain("Resetting local database...");
      expect(seam.recreateCalls).toEqual([{ version: "", noSeed: false, sqlPaths: [] }]);
      // Storage gate checked; with no buckets configured nothing is seeded.
      expect(seam.storageChecked).toBe(true);
      expect(out.stderrText).toContain("Finished ");
      expect(out.stderrText).toContain("on branch ");
    });
  });

  it.live("fails a local reset when the database is not running", () => {
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: false,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("is not running.");
      expect(seam.recreateCalls).toHaveLength(0);
    });
  });

  it.live("proceeds with a local reset when no config file is present", () => {
    // Go's `Config.Load` tolerates a missing `config.toml`: `Eject` defaults an empty
    // `project_id` to the cwd basename (`pkg/config/config.go:563-570`), so `Validate`
    // never sees an empty required field and the CLI proceeds — exactly the mechanism
    // the cli-e2e parity suite relies on when it runs `db reset --local` from a project
    // with no config.toml. A missing config must not become a hard failure here.
    const { layer, seam } = setup(tmp.current, {
      args: ["db", "reset"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(seam.recreateCalls).toHaveLength(1);
    });
  });

  it.live("fails a local reset before the destructive recreate on a malformed config.toml", () => {
    // Go's `flags.LoadConfig` (the local target's `LoadConfig`, `db_url.go:77-80`) runs
    // full config validation before `reset.Run` reaches `AssertSupabaseDbIsRunning` /
    // `resetDatabase` (`internal/db/reset/reset.go:57-61`). A broken config.toml must
    // abort before the local database is ever recreated.
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "unterminated\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to load config");
      }
      expect(seam.recreateCalls).toHaveLength(0);
    });
  });

  it.live(
    "fails a local reset on a malformed config.toml even when the database is not running",
    () => {
      // Pins Go's exact ordering: `flags.LoadConfig` runs in the root `PersistentPreRunE`,
      // strictly before `reset.Run` ever calls `AssertSupabaseDbIsRunning`
      // (`internal/db/reset/reset.go:57`). So a broken config must surface as a config
      // error even when the local database is ALSO not running — the config check must
      // win the race, not the "is not running" check.
      const { layer, seam } = setup(tmp.current, {
        toml: 'project_id = "unterminated\n',
        args: ["db", "reset"],
        isLocal: true,
        running: false,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const cause = JSON.stringify(exit.cause);
          expect(cause).toContain("failed to load config");
          expect(cause).not.toContain("is not running.");
        }
        expect(seam.recreateCalls).toHaveLength(0);
      });
    },
  );

  it.live("fails a local reset before the destructive recreate on an undecryptable secret", () => {
    // Regression: Go's `flags.LoadConfig` decrypts every `encrypted:` secret before
    // `reset.Run` recreates the local database, so an undecryptable secret must abort
    // before the destructive recreate, not surface later (or never) during bucket
    // seeding.
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:anything"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      // Assert on the stable "failed to parse config:" prefix rather than the exact
      // decrypt-failure tail, which depends on whether an ambient `DOTENV_PRIVATE_KEY*`
      // is set (missing key vs. a base64/decrypt failure) — either way, the config
      // load must fail before the destructive recreate.
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to parse config:");
      }
      expect(seam.recreateCalls).toHaveLength(0);
    });
  });

  it.live("fails a local reset before the destructive recreate on an empty project_id", () => {
    // Go's `config.Validate` rejects an explicit `project_id = ""` (a present override
    // that resolved to empty, unlike an absent field) before the local recreate.
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = ""\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "Missing required field in config: project_id",
        );
      }
      expect(seam.recreateCalls).toHaveLength(0);
    });
  });

  it.live("seeds buckets after a local reset when storage is ready", () => {
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
      storageReady: true,
    });
    return Effect.gen(function* () {
      // No buckets configured → the seed-buckets core short-circuits, but the
      // storage gate is still consulted (Go inspects storage before buckets.Run).
      yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(seam.storageChecked).toBe(true);
      expect(seam.recreateCalls).toHaveLength(1);
    });
  });

  it.live("fails a local reset before the destructive recreate on an unparseable boolean", () => {
    // `SEED_ENABLED=maybe` cannot be resolved by Go's `strconv.ParseBool`, so
    // `flags.LoadConfig` aborts on this config before `reset.Run` ever reaches
    // `AssertSupabaseDbIsRunning`/`resetDatabase`. Previously this surfaced only much
    // later (if at all) via the bucket-seeding core's own reload, AFTER the local
    // database had already been recreated — this must now abort up front instead,
    // via the pre-recreate `legacyCheckDbToml` gate.
    const previous = process.env["SEED_ENABLED"];
    process.env["SEED_ENABLED"] = "maybe";
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.seed]\nenabled = "env(SEED_ENABLED)"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
      storageReady: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("invalid db.seed.enabled");
      }
      expect(seam.recreateCalls).toHaveLength(0);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SEED_ENABLED"];
          else process.env["SEED_ENABLED"] = previous;
        }),
      ),
    );
  });

  it.live(
    "finishes a local reset when bucket seeding can't see an env(VAR) value the pre-recreate gate saw",
    () => {
      // `legacyCheckDbToml` (the pre-recreate gate) resolves `env(VAR)` via
      // `legacyLoadProjectEnv`, which mirrors Go's full nested-env walk and sees
      // `supabase/.env.development` — a real, Go-valid env source
      // (`pkg/config/config.go:1220-1257`; `godotenv.Load` calls `os.Setenv`, so this
      // is genuinely ambient env by the time Go itself resolves `env(VAR)`,
      // `config.go:1260-1261`). The post-recreate bucket-seed reload instead goes
      // through `@supabase/config`'s `loadProjectEnvironment`, which only ever reads
      // `supabase/.env`/`.env.local` + ambient env (`packages/config/src/project.ts:
      // 209-245) — it can't see `.env.development` at all. So this Go-valid config
      // passes the gate and the real recreate, then can't be re-resolved by the
      // reload; the reset must still finish (warn-and-skip), not hard-fail after the
      // local database has already been dropped and rebuilt.
      const { layer, out, seam } = setup(tmp.current, {
        toml: 'project_id = "test"\n\n[db.seed]\nenabled = "env(SEED_ENABLED)"\n',
        files: { "supabase/.env.development": "SEED_ENABLED=true\n" },
        args: ["db", "reset"],
        isLocal: true,
        running: true,
        storageReady: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(seam.recreateCalls).toHaveLength(1);
        expect(out.stderrText).toContain("skipped seeding storage buckets");
        expect(out.stderrText).toContain("Finished ");
      });
    },
  );

  it.live("uses the detected git branch in the Finished line", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
    });
    // `detectGitBranch` checks `$GITHUB_HEAD_REF` first (matching Go's
    // `GetGitBranchOrDefault`). Set it explicitly so the test is deterministic in
    // both a plain checkout and a GitHub Actions PR run (where it is preset to the
    // PR branch); restore it afterwards.
    const previous = process.env["GITHUB_HEAD_REF"];
    process.env["GITHUB_HEAD_REF"] = "feature-x";
    return Effect.gen(function* () {
      yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      // The branch name is wrapped in ANSI (legacyAqua), so assert on the token.
      expect(out.stderrText).toContain("on branch ");
      expect(out.stderrText).toContain("feature-x");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["GITHUB_HEAD_REF"];
          else process.env["GITHUB_HEAD_REF"] = previous;
        }),
      ),
    );
  });

  it.live("fails a remote reset on a malformed config.toml", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "unterminated\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Config now loads through the Go-parity reader (`legacyCheckDbToml`), so a malformed
        // config aborts with Go's `failed to load config` message, same as the other db
        // commands (diff/dump/pull/migration).
        expect(JSON.stringify(exit.cause)).toContain("failed to load config");
      }
    });
  });

  it.live("loads a Go-style env() boolean in config for a remote reset", () => {
    // Regression: `enabled = "env(VAR)"` must load via Go's env-expansion + ParseBool
    // (`legacyCheckDbToml`) instead of the strict @supabase/config loader rejecting it.
    const previous = process.env["MIGRATIONS_ENABLED"];
    process.env["MIGRATIONS_ENABLED"] = "true";
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.migrations]\nenabled = "env(MIGRATIONS_ENABLED)"\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["MIGRATIONS_ENABLED"];
          else process.env["MIGRATIONS_ENABLED"] = previous;
        }),
      ),
    );
  });

  it.live("emits a json result for a local reset", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset"],
      isLocal: true,
      running: true,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["target"]).toBe("local");
    });
  });

  it.live("rejects mutually exclusive target flags", () => {
    const { layer } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset", "--linked", "--local"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("rejects --version together with --last", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("20240101000000"),
        last: Option.some(1),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("[last version]");
    });
  });

  it.live("rejects a non-integer --version", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("not-a-number"),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(JSON.stringify(exit.cause)).toContain("invalid version number");
    });
  });

  it.live("fails when --version has no matching migration file", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("20240101000000"),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "glob supabase/migrations/20240101000000_*.sql: file does not exist",
        );
      }
    });
  });

  it.live("returns context canceled when the reset prompt is declined", () => {
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("context canceled");
      expect(conn.execs).toHaveLength(0);
    });
  });

  it.live("drops schemas and applies migrations + seed on a confirmed remote reset", () => {
    const { layer, out, conn, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting remote database...");
      // No "Connecting to ... database..." line (Go uses io.Discard).
      expect(out.stderrText).not.toContain("Connecting to");
      // Drop block ran, then the migration applied.
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
      expect(linkedCache.cached).toBe(true);
    });
  });

  it.live("fails a remote reset before dropping schemas on an undecryptable secret", () => {
    // Regression: the old point-of-use vault decryption ran AFTER `legacyDropUserSchemas`,
    // so an undecryptable `encrypted:` secret dropped the schemas before failing. Go runs
    // `flags.LoadConfig` (which decrypts every secret) before ResetAll, so the reset must
    // abort before any destructive work — matched here by `legacyCheckDbToml` at load time.
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:anything"\n',
      confirm: [true],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to parse config: missing private key");
      }
      // Config load failed before ResetAll → schemas were never dropped.
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(false);
    });
  });

  it.live("fails a remote reset before dropping schemas on an empty project_id", () => {
    // Go's config.Validate rejects an explicit `project_id = ""` before the reset prompt, so
    // the native remote reset must abort before `legacyDropUserSchemas`.
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = ""\n',
      confirm: [true],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "Missing required field in config: project_id",
        );
      }
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(false);
    });
  });

  it.live("auto-confirms a remote reset via SUPABASE_YES set only in the project .env", () => {
    // Go's loadNestedEnv sets project-.env keys before the reset prompt reads viper YES, so
    // a `SUPABASE_YES` in supabase/.env auto-confirms the destructive prompt (default false).
    const { layer, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { "supabase/.env": "SUPABASE_YES=true\n" },
      // Deliberately no `confirm` responses — the prompt must be auto-confirmed.
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
    });
  });

  it.live("still caches the linked ref when DB-config resolution fails", () => {
    // Go's Execute() runs ensureProjectGroupsCached after ExecuteC returns even on
    // error (root.go:171-181), and ParseDatabaseConfig sets ProjectRef via
    // LoadProjectRef BEFORE the fallible temp-role/connection step — so a failed
    // linked resolve must not skip the post-run linked-project cache write.
    const { layer, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      resolveFails: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(LEGACY_VALID_REF);
    });
  });

  it.live("resets to a specific version, applying only migrations up to it", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        ...migrationFile("20240202000000"),
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        version: Option.some("20240101000000"),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting remote database to version: 20240101000000");
      expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
      expect(out.stderrText).not.toContain("Applying migration 20240202000000_test.sql...");
      expect(conn).toBeDefined();
    });
  });

  it.live("resolves --last to a version prefix", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        ...migrationFile("20240202000000"),
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      // last=1 → revert the most recent → reset to version 20240101000000.
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true, last: Option.some(1) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Resetting remote database to version: 20240101000000");
    });
  });

  it.live("reverts all migrations when --last covers the full history", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      confirm: [true],
    });
    return Effect.gen(function* () {
      // last=2 with 2 local migrations → revert all → version "-".
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true, last: Option.some(2) }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).toContain("Resetting remote database to version: -");
    });
  });

  it.live("skips seeding with --no-seed", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true, noSeed: true }).pipe(
        Effect.provide(layer),
      );
      expect(out.stderrText).not.toContain("Seeding data from");
    });
  });

  it.live("delegates an experimental remote reset to the Go binary", () => {
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0]!.args).toEqual(["db", "reset", "--linked", "--yes=false"]);
      expect(proxy.calls[0]!.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
    });
  });

  it.live("does not resolve a linked DB connection before delegating an experimental reset", () => {
    const { layer, proxy, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(proxy.calls).toHaveLength(1);
      // The delegated Go child re-runs its own connection resolution (including
      // minting/verifying the temp login role) once it starts — the TS wrapper
      // must not do that same Management-API work first only to discard it (CLI-1879).
      expect(resolver.calls).toBe(0);
    });
  });

  it.live("still caches the linked ref when delegating an experimental reset", () => {
    // `linkedRefForCache` is pre-loaded via `LegacyProjectRefResolver.loadProjectRef`
    // separately from `resolver.resolve()`, specifically so the post-run
    // linked-project-cache finalizer still fires on this path even though
    // `resolve()` itself is skipped entirely (CLI-1879).
    const { layer, linkedCache } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
      ref: LEGACY_VALID_REF,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(LEGACY_VALID_REF);
    });
  });

  it.live(
    "surfaces a delegated experimental-reset child failure as a LegacyGoChildExitError under json output",
    () => {
      const { layer } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        experimental: true,
        format: "json",
        execCaptureExitCode: 3,
      });
      return Effect.gen(function* () {
        // Under json/stream-json, the delegated path uses `execCapture` (non-text
        // branch of `delegateExperimentalReset`) — this must flow through the normal
        // Effect failure channel (reachable by `withJsonErrorHandling` at the
        // command-wiring layer) instead of an immediate `ProcessControl.exit()` that a
        // handler-level test could never observe (CLI-1879).
        const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(LegacyGoChildExitError);
          expect((error as LegacyGoChildExitError).exitCode).toBe(3);
        }
      });
    },
  );

  it.live(
    "propagates the storage-ready check's exact exit code and still flushes telemetry on a local reset",
    () => {
      // The bootstrap seam's `awaitStorageReady` (the `captureStdout` bootstrap-child
      // path) failing non-zero must reach the handler as the exact `LegacyGoChildExitError`
      // it fails with, and the handler's own `Effect.ensuring(telemetryState.flush)`
      // finalizer must still run despite the typed failure (CLI-1879).
      const { layer, telemetry } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset"],
        isLocal: true,
        running: true,
        awaitStorageReadyExitCode: 4,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(LegacyGoChildExitError);
          expect((error as LegacyGoChildExitError).exitCode).toBe(4);
        }
        expect(telemetry.flushed).toBe(true);
      });
    },
  );

  it.live("forwards the linked selector to the delegate even for --linked=false", () => {
    // Cobra `Changed` semantics: `--linked=false` still selects the linked/remote target in
    // the parent, so the delegated argv must carry `--linked` — otherwise the Go child falls
    // back to its local default and resets the wrong database.
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
      args: ["db", "reset", "--linked=false"],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: false }).pipe(Effect.provide(layer));
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0]!.args).toEqual(["db", "reset", "--linked", "--yes=false"]);
    });
  });

  it.live("forwards --yes=false to the delegate even when SUPABASE_YES is set", () => {
    // Explicit `--yes=false` beats `AutomaticEnv` in Go; the delegated child must receive the
    // bound false flag so an inherited `SUPABASE_YES=true` doesn't auto-confirm the reset and
    // drop the remote schemas the user tried to protect.
    const previous = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "true";
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
      args: ["db", "reset", "--linked", "--yes=false"],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(proxy.calls[0]!.args).toContain("--yes=false");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = previous;
        }),
      ),
    );
  });

  it.live("forwards --yes=true to the delegate when --yes is set", () => {
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
      args: ["db", "reset", "--linked", "--yes"],
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(proxy.calls[0]!.args).toContain("--yes=true");
    });
  });

  it.live(
    "takes the experimental delegate path via SUPABASE_EXPERIMENTAL in the project .env",
    () => {
      // Go loads nested env before reset.Run reads viper EXPERIMENTAL, so the versionless remote
      // reset delegates to the Go binary rather than replaying migrations natively.
      const previous = process.env["SUPABASE_EXPERIMENTAL"];
      delete process.env["SUPABASE_EXPERIMENTAL"];
      const { layer, proxy, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: { "supabase/.env": "SUPABASE_EXPERIMENTAL=true\n" },
        // No experimental flag / shell env — only the project .env sets it.
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
        expect(proxy.calls).toHaveLength(1);
        // Delegated, so the native remote path never dropped schemas.
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(false);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
            else process.env["SUPABASE_EXPERIMENTAL"] = previous;
          }),
        ),
      );
    },
  );

  it.live("attaches the Go seed-flag conflict suggestion to --no-seed + --sql-paths", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        noSeed: true,
        sqlPaths: ["seed.sql"],
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("--no-seed cannot be used with --sql-paths");
        // Go's validateDbResetSeedFlags CmdSuggestion, rendered as a Suggestion: line.
        expect(JSON.stringify(exit.cause)).toContain("Use either");
      }
    });
  });

  it.live("forwards --db-url and --no-seed on an experimental remote db-url reset", () => {
    const { layer, proxy, resolver } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
      args: ["db", "reset", "--db-url", "postgresql://db.example.com:5432/postgres"],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        dbUrl: Option.some("postgresql://db.example.com:5432/postgres"),
        noSeed: true,
      }).pipe(Effect.provide(layer));
      expect(proxy.calls[0]!.args).toEqual([
        "db",
        "reset",
        "--db-url",
        "postgresql://db.example.com:5432/postgres",
        "--no-seed",
        "--yes=false",
      ]);
      // Unlike the `connType === "linked"` branch above, a `--db-url` target still
      // resolves a connection before delegating — the pre-delegation skip (CLI-1879)
      // is scoped to the linked branch only, not "never call resolve when delegating".
      expect(resolver.calls).toBe(1);
    });
  });

  it.live("passes --no-seed and the resolved --last version to the recreate seam", () => {
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: { ...migrationFile("20240101000000"), ...migrationFile("20240202000000") },
      args: ["db", "reset", "--local"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      // last=1 with 2 local migrations → recreate up to version 20240101000000.
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        local: true,
        noSeed: true,
        last: Option.some(1),
      }).pipe(Effect.provide(layer));
      expect(seam.recreateCalls).toEqual([
        { version: "20240101000000", noSeed: true, sqlPaths: [] },
      ]);
    });
  });

  it.live("recreates to a specific --version on a local db-url reset", () => {
    const { layer, out, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      args: ["db", "reset", "--db-url", "postgresql://localhost:54322/postgres"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        dbUrl: Option.some("postgresql://localhost:54322/postgres"),
        version: Option.some("20240101000000"),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting local database to version: 20240101000000");
      expect(seam.recreateCalls).toEqual([
        { version: "20240101000000", noSeed: false, sqlPaths: [] },
      ]);
    });
  });

  it.live("resets a remote --db-url target without loading a remote config override", () => {
    const { layer, out, conn } = setup(tmp.current, {
      // No config file → embedded defaults (migrations + seed enabled).
      files: migrationFile("20240101000000"),
      args: ["db", "reset", "--db-url", "postgresql://db.example.com:5432/postgres"],
      isLocal: false,
      omitRef: true,
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        dbUrl: Option.some("postgresql://db.example.com:5432/postgres"),
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Resetting remote database...");
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
    });
  });

  it.live("announces a matching [remotes.*] override", () => {
    const { layer, out } = setup(tmp.current, {
      toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${LEGACY_VALID_REF}"\n`,
      confirm: [true],
      ref: LEGACY_VALID_REF,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Loading config override: [remotes.preview]");
    });
  });

  it.live("skips migrations and seed when both are disabled in config", () => {
    const { layer, out, conn } = setup(tmp.current, {
      toml: 'project_id = "test"\n\n[db.migrations]\nenabled = false\n\n[db.seed]\nenabled = false\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/seed.sql": "insert into t values (1);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      // Schemas are still dropped, but nothing is applied or seeded.
      expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
      expect(out.stderrText).not.toContain("Applying migration");
      expect(out.stderrText).not.toContain("Seeding data from");
    });
  });

  it.live("emits a json result for a confirmed remote reset (--yes)", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      format: "json",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["target"]).toBe("remote");
    });
  });

  it.live("emits a json result for a confirmed remote reset", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      format: "json",
    });
    return Effect.gen(function* () {
      // json mode is non-interactive → prompt takes the default (false) → cancel.
      const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      // default-false prompt in non-text mode declines → context canceled.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out).toBeDefined();
    });
  });

  it.live("rejects --no-seed together with --sql-paths", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        noSeed: true,
        sqlPaths: ["seed.sql"],
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("--no-seed cannot be used with --sql-paths");
      }
    });
  });

  it.live("rejects an empty --sql-paths value", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        sqlPaths: [""],
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "--sql-paths requires a non-empty path or glob pattern",
        );
      }
    });
  });

  it.live("rejects a negative --last value", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        last: Option.some(-1),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const cause = JSON.stringify(exit.cause);
        expect(cause).toContain("invalid argument");
        expect(cause).toContain("strconv.ParseUint");
      }
    });
  });

  it.live("seeds an absolute --sql-paths file on a remote reset", () => {
    const absSeed = join(tmp.current, "external-seed.sql");
    writeFileSync(absSeed, "insert into t values (3);");
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      files: migrationFile("20240101000000"),
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        sqlPaths: [absSeed],
      }).pipe(Effect.provide(layer));
      // Absolute paths are preserved (not prefixed with supabase/) and seeded.
      expect(out.stderrText).toContain(`Seeding data from ${absSeed}...`);
    });
  });

  it.live("warns and seeds from --sql-paths overriding config on a remote reset", () => {
    const { layer, out } = setup(tmp.current, {
      // Seed disabled in config — --sql-paths must force-enable it.
      toml: 'project_id = "test"\n\n[db.seed]\nenabled = false\n',
      files: {
        ...migrationFile("20240101000000"),
        "supabase/custom-seed.sql": "insert into t values (2);",
      },
      confirm: [true],
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        sqlPaths: ["custom-seed.sql"],
      }).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("--sql-paths overrides [db.seed].sql_paths");
      expect(out.stderrText).toContain("Seeding data from supabase/custom-seed.sql...");
    });
  });

  it.live("forwards --sql-paths to the recreate seam on a local reset", () => {
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["db", "reset", "--local"],
      isLocal: true,
      running: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        local: true,
        sqlPaths: ["custom-seed.sql", "demo/*.sql"],
      }).pipe(Effect.provide(layer));
      expect(seam.recreateCalls).toEqual([
        { version: "", noSeed: false, sqlPaths: ["custom-seed.sql", "demo/*.sql"] },
      ]);
    });
  });

  it.live("forwards --sql-paths to the Go binary on an experimental remote reset", () => {
    const { layer, proxy } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      experimental: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbReset({
        ...DEFAULT_FLAGS,
        linked: true,
        sqlPaths: ["custom-seed.sql"],
      }).pipe(Effect.provide(layer));
      expect(proxy.calls[0]!.args).toEqual([
        "db",
        "reset",
        "--linked",
        "--sql-paths",
        "custom-seed.sql",
        "--yes=false",
      ]);
    });
  });
});
