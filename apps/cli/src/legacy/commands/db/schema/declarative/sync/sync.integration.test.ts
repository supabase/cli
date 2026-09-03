import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { stripAnsi } from "../../../../../../../tests/helpers/ansi.ts";
import {
  alwaysReadyHttpClientLayer,
  defaultLocalResetRoute,
  legacyLocalResetCreateArgs,
  legacyLocalResetRemovedContainers,
  mockContainerCliSpawner,
} from "../../../../../../../tests/helpers/legacy-local-reset.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyShadowCacheDisabled,
  useLegacyTempWorkdir,
} from "../../../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { LegacyPlatformApi } from "../../../../../auth/legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "../../../../../auth/legacy-platform-api-factory.service.ts";
import { legacyDockerRunLayer } from "../../../../../shared/legacy-docker-run.layer.ts";
import { LegacyDbConfigResolver } from "../../../../../shared/legacy-db-config.service.ts";
import {
  type LegacyDbBatchStatement,
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../../../shared/legacy-db-connection.service.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyPgDeltaLegacyEngineLayer } from "../../../shared/legacy-pgdelta-engine.legacy.layer.ts";
import {
  LegacyPgDeltaEngine,
  LegacyPgDeltaEngineError,
  type LegacyPgDeltaRemovalSummary,
  type LegacyPgDeltaRenderedFile,
} from "../../../shared/legacy-pgdelta-engine.service.ts";
import { LegacyDeclarativeShadowDbError } from "../../../shared/legacy-pgdelta.errors.ts";
import { LegacyDeclarativeSeam } from "../../../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbSchemaDeclarativeSyncFlags } from "./sync.command.ts";
import { legacyDbSchemaDeclarativeSync } from "./sync.handler.ts";

const EXPORT_JSON = JSON.stringify({
  version: 1,
  mode: "declarative",
  files: [
    {
      path: "schemas/public/tables/players.sql",
      order: 0,
      statements: 1,
      sql: "create table players ();",
    },
  ],
});

interface SetupOpts {
  experimental?: boolean;
  args?: ReadonlyArray<string>;
  yes?: boolean;
  stdinIsTty?: boolean;
  diffSql?: string;
  replannedDiffSql?: string;
  applyFails?: boolean;
  /**
   * Makes the recovery reset's `legacyResetLocalDatabase` fail immediately with
   * `LegacyResetLocalDbNotRunningError` (the local `db` container reports as not
   * running) instead of completing a real recreate.
   */
  resetShouldFail?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  promptSelectResponses?: ReadonlyArray<string>;
  promptTextResponses?: ReadonlyArray<string>;
  networkId?: string;
  projectId?: Option.Option<string>;
  staleLocalImage?: boolean;
  exportJson?: string;
  engineImplementation?: "legacy" | "next";
  renderedFiles?: ReadonlyArray<LegacyPgDeltaRenderedFile>;
  removals?: LegacyPgDeltaRemovalSummary;
  planErrors?: ReadonlyArray<LegacyPgDeltaEngineError>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const localPostgresImageChecks: Array<true> = [];
  const platformApi = mockLegacyPlatformApiService({});
  // Backs `legacyResetLocalDatabase`'s real, native container-recreate — reached
  // when the recovery-reset offer is accepted (CLI-2062: it now runs in-process
  // instead of shelling out to a second `supabase-go` child).
  const child = mockContainerCliSpawner(
    defaultLocalResetRoute("test", { running: opts.resetShouldFail !== true }),
  );
  // Each catalog export records how many raw chunks had been emitted when it fired,
  // so tests can assert output ordering relative to the exports (e.g. the bootstrap's
  // written-to line lands after the declarative warm, before the diff's exports).
  const exportCatalogCalls: Array<{ mode: string; rawChunksAt: number }> = [];
  // The migrations-catalog source now resolves natively (CLI-1959 cache mechanics
  // + CLI-1956 shadow provisioning) via `legacyGetMigrationsCatalogRef`, which
  // provisions its shadow through the SAME `legacyCreateShadowDatabase`/
  // `legacyPrepareShadowSource`/`legacyRemoveShadowDatabase` primitives `db
  // diff`/`db pull` use for their own shadow — via `child.layer`/
  // `legacyDockerRunLayer` below (the same real container-lifecycle mocks
  // `legacyResetLocalDatabase`'s own recovery-reset flow already needs), not the
  // retired `db __shadow` seam. "baseline"/"declarative" still go through
  // `exportCatalog`.
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode }) =>
      Effect.sync(() => {
        exportCatalogCalls.push({ mode, rawChunksAt: out.rawChunks.length });
        return `supabase/.temp/pgdelta/${mode}.json`;
      }),
    ensureLocalDatabaseStarted: () => Effect.void,
    ensureLocalPostgresImageCurrent: () =>
      Effect.sync(() => {
        localPostgresImageChecks.push(true);
      }).pipe(
        Effect.flatMap(() =>
          opts.staleLocalImage === true
            ? Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message: "local Postgres container image is stale",
                }),
              )
            : Effect.void,
        ),
      ),
  });
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      // The native migrations-catalog resolution's shadow export — return a fixed,
      // non-empty snapshot so it never trips `legacyExportCatalogPgDelta`'s
      // empty-output check regardless of what `opts.diffSql` a given test sets.
      if (runOpts.errPrefix === "error exporting pg-delta catalog") {
        return Effect.succeed({ stdout: '{"schemas":[]}', stderr: "" });
      }
      if (
        opts.exportJson !== undefined &&
        runOpts.errPrefix === "error exporting declarative schema"
      ) {
        return Effect.succeed({ stdout: opts.exportJson, stderr: "" });
      }
      const diffSql = opts.diffSql ?? "";
      // The pg-delta diff script (uniquely identified by `renderPlanFiles`) prints a
      // JSON envelope with one file per plan unit; wrap the test's raw SQL into a
      // single-unit envelope so `legacyDiffPgDelta` parses it.
      const stdout =
        runOpts.script.includes("renderPlanFiles") && diffSql.length > 0
          ? JSON.stringify({
              version: 1,
              files: [
                {
                  order: 1,
                  name: "schema_changes",
                  transactionMode: "transactional",
                  sql: diffSql,
                },
              ],
            })
          : diffSql;
      return Effect.succeed({ stdout, stderr: "" });
    },
  });
  const dbExec: string[] = [];
  const dbBatches: Array<ReadonlyArray<string>> = [];
  // Go's default `[db] shadow_port` (`legacy-db-config.toml-read.ts`'s
  // `DEFAULT_SHADOW_PORT`) — none of these tests override it. The migrations-
  // catalog resolution's shadow (CLI-1956) now ALSO connects through this same
  // fake `LegacyDbConnection` for its own platform-baseline setup/migration
  // replay, so its SQL (BEGIN/REVOKE.../CREATE DATABASE contrib_regression) must
  // be excluded from `dbExec`, which every "not yet applied" assertion below
  // expects to stay empty until the REAL local-apply connection
  // (`applyMigrationToLocal`, `toml.port`) runs.
  const SHADOW_PORT = 54320;
  const dbConn = Layer.succeed(LegacyDbConnection, {
    connect: (cfg: LegacyPgConnInput) =>
      Effect.succeed({
        exec: (sql: string) =>
          opts.applyFails === true && sql.startsWith("ALTER")
            ? Effect.fail({ _tag: "LegacyDbExecError", message: "boom" } as never)
            : Effect.sync(() => {
                if (cfg.port !== SHADOW_PORT) dbExec.push(sql);
              }),
        execBatch: (statements: ReadonlyArray<LegacyDbBatchStatement>) => {
          const sql = statements.map((statement) => statement.sql);
          const failureIndex =
            opts.applyFails === true
              ? sql.findIndex((statement) => statement.startsWith("ALTER"))
              : -1;
          return failureIndex >= 0
            ? Effect.fail({
                _tag: "LegacyDbExecError",
                message: "boom",
                statementIndex: failureIndex,
              } as never)
            : Effect.sync(() => {
                if (cfg.port !== SHADOW_PORT) {
                  dbBatches.push(sql);
                  dbExec.push(...sql);
                }
              });
        },
        query: (sql: string) =>
          Effect.sync(() => {
            if (cfg.port !== SHADOW_PORT) dbExec.push(sql);
            return [];
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
      }),
  });
  // The no-files bootstrap delegates to the shared smart-target resolver; its
  // local path never calls `resolve`, but the linked/custom branches would.
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: () =>
      Effect.succeed({
        conn: {
          host: "db.remote",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  const sslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.succeed(false),
    requireSslForHost: () => Effect.succeed(false),
  });
  const runtimeInfo = mockRuntimeInfo({ platform: "linux" });
  const processControl = mockProcessControl();
  const experimentalFlag = Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true);
  const cliArgs = Layer.succeed(CliArgs, {
    args: opts.args ?? ["db", "schema", "declarative", "sync"],
  });
  const networkIdFlag = Layer.succeed(
    LegacyNetworkIdFlag,
    opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
  );
  const debugFlag = Layer.succeed(LegacyDebugFlag, false);
  const dockerRun = legacyDockerRunLayer.pipe(
    Layer.provide(child.layer),
    Layer.provide(processControl.layer),
  );
  const engineRuntime = Layer.mergeAll(
    seam,
    edge,
    sslProbe,
    out.layer,
    dbConn,
    runtimeInfo,
    experimentalFlag,
    cliArgs,
    networkIdFlag,
    debugFlag,
    processControl.layer,
    alwaysReadyHttpClientLayer,
    dockerRun,
    BunServices.layer,
    child.layer,
  );
  const nextFiles = opts.renderedFiles ?? [];
  const planErrors = [...(opts.planErrors ?? [])];
  let planCalls = 0;
  const declarativeExportCalls: Array<ReadonlyArray<string>> = [];
  const engine =
    opts.engineImplementation === "next"
      ? Layer.succeed(
          LegacyPgDeltaEngine,
          LegacyPgDeltaEngine.of({
            implementation: "next",
            diffExplicit: () => Effect.die("diffExplicit not used in sync tests"),
            diffDatabase: () => Effect.die("diffDatabase not used in sync tests"),
            exportDeclarativeSchema: (input) =>
              Effect.sync(() => {
                declarativeExportCalls.push(input.schema);
                return {
                  files: [{ name: "public/tables/players.sql", sql: "create table players ();" }],
                  manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
                };
              }),
            planDeclarativeSchema: () => {
              planCalls += 1;
              const planError = planErrors.shift();
              if (planError !== undefined) return Effect.fail(planError);
              const extensionPath = join(workdir, "supabase", "schemas", "extension.sql");
              const extensionSql = existsSync(extensionPath)
                ? readFileSync(extensionPath, "utf8")
                : "";
              const remainingExtensions = (opts.removals?.extensions ?? []).filter(
                (extension) => !extensionSql.includes(`"${extension}"`),
              );
              const extensionsRepaired =
                remainingExtensions.length < (opts.removals?.extensions.length ?? 0);
              return Effect.succeed({
                changes: nextFiles.length > 0,
                sql:
                  extensionsRepaired && opts.replannedDiffSql !== undefined
                    ? opts.replannedDiffSql
                    : (opts.diffSql ?? nextFiles.map((file) => file.sql).join("\n")),
                files: nextFiles,
                sourceRef: "migrations",
                targetRef: "declarative",
                removals:
                  opts.removals === undefined
                    ? undefined
                    : { ...opts.removals, extensions: remainingExtensions },
              });
            },
          }),
        )
      : legacyPgDeltaLegacyEngineLayer.pipe(Layer.provide(engineRuntime));
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    edge,
    engine,
    dbConn,
    resolver,
    mockLegacyCliSettings({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(opts.stdinIsTty ?? false),
    experimentalFlag,
    cliArgs,
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    networkIdFlag,
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    debugFlag,
    // Sync diffs against the local DB, which refuses TLS → no SSL env injected.
    sslProbe,
    // The local-reset bucket-seed core statically requires the (lazy) Management-API
    // factory; never invoked on the local recovery reset (projectRef === "").
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    BunServices.layer,
    // `child.layer` must be listed AFTER `BunServices.layer` — `Layer.mergeAll`
    // resolves a duplicate service tag to whichever layer is listed LAST, so this
    // mock overrides Bun's real `ChildProcessSpawner` instead of the reverse.
    child.layer,
    runtimeInfo,
    processControl.layer,
    alwaysReadyHttpClientLayer,
    dockerRun,
  );
  return {
    layer,
    out,
    child,
    dbExec,
    dbBatches,
    cache,
    telemetry,
    localPostgresImageChecks,
    exportCatalogCalls,
    declarativeExportCalls,
    get planCalls() {
      return planCalls;
    },
  };
}

const flags = (
  over: Partial<LegacyDbSchemaDeclarativeSyncFlags> = {},
): LegacyDbSchemaDeclarativeSyncFlags => ({
  noCache: over.noCache ?? false,
  strictCoverage: over.strictCoverage ?? false,
  schema: over.schema ?? [],
  file: over.file ?? Option.none(),
  name: over.name ?? Option.none(),
  apply: over.apply ?? Option.none(),
  noApply: over.noApply ?? Option.none(),
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const seedDeclarative = (workdir: string, sql = "create table a();") => {
  const dir = join(workdir, "supabase", "schemas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "public.sql"), sql);
};

/** A maintained, converged tree that declares the extensions whose objects it manages. */
const MAINTAINED_TREE_SQL = [
  "create extension if not exists pg_cron with schema pg_catalog;",
  "create extension if not exists pgmq;",
  "create table a();",
  "",
].join("\n");

const migrationSql = (workdir: string) => {
  const dir = join(workdir, "supabase", "migrations");
  const [file] = readdirSync(dir);
  expect(file).toBeDefined();
  return readFileSync(join(dir, file ?? ""), "utf8");
};

const seedLegacyUuidDeclarative = (workdir: string, directory = "schemas") => {
  const dir = join(workdir, "supabase", directory);
  mkdirSync(join(dir, "schemas", "app", "tables"), { recursive: true });
  mkdirSync(join(dir, "schemas", "public", "views"), { recursive: true });
  writeFileSync(
    join(dir, "schemas", "app", "tables", "members.sql"),
    [
      "create table app.members (",
      "  email text not null,",
      "  id uuid not null default extensions.uuid_generate_v4()",
      ");",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "schemas", "public", "views", "members.sql"),
    "create view public.members as select * from app.members;\n",
  );
};

const legacyUuidLoadError = () =>
  new LegacyPgDeltaEngineError({
    message:
      "Declarative schema planning failed: shadow load stuck. Tip: split circular REFERENCES clauses.",
    cause: new Error("shadow load stuck"),
    diagnostics: [
      {
        code: "stuck_statement",
        severity: "error",
        message:
          "0001__schemas/app/tables/members.sql: function extensions.uuid_generate_v4() does not exist (failed identically in 6 rounds)",
      },
      {
        code: "stuck_statement",
        severity: "error",
        message: '0002__schemas/public/views/members.sql: relation "app.members" does not exist',
      },
    ],
  });

describe("legacy db schema declarative sync integration", () => {
  const tmp = useLegacyTempWorkdir();
  useLegacyShadowCacheDisabled();

  it.effect("gate: fails when pg-delta is not enabled", () => {
    seedDeclarative(tmp.current);
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--apply and --no-apply together with --experimental fail with the mutex error", () => {
    // Go's declarative PersistentPreRunE gate (db_schema_declarative.go:49-99) runs
    // BEFORE cobra's ValidateFlagGroups() mutex check (cobra@v1.10.2/command.go:985,
    // 1010), so the mutex error only surfaces once the gate is open.
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(
          flags({ apply: Option.some(true), noApply: Option.some(true) }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
        message:
          "if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "--apply and --no-apply together without --experimental fail with the gate error, not the mutex error",
    () => {
      // Mirrors storage's experimental-gate-vs-mutex ordering fix (CLI-1855 / CLI-1876):
      // the pg-delta gate runs before the mutex check, so an unopened gate wins even
      // when the flags would also violate mutual exclusivity.
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeSync(
            flags({ apply: Option.some(true), noApply: Option.some(true) }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--apply and --no-apply together with SUPABASE_EXPERIMENTAL env (no --experimental flag) fail with the mutex error",
    () => {
      // Go's gate reads viper.GetBool("EXPERIMENTAL") (db_schema_declarative.go:78),
      // which picks up SUPABASE_EXPERIMENTAL via viper.AutomaticEnv (root.go:318-334),
      // so an env-only experimental session still opens the gate and lets the mutex
      // check fire. legacyResolveExperimental (not the raw LegacyExperimentalFlag) is
      // what makes the TS gate honor the env var the same way.
      const { layer } = setup(tmp.current, { experimental: false });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeSync(
            flags({ apply: Option.some(true), noApply: Option.some(true) }),
          ),
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
          message:
            "if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an explicit --experimental=false closes the gate even when SUPABASE_EXPERIMENTAL is set",
    () => {
      // viper's bound-pflag lookup returns the flag value whenever Changed is true —
      // BEFORE falling back to AutomaticEnv (viper@v1.21.0/viper.go:1176-1178) — so an
      // explicit --experimental=false must win over SUPABASE_EXPERIMENTAL=1, closing the
      // gate instead of letting the env value override it.
      const { layer } = setup(tmp.current, {
        experimental: false,
        args: ["db", "schema", "declarative", "sync", "--experimental=false"],
      });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--apply and --no-apply together with SUPABASE_EXPERIMENTAL set only in the project .env fail with the mutex error",
    () => {
      // Go's flags.LoadConfig runs loadNestedEnv (which os.Setenv's each project-.env key)
      // before dbDeclarativeCmd.PersistentPreRunE reads viper.GetBool("EXPERIMENTAL")
      // (apps/cli-go/cmd/db_schema_declarative.go:73-78, deleted in CLI-1970; last
      // present at commit 7b469f5b3; pkg/config/config.go:789), so a
      // SUPABASE_EXPERIMENTAL set only in supabase/.env opens the gate and lets the mutex
      // check fire, same as the shell-env case above.
      const saved = process.env["SUPABASE_EXPERIMENTAL"];
      delete process.env["SUPABASE_EXPERIMENTAL"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_EXPERIMENTAL=true\n");
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyDbSchemaDeclarativeSync(
            flags({ apply: Option.some(true), noApply: Option.some(true) }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
          message:
            "if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set",
        });
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (saved === undefined) delete process.env["SUPABASE_EXPERIMENTAL"];
            else process.env["SUPABASE_EXPERIMENTAL"] = saved;
          }),
        ),
      );
    },
  );

  it.effect("rejects --apply=false --no-apply as a conflict (Go flag.Changed)", () => {
    // cobra keys the mutex off flag.Changed, so an explicit `--apply=false` still
    // counts as set and conflicts with `--no-apply`, even though its value is false.
    // The gate runs first (see legacyRequirePgDelta's doc comment), so --experimental
    // is required here for the mutex error to be the one that surfaces.
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(
          flags({ apply: Option.some(false), noApply: Option.some(true) }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when there are no declarative files", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "no declarative schema found",
      );
      // No tree under the former default either — nothing to point at.
      expect(stripAnsi(s.out.stderrText)).not.toContain("WARNING: found declarative schema files");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("warns when the tree still lives under the former supabase/database default", () => {
    // Upgrade path: the implicit default moved from supabase/database to
    // supabase/schemas. A project that generated under the old default and never
    // set declarative_schema_path must get an explanation, not a bare
    // "no declarative schema found".
    const formerDir = join(tmp.current, "supabase", "database");
    mkdirSync(formerDir, { recursive: true });
    writeFileSync(join(formerDir, "public.sql"), "create table a();");
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stripAnsi(s.out.stderrText)).toContain(
        "WARNING: found declarative schema files in supabase/database, but the default declarative directory is now supabase/schemas.",
      );
      expect(stripAnsi(s.out.stderrText)).toContain('declarative_schema_path = "./database"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("non-interactive default dry-run does not check the local Postgres image", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      staleLocalImage: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags());
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
      expect(migrations).toHaveLength(1);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.dbExec).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--apply checks the local Postgres image before applying", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      staleLocalImage: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ apply: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.dbExec).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--no-apply skips the local Postgres image check", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      staleLocalImage: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
      expect(migrations).toHaveLength(1);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.dbExec).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--yes bypasses the bootstrap prompt when no declarative files exist", () => {
    // Without --yes + non-TTY this fails at the "no declarative schema found" gate
    // (prior test). With --yes, Go's PromptYesNo auto-confirms, so the bootstrap is
    // attempted instead — it must NOT fail at that gate. No promptConfirm is queued,
    // so reaching the prompt would also error.
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: true, diffSql: "" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })),
      );
      expect(JSON.stringify(exit)).not.toContain("no declarative schema found");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap prints the declarative-schema-written line after the catalog warm", () => {
    // Go's bootstrap delegates to `declarative.Generate`, which prints
    // `Declarative schema written to <dir>` to stderr AFTER WriteDeclarativeSchemas
    // and the catalog warm (`declarative.go:133→138-155→156`), before sync's own
    // diff (step 2). It prints `utils.GetDeclarativeDir()` — the relative
    // `supabase/schemas` default — never the absolute resolved dir (CLI-1980).
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      exportJson: EXPORT_JSON,
      promptConfirmResponses: [true], // generate a new one? yes (no migrations → no reset prompt)
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const line = `Declarative schema written to ${join("supabase", "schemas")}\n`;
      const written = s.out.rawChunks
        .map((c, index) => ({ text: stripAnsi(c.text), stream: c.stream, index }))
        .filter((c) => c.text === line);
      expect(written).toHaveLength(1);
      expect(written[0]?.stream).toBe("stderr");
      const lineAt = written[0]?.index ?? -1;
      // The warm (first declarative-mode export) fires before the line is printed…
      const warm = s.exportCatalogCalls.find((c) => c.mode === "declarative");
      expect(warm?.rawChunksAt).toBeLessThanOrEqual(lineAt);
      // …and the diff's migrations-catalog resolution (native, CLI-1959 cache
      // mechanics + CLI-1956 native shadow provisioning — no seam `exportCatalog`
      // call for it at all) fires after it, so the line sits at the end of the
      // bootstrap, matching Go's ordering. `legacyGetMigrationsCatalogRef` prints
      // "Creating shadow database..." right before provisioning; use that line's
      // own position as the "diff's shadow started" signal.
      const diffStartIndex = s.out.rawChunks.findIndex(
        (c) => c.stream === "stderr" && stripAnsi(c.text) === "Creating shadow database...\n",
      );
      expect(diffStartIndex).toBeGreaterThan(lineAt);
      // The generated files actually landed in the printed (resolved) dir.
      expect(
        existsSync(
          join(tmp.current, "supabase", "schemas", "schemas", "public", "tables", "players.sql"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--yes bootstrap prints the declarative-schema-written line too", () => {
    // Go reaches the same delegated `declarative.Generate` print on the
    // auto-confirmed (--yes / SUPABASE_YES) bootstrap as on the interactive accept.
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: false,
      yes: true,
      diffSql: "",
      exportJson: EXPORT_JSON,
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${join("supabase", "schemas")}\n`,
        stream: "stderr",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--no-cache bootstrap still prints the declarative-schema-written line", () => {
    // Go's print sits OUTSIDE the `if !noCache` warm gate (`declarative.go:138-156`):
    // skipping the catalog warm must not skip the line.
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: false,
      yes: true,
      diffSql: "",
      exportJson: EXPORT_JSON,
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noCache: true, noApply: Option.some(true) }));
      const line = `Declarative schema written to ${join("supabase", "schemas")}\n`;
      const written = s.out.rawChunks
        .map((c, index) => ({ text: stripAnsi(c.text), stream: c.stream, index }))
        .filter((c) => c.text === line);
      expect(written).toHaveLength(1);
      expect(written[0]?.stream).toBe("stderr");
      // The warm really was skipped: the only declarative-mode export is the diff's,
      // which fires after the line — yet the line still printed.
      const lineAt = written[0]?.index ?? -1;
      const declarativeExports = s.exportCatalogCalls.filter((c) => c.mode === "declarative");
      expect(declarativeExports).toHaveLength(1);
      expect(declarativeExports[0]?.rawChunksAt).toBeGreaterThan(lineAt);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "validates the migrations-catalog shadow's own local config (api.tls cert file) BEFORE printing 'Creating shadow database...'",
    () => {
      // `legacyGetMigrationsCatalogRef`'s own second `@supabase/config` load
      // (`legacyBuildLocalDbContainerInputs`, run via `legacyBuildShadowCatalogInputs`)
      // validates fields (e.g. an enabled API TLS's cert/key files) that `toml` never
      // reads — Go performs this exact validation once, in the root
      // `PersistentPreRunE`, strictly before `declarative.go`'s `createShadowContainer`
      // ever prints "Creating shadow database..." (`declarative.go:490`). So a broken
      // build must fail here without ever printing that banner.
      seedDeclarative(tmp.current);
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          "[api]",
          "enabled = true",
          "[api.tls]",
          "enabled = true",
          'cert_path = "missing-cert.pem"',
          'key_path = "missing-key.pem"',
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, { experimental: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect((failError(exit) as { message: string }).message).toContain(
          "failed to read TLS cert",
        );
        expect(
          s.out.rawChunks.some(
            (c) => c.stream === "stderr" && stripAnsi(c.text) === "Creating shadow database...\n",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("bootstrap with migrations offers the smart target choice (not local-only)", () => {
    // Go delegates the no-files bootstrap to runDeclarativeGenerate; with migrations
    // present it offers local/linked/custom rather than silently generating from
    // local. projectId "test" is an invalid ref so the linked choice is hidden.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      promptConfirmResponses: [true, false], // [generate a new one? yes][reset? no]
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })));
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "custom"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap linked target does not run the local Postgres image check", () => {
    // The stale-image guard only matters once bootstrap chooses a local source. A
    // linked/custom bootstrap can build fresh catalogs and skip local apply, so it
    // must reach the target prompt before any local-container inspection.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      staleLocalImage: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
      promptConfirmResponses: [true], // generate a new one? yes
      promptSelectResponses: ["linked"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ noCache: true, noApply: Option.some(true) })),
      );
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(JSON.stringify(exit)).not.toContain("local Postgres container image is stale");
      expect((s.out.promptSelectCalls[0]?.options ?? []).map((o) => o.value)).toEqual([
        "local",
        "linked",
        "custom",
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap linked target checks the local Postgres image before apply", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      staleLocalImage: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      exportJson: EXPORT_JSON,
      promptConfirmResponses: [true], // generate a new one? yes
      promptSelectResponses: ["linked"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(
          flags({
            noCache: true,
            apply: Option.some(true),
            name: Option.some("bootstrap_apply"),
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.dbExec).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap local target checks the local Postgres image", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      staleLocalImage: true,
      promptConfirmResponses: [true], // generate a new one? yes
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ noCache: true, noApply: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap: an unreadable migrations path is treated as no migrations", () => {
    // Go's delegated hasMigrationFiles returns false on ANY ListLocalMigrations error
    // (db_schema_declarative.go:164-169), flowing into the no-migrations local generate.
    // Seeding supabase/migrations as a FILE makes the probe's list fail with ENOTDIR; it
    // must be swallowed so the bootstrap reaches generation, not abort on the read.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations"), "not a directory");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      promptConfirmResponses: [true], // generate a new one? yes (no reset prompt: no migrations)
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })),
      );
      // The probe was softened: it reached generation and failed downstream on the
      // empty edge-runtime output, NOT on the migrations directory read.
      const msg = JSON.stringify(exit);
      expect(msg).not.toContain("failed to read directory");
      expect(msg).toContain("edge-runtime script produced no output");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap: an unreadable ref file just omits the linked choice", () => {
    // Go ignores smart-prompt LoadProjectRef errors (`if err == nil`,
    // db_schema_declarative.go:222-224): a broken .temp/project-ref omits the linked
    // choice and bootstrap continues. Seeding project-ref as a DIRECTORY makes the read
    // fail; the bootstrap smart read must swallow it, not abort.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    mkdirSync(join(tmp.current, "supabase", ".temp", "project-ref"), { recursive: true });
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      projectId: Option.none(),
      promptConfirmResponses: [true, false], // [generate a new one? yes][reset? no]
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })),
      );
      // Reached the smart prompt (didn't abort on the ref read); linked choice omitted.
      expect((s.out.promptSelectCalls[0]?.options ?? []).map((o) => o.value)).toEqual([
        "local",
        "custom",
      ]);
      expect(JSON.stringify(exit)).not.toContain("failed to load project ref");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap caches the linked project even when a later step fails (Go PostRun)", () => {
    // Go's bootstrap delegates to runDeclarativeGenerate, whose LoadProjectRef (under
    // hasMigrationFiles) sets flags.ProjectRef; root ensureProjectGroupsCached then
    // writes the linked-project cache on success OR failure (cmd/root.go:176,214-218).
    // Here the bootstrap resolves the linked ref then fails (empty generate output),
    // and the linked-project cache must still be written.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      projectId: Option.some("abcdefghijklmnopqrst"),
      promptConfirmResponses: [true, false], // [generate a new one? yes][reset? no]
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })));
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("does not cache when the workdir is not linked", () => {
    // No project_id and no .temp/project-ref file → no ref resolves in the bootstrap,
    // so flags.ProjectRef stays empty in Go and nothing is cached.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      projectId: Option.none(),
      promptConfirmResponses: [true, false],
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })));
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("empty diff prints 'No schema changes found' and writes nothing", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, { experimental: true, diffSql: "" });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(s.out.rawChunks.some((c) => c.text.includes("No schema changes found"))).toBe(true);
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--no-apply: writes the timestamped migration, surfaces drop warnings, no apply",
    () => {
      seedDeclarative(tmp.current);
      const s = setup(tmp.current, {
        experimental: true,
        diffSql: "ALTER TABLE a ADD COLUMN b int;\nDROP TABLE c;\n",
      });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
        const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
        expect(migrations).toHaveLength(1);
        expect(migrations[0]).toMatch(/^\d{14}_declarative_sync\.sql$/);
        expect(s.out.rawChunks.some((c) => c.text.includes("Found drop statements"))).toBe(true);
        expect(s.dbExec).toEqual([]); // not applied
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--apply: batches the migration and history through the native session", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ apply: Option.some(true) }));
      expect(s.dbBatches).toContainEqual([
        "ALTER TABLE a ADD COLUMN b int",
        expect.stringContaining("supabase_migrations.schema_migrations"),
      ]);
      // No reset on success — the recovery reset's container-remove never ran.
      expect(legacyLocalResetRemovedContainers(s.child.spawned)).toEqual([]);
      expect(s.out.rawChunks.some((c) => c.text.includes("Migration applied successfully"))).toBe(
        true,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("refuses a known implicit-extension load failure under --yes", () => {
    seedLegacyUuidDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      yes: true,
      planErrors: [legacyUuidLoadError()],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbSchemaDeclarativeSync(flags()).pipe(Effect.exit);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeCompatibilityError",
        message: expect.stringContaining("schemas/app/tables/members.sql:3"),
      });
      const error = failError(exit);
      expect(error).toMatchObject({
        message: expect.stringContaining("uuid-ossp"),
        // Recovery commands ride on `suggestion` so `Output.fail` prints them
        // instead of the generic "rerun with --debug" footer.
        suggestion: expect.stringContaining(
          "supabase db schema declarative generate --local --overwrite",
        ),
      });
      // Hand-editing extension.sql is a false trail non-interactively: each
      // declaration only unlocks the next refusal.
      expect(JSON.stringify(error)).not.toContain("extension.sql");
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("adds a missing load-time extension declaration and re-plans", () => {
    seedLegacyUuidDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      planErrors: [legacyUuidLoadError()],
      promptSelectResponses: ["repair"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(s.planCalls).toBe(2);
      expect(readFileSync(join(tmp.current, "supabase", "schemas", "extension.sql"), "utf8")).toBe(
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";\n',
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("stages a complete next export without changing the active tree", () => {
    seedLegacyUuidDeclarative(tmp.current);
    const activeMember = join(
      tmp.current,
      "supabase",
      "schemas",
      "schemas",
      "app",
      "tables",
      "members.sql",
    );
    const before = readFileSync(activeMember, "utf8");
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      planErrors: [legacyUuidLoadError()],
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [false], // decline the staged export's reset offer
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(readFileSync(activeMember, "utf8")).toBe(before);
      expect(
        readFileSync(
          join(tmp.current, "supabase", "schemas-next", "public", "tables", "players.sql"),
          "utf8",
        ),
      ).toBe("create table players ();");
      expect(
        existsSync(join(tmp.current, "supabase", "schemas-next", ".pgdelta-export.json")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("stages beside a custom active path and preserves --schema for adoption", () => {
    seedLegacyUuidDeclarative(tmp.current, "custom-declarative");
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "./custom-declarative"',
        "",
      ].join("\n"),
    );
    const activeMember = join(
      tmp.current,
      "supabase",
      "custom-declarative",
      "schemas",
      "app",
      "tables",
      "members.sql",
    );
    const before = readFileSync(activeMember, "utf8");
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      planErrors: [legacyUuidLoadError()],
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [false], // decline the staged export's reset offer
    });

    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ schema: ["app"], noApply: Option.some(true) }));

      expect(readFileSync(activeMember, "utf8")).toBe(before);
      expect(
        existsSync(
          join(tmp.current, "supabase", "custom-declarative-next", ".pgdelta-export.json"),
        ),
      ).toBe(true);
      expect(s.declarativeExportCalls).toEqual([["app"]]);
      expect(stripAnsi(s.out.stderrText)).toContain(
        "rm -rf supabase/custom-declarative && mv supabase/custom-declarative-next supabase/custom-declarative",
      );
      expect(stripAnsi(s.out.stderrText)).toContain(
        "supabase db schema declarative sync --no-apply --schema app --experimental",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("refuses extension-managed legacy gaps under --yes instead of writing drops", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      engineImplementation: "next",
      yes: true,
      diffSql:
        "select cron.unschedule('refresh download metrics');\nDROP EXTENSION \"pgcrypto\";\n",
      removals: {
        extensions: ["pgcrypto", "uuid-ossp"],
        extensionIntents: [
          { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
        ],
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbSchemaDeclarativeSync(flags()).pipe(Effect.exit);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeCompatibilityError",
        // Same unified template as the load-fail gate — only the evidence differs.
        message: expect.stringContaining(
          "This supabase/schemas tree looks like a legacy pg-delta export.",
        ),
        suggestion: expect.stringContaining(
          "Upgrade without changing the active supabase/schemas tree:",
        ),
      });
      expect(failError(exit)).toMatchObject({
        message: expect.stringContaining("  Extension-managed objects: pg_cron job refresh"),
      });
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honours deleting a pgmq queue from a maintained tree as a destructive change", () => {
    // Dogfooding scenario (CLI-2282): the tree declares pgmq, one queue declaration
    // is removed alongside unrelated schema work. Previously the whole sync — the
    // unrelated work included — was refused as a legacy export.
    seedDeclarative(tmp.current, MAINTAINED_TREE_SQL);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      yes: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\nselect pgmq.drop_queue('emails');\n",
      removals: {
        extensions: [],
        extensionIntents: [{ extension: "pgmq", intentKind: "queue", key: "emails" }],
      },
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(migrationSql(tmp.current)).toContain("pgmq.drop_queue('emails')");
      const stderr = stripAnsi(s.out.stderrText);
      expect(stderr).not.toContain("looks like a legacy pg-delta export");
      expect(stderr).toContain(
        "Found destructive changes in schema diff. Please double check if these are expected:\npgmq queue emails",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("renames a pg_cron job on a maintained tree without refusing", () => {
    seedDeclarative(tmp.current, MAINTAINED_TREE_SQL);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      yes: true,
      diffSql: [
        "select cron.unschedule('refresh metrics');",
        "select cron.schedule('refresh download metrics', '0 * * * *', $$select 1$$);",
        "",
      ].join("\n"),
      removals: {
        extensions: [],
        extensionIntents: [{ extension: "pg_cron", intentKind: "job", key: "refresh metrics" }],
      },
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const sql = migrationSql(tmp.current);
      expect(sql).toContain("cron.unschedule('refresh metrics')");
      expect(sql).toContain("cron.schedule('refresh download metrics'");
      expect(stripAnsi(s.out.stderrText)).toContain("pg_cron job refresh metrics");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("offers to continue with removals from the staged-export prompt", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "postgis";\n',
      removals: { extensions: ["postgis"], extensionIntents: [] },
      promptSelectResponses: ["continue"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect((s.out.promptSelectCalls[0]?.options ?? []).map((o) => o.value)).toEqual([
        "stage",
        "continue",
        "cancel",
      ]);
      expect(migrationSql(tmp.current)).toContain('DROP EXTENSION "postgis"');
      expect(existsSync(join(tmp.current, "supabase", "schemas-next"))).toBe(false);
      expect(stripAnsi(s.out.stderrText)).toContain("Found destructive changes in schema diff");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("directs pg_net users to enable Database Webhooks before writing", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pg_net";\n',
      removals: { extensions: ["pg_net"], extensionIntents: [] },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeCompatibilityError",
        message: expect.stringContaining("[experimental.webhooks]\nenabled = true"),
      });
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "continues with intentional legacy extension removals only after explicit choice",
    () => {
      seedDeclarative(tmp.current);
      const s = setup(tmp.current, {
        engineImplementation: "next",
        stdinIsTty: true,
        diffSql: 'DROP EXTENSION "pgcrypto";\n',
        removals: { extensions: ["pgcrypto"], extensionIntents: [] },
        promptSelectResponses: ["continue"],
      });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
        expect(readdirSync(join(tmp.current, "supabase", "migrations"))).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("repairs the active tree in place when the user picks the advanced choice", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      replannedDiffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
      promptSelectResponses: ["repair"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(readFileSync(join(tmp.current, "supabase", "schemas", "extension.sql"), "utf8")).toBe(
        'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";\n',
      );
      expect(s.planCalls).toBe(2);
      expect(readdirSync(join(tmp.current, "supabase", "migrations"))).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("stages a next export from the repair prompt without touching the tree", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [false], // decline the staged export's reset offer
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(
        existsSync(join(tmp.current, "supabase", "schemas-next", ".pgdelta-export.json")),
      ).toBe(true);
      expect(existsSync(join(tmp.current, "supabase", "schemas", "extension.sql"))).toBe(false);
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
      expect(stripAnsi(s.out.stderrText)).toContain(
        "rm -rf supabase/schemas && mv supabase/schemas-next supabase/schemas",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("staged export names its live-database source and honors the reset offer", () => {
    seedDeclarative(tmp.current);
    // `legacyResetLocalDatabase`'s container-recreate resolves its own project id
    // from `@supabase/config` — pin it so the recreated container name matches
    // the spawner route's assumption (same as the apply-failure reset test).
    writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [true], // accept the staged export's reset offer
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      // The export source is stated before the snapshot, so stale local drift
      // cannot silently become the staged declarative tree.
      expect(stripAnsi(s.out.stderrText)).toContain(
        "Exporting from the running local database (not the migrations state).",
      );
      // Accepting the offer really reset the local database before the export.
      expect(legacyLocalResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
      expect(
        existsSync(join(tmp.current, "supabase", "schemas-next", ".pgdelta-export.json")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("cancels compatibility resolution without schema or migration writes", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      engineImplementation: "next",
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "uuid-ossp";\n',
      removals: { extensions: ["uuid-ossp"], extensionIntents: [] },
      promptSelectResponses: ["cancel"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
      expect(existsSync(join(tmp.current, "supabase", "schemas", "extension.sql"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("suppresses the compatibility warning when a next export manifest is present", () => {
    seedDeclarative(tmp.current);
    writeFileSync(
      join(tmp.current, "supabase", "schemas", ".pgdelta-export.json"),
      JSON.stringify({ formatVersion: 1, redactSecrets: true, scope: "database" }),
    );
    const s = setup(tmp.current, {
      experimental: true,
      engineImplementation: "next",
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const output = stripAnsi(s.out.rawChunks.map((chunk) => chunk.text).join(""));
      expect(output).not.toContain("may have been generated by the legacy engine");
      expect(output).toContain("Found destructive changes");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--name overrides the migration filename stem", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(
        flags({ noApply: Option.some(true), name: Option.some("add_b") }),
      );
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
      expect(migrations[0]).toMatch(/^\d{14}_add_b\.sql$/);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "apply failure in a TTY offers reset+reapply and runs the reset natively in-process",
    () => {
      seedDeclarative(tmp.current);
      // `legacyResetLocalDatabase`'s container-recreate resolves its own project id
      // from `@supabase/config` (config.toml / real env), independently of the
      // mocked `LegacyCliSettings.projectId` — pin it to "test" so the recreated
      // container name matches the spawner route's assumption.
      writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
      const s = setup(tmp.current, {
        experimental: true,
        diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
        applyFails: true,
        stdinIsTty: true,
        promptConfirmResponses: [true], // accept the reset offer
      });
      return Effect.gen(function* () {
        yield* legacyDbSchemaDeclarativeSync(flags({ apply: Option.some(true) }));
        expect(s.out.rawChunks.some((c) => c.text.includes("Migration failed to apply"))).toBe(
          true,
        );
        // The recovery reset actually ran — recreated the local `db` container
        // (CLI-2062: in-process, not a `supabase-go` child) — proving it's a real
        // effect, not just a tracked call.
        expect(legacyLocalResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
        expect(legacyLocalResetCreateArgs(s.child.spawned)).not.toBeUndefined();
        expect(s.out.rawChunks.some((c) => c.text.includes("Resetting local database"))).toBe(true);
        expect(
          s.out.rawChunks.some((c) =>
            c.text.includes("Database reset and all migrations applied successfully"),
          ),
        ).toBe(true);
        expect(existsSync(join(tmp.current, "supabase", ".temp", "pgdelta", "debug"))).toBe(true);
        // `legacyResetLocalDatabase`'s own body never touches telemetry — the outer
        // `sync` command's single `Effect.ensuring` finalizer must still fire
        // EXACTLY once, not twice, matching Go's single-process `reset.Run` (no
        // second `PersistentPostRun` from a separate child process) (CLI-2062).
        expect(s.telemetry.flushCount).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("surfaces the reset failure (not the apply error) when reset also fails", () => {
    // Go returns resetErr here (`cmd/db_schema_declarative.go:414-423`), so the failure
    // that actually blocked recovery is reported, not the original apply error ("boom").
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      applyFails: true,
      stdinIsTty: true,
      promptConfirmResponses: [true], // accept the reset offer
      resetShouldFail: true, // …and the reset itself fails (local db not running)
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeSync(flags({ apply: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        message: "supabase start is not running.",
      });
      // Printed exactly once — no "database reset failed:" double-wrap (review CLI-1958).
      expect(
        s.out.rawChunks.some((c) =>
          c.text.includes("Database reset also failed: supabase start is not running."),
        ),
      ).toBe(true);
      // A real failure, before any destructive container work.
      expect(legacyLocalResetRemovedContainers(s.child.spawned)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("forwards --network-id to the recovery reset", () => {
    // `legacyResetLocalDatabase` resolves `LegacyNetworkIdFlag` itself from the
    // shared context (CLI-2062) — no argv-forwarding needed — so the recreated
    // container must land on the custom network directly.
    seedDeclarative(tmp.current);
    writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
    const s = setup(tmp.current, {
      experimental: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      applyFails: true,
      stdinIsTty: true,
      promptConfirmResponses: [true], // accept the reset offer
      networkId: "my_net",
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ apply: Option.some(true) }));
      const createArgs = legacyLocalResetCreateArgs(s.child.spawned);
      const networkIndex = createArgs?.indexOf("--network") ?? -1;
      expect(networkIndex).toBeGreaterThanOrEqual(0);
      expect(createArgs?.[networkIndex + 1]).toBe("my_net");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("next engine preserves ordered migration segments as separate files", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
      engineImplementation: "next",
      renderedFiles: [
        {
          sequence: 1,
          name: "transactional",
          suffix: "_1",
          sql: "ALTER TABLE a ADD COLUMN b int;",
          transactionMode: "transactional",
        },
        {
          sequence: 2,
          name: "non_transactional",
          suffix: "_2",
          sql: "ALTER TYPE mood ADD VALUE 'fine';",
          transactionMode: "none",
        },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations")).sort();
      expect(migrations).toHaveLength(2);
      expect(migrations[0]).toMatch(/^\d{14}_declarative_sync_1\.sql$/);
      expect(migrations[1]).toMatch(/^\d{14}_declarative_sync_2\.sql$/);
      expect(s.exportCatalogCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });
});
