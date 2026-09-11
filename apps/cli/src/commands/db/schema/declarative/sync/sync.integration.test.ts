import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect";
import { PlatformError, SystemError } from "effect/PlatformError";

import { stripAnsi } from "../../../../../../tests/helpers/ansi.ts";
import {
  alwaysReadyHttpClientLayer,
  defaultLocalResetRoute,
  localResetCreateArgs,
  localResetRemovedContainers,
  mockContainerCliSpawner,
} from "../../../../../../tests/helpers/local-reset.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockLocalDockerEngineUnavailableLayer,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useShadowCacheDisabled,
  useTempWorkdir,
} from "../../../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../../../shared/cli/cli-args.service.ts";
import { machineErrorContextLayer } from "../../../../../shared/output/machine-error-context.layer.ts";
import { MachineErrorContext } from "../../../../../shared/output/machine-error-context.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../../../command-internal/global-flags.ts";
import { CommandPlatformApi } from "../../../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../../../auth/command-platform-api-factory.service.ts";
import { dockerRunLayer } from "../../../../../command-internal/docker-run.layer.ts";
import { DbConfigResolver } from "../../../../../command-internal/db-config.service.ts";
import {
  type DbBatchStatement,
  DbConnection,
  type PgConnInput,
} from "../../../../../command-internal/db-connection.service.ts";
import { DbConnectError } from "../../../../../command-internal/db-connection.errors.ts";
import {
  PgDeltaEngine,
  PgDeltaEngineError,
  type PgDeltaRemovalSummary,
  type PgDeltaRenderedFile,
} from "../../../shared/pgdelta-engine.service.ts";
import { DeclarativeShadowDbError } from "../../../shared/pgdelta.errors.ts";
import { DeclarativeSeam } from "../../../shared/pgdelta.seam.service.ts";
import { DeclarativeLocalDbNotRunningError } from "../declarative.errors.ts";
import type { DbSchemaDeclarativeSyncFlags } from "./sync.command.ts";
import { dbSchemaDeclarativeSync } from "./sync.handler.ts";

interface SetupOpts {
  experimental?: boolean;
  args?: ReadonlyArray<string>;
  yes?: boolean;
  stdinIsTty?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  diffSql?: string;
  replannedDiffSql?: string;
  applyFails?: boolean;
  applyFailurePrefix?: string;
  connectFails?: boolean;
  batchConnectFails?: boolean;
  /**
   * Makes the recovery reset's `resetLocalDatabase` fail immediately with
   * `ResetLocalDbNotRunningError` (the local `db` container reports as not
   * running) instead of completing a real recreate.
   */
  resetShouldFail?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  promptSelectResponses?: ReadonlyArray<string>;
  promptTextResponses?: ReadonlyArray<string>;
  networkId?: string;
  projectId?: Option.Option<string>;
  staleLocalImage?: boolean;
  localDatabaseNotRunning?: boolean;
  renderedFiles?: ReadonlyArray<PgDeltaRenderedFile>;
  removals?: PgDeltaRemovalSummary;
  planErrors?: ReadonlyArray<PgDeltaEngineError>;
  declarativeReadFails?: boolean;
}

const fileSystemFault = (method: "readDirectory", target: string, description: string) =>
  new PlatformError(
    new SystemError({
      _tag: "Unknown",
      module: "FileSystem",
      method,
      pathOrDescriptor: target,
      description,
    }),
  );

const fileSystemFaultLayer = (
  workdir: string,
  opts: Pick<SetupOpts, "declarativeReadFails">,
): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) =>
      FileSystem.FileSystem.of({
        ...real,
        readDirectory: (target) =>
          opts.declarativeReadFails === true && target === join(workdir, "supabase", "schemas")
            ? Effect.fail(
                fileSystemFault("readDirectory", target, "simulated declarative read failure"),
              )
            : real.readDirectory(target),
      }),
    ),
  ).pipe(Layer.provide(BunServices.layer));

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.outputFormat,
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const localPostgresImageChecks: Array<true> = [];
  const localDatabaseStarts: Array<true> = [];
  const localDatabaseRunningChecks: Array<boolean> = [];
  const platformApi = mockCommandPlatformApiService({});
  // Backs `resetLocalDatabase`'s real, native container-recreate, reached when the
  // recovery-reset offer is accepted.
  const child = mockContainerCliSpawner(
    defaultLocalResetRoute("test", { running: opts.resetShouldFail !== true }),
  );
  const seam = Layer.succeed(DeclarativeSeam, {
    ensureLocalDatabaseStarted: () =>
      Effect.sync(() => {
        localDatabaseStarts.push(true);
      }),
    isLocalDatabaseRunning: () =>
      Effect.sync(() => {
        const running = opts.localDatabaseNotRunning !== true;
        localDatabaseRunningChecks.push(running);
        return running;
      }),
    ensureLocalPostgresImageCurrent: () =>
      Effect.sync(() => {
        localPostgresImageChecks.push(true);
      }).pipe(
        Effect.flatMap(() =>
          opts.staleLocalImage === true
            ? Effect.fail(
                new DeclarativeShadowDbError({
                  message: "local Postgres container image is stale",
                }),
              )
            : Effect.void,
        ),
      ),
  });
  const dbExec: string[] = [];
  const dbBatches: Array<ReadonlyArray<string>> = [];
  // The default `[db] shadow_port` (none of these tests override it). The migrations-catalog
  // shadow also connects through this fake `DbConnection`, so its SQL must be excluded from
  // `dbExec`, which every "not yet applied" assertion expects to stay empty until real apply.
  const SHADOW_PORT = 54320;
  const applyFailurePrefix =
    opts.applyFailurePrefix ?? (opts.applyFails === true ? "ALTER" : undefined);
  const dbConn = Layer.succeed(DbConnection, {
    connect: (cfg: PgConnInput) =>
      opts.connectFails === true && cfg.port !== SHADOW_PORT
        ? Effect.fail(new DbConnectError({ message: "connection refused" }))
        : Effect.succeed({
            exec: (sql: string) =>
              applyFailurePrefix !== undefined && sql.startsWith(applyFailurePrefix)
                ? Effect.fail({ _tag: "DbExecError", message: "boom" } as never)
                : Effect.sync(() => {
                    if (cfg.port !== SHADOW_PORT) dbExec.push(sql);
                  }),
            execBatch: (statements: ReadonlyArray<DbBatchStatement>) => {
              const sql = statements.map((statement) => statement.sql);
              if (opts.batchConnectFails === true && cfg.port !== SHADOW_PORT) {
                return Effect.fail(new DbConnectError({ message: "batch connection lost" }));
              }
              const failureIndex =
                applyFailurePrefix === undefined
                  ? -1
                  : sql.findIndex((statement) => statement.startsWith(applyFailurePrefix));
              return failureIndex >= 0
                ? Effect.fail({
                    _tag: "DbExecError",
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
  const resolver = Layer.succeed(DbConfigResolver, {
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
  const runtimeInfo = mockRuntimeInfo({ platform: "linux" });
  const processControl = mockProcessControl();
  const experimentalFlag = Layer.succeed(ExperimentalFlag, opts.experimental ?? true);
  const cliArgs = Layer.succeed(CliArgs, {
    args: opts.args ?? ["db", "schema", "declarative", "sync"],
  });
  const networkIdFlag = Layer.succeed(
    NetworkIdFlag,
    opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
  );
  const debugFlag = Layer.succeed(DebugFlag, false);
  const dockerRun = dockerRunLayer.pipe(
    Layer.provide(child.layer),
    Layer.provide(processControl.layer),
  );
  const planErrors = [...(opts.planErrors ?? [])];
  let planCalls = 0;
  const planSources: Array<string | undefined> = [];
  const declarativeExportCalls: Array<ReadonlyArray<string>> = [];
  const engine = Layer.succeed(
    PgDeltaEngine,
    PgDeltaEngine.of({
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
      planDeclarativeSchema: (input) => {
        planCalls += 1;
        planSources.push(input.source?.ref);
        const planError = planErrors.shift();
        if (planError !== undefined) return Effect.fail(planError);
        const extensionPath = join(workdir, "supabase", "schemas", "extension.sql");
        const extensionSql = existsSync(extensionPath) ? readFileSync(extensionPath, "utf8") : "";
        const remainingExtensions = (opts.removals?.extensions ?? []).filter(
          (extension) => !extensionSql.includes(`"${extension}"`),
        );
        const extensionsRepaired =
          remainingExtensions.length < (opts.removals?.extensions.length ?? 0);
        const sql =
          extensionsRepaired && opts.replannedDiffSql !== undefined
            ? opts.replannedDiffSql
            : (opts.diffSql ?? opts.renderedFiles?.map((file) => file.sql).join("\n") ?? "");
        const files =
          opts.renderedFiles ??
          (sql.trim().length < 2
            ? []
            : [
                {
                  sequence: 0,
                  name: "declarative_sync",
                  sql,
                  transactionMode: "transactional" as const,
                },
              ]);
        return Effect.succeed({
          changes: files.length > 0,
          sql,
          files,
          sourceRef: input.source === undefined ? "migrations" : "pg-delta-next:database",
          targetRef: "pg-delta-next:declarative",
          removals:
            opts.removals === undefined
              ? undefined
              : { ...opts.removals, extensions: remainingExtensions },
        });
      },
    }),
  );
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    engine,
    mockLocalDockerEngineUnavailableLayer,
    dbConn,
    resolver,
    mockCommandSettings({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(opts.stdinIsTty ?? false),
    experimentalFlag,
    cliArgs,
    Layer.succeed(YesFlag, opts.yes ?? false),
    networkIdFlag,
    Layer.succeed(DnsResolverFlag, "native"),
    debugFlag,
    // The local-reset bucket-seed core statically requires the (lazy) Management-API factory,
    // though it's never invoked on the local recovery reset.
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    BunServices.layer,
    // `child.layer` must be listed after `BunServices.layer` — `Layer.mergeAll` resolves a
    // duplicate service tag to whichever layer is listed last, so this mock overrides Bun's
    // real `ChildProcessSpawner` instead of the reverse.
    child.layer,
    runtimeInfo,
    processControl.layer,
    alwaysReadyHttpClientLayer,
    machineErrorContextLayer,
    ...(opts.declarativeReadFails === true ? [fileSystemFaultLayer(workdir, opts)] : []),
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
    localDatabaseStarts,
    localDatabaseRunningChecks,
    planSources,
    declarativeExportCalls,
    get planCalls() {
      return planCalls;
    },
  };
}

const flags = (over: Partial<DbSchemaDeclarativeSyncFlags> = {}): DbSchemaDeclarativeSyncFlags => ({
  noCache: over.noCache ?? false,
  strictCoverage: over.strictCoverage ?? false,
  schema: over.schema ?? [],
  file: over.file ?? Option.none(),
  name: over.name ?? Option.none(),
  apply: over.apply ?? Option.none(),
  noApply: over.noApply ?? Option.none(),
  transient: over.transient ?? Option.none(),
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const seedDeclarative = (workdir: string) => {
  const dir = join(workdir, "supabase", "schemas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "public.sql"), "create table a();");
};

const migrationEntries = (workdir: string): ReadonlyArray<string> => {
  const dir = join(workdir, "supabase", "migrations");
  return existsSync(dir) ? readdirSync(dir) : [];
};

const seedUuidDeclarative = (workdir: string, directory = "schemas") => {
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

const uuidLoadError = () =>
  new PgDeltaEngineError({
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

describe("db schema declarative sync integration", () => {
  const tmp = useTempWorkdir();
  useShadowCacheDisabled();

  it.effect("gate: fails when pg-delta is not enabled", () => {
    seedDeclarative(tmp.current);
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeSync(flags()));
      expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--apply and --no-apply together with --experimental fail with the mutex error", () => {
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeSync(flags({ apply: Option.some(true), noApply: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeMutuallyExclusiveFlagsError",
        message:
          "if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "--apply and --no-apply together without --experimental fail with the gate error, not the mutex error",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeSync(flags({ apply: Option.some(true), noApply: Option.some(true) })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--apply and --no-apply together with SUPABASE_EXPERIMENTAL env (no --experimental flag) fail with the mutex error",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeSync(flags({ apply: Option.some(true), noApply: Option.some(true) })),
        );
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeMutuallyExclusiveFlagsError",
          message:
            "if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an explicit --experimental=false closes the gate even when SUPABASE_EXPERIMENTAL is set",
    () => {
      const { layer } = setup(tmp.current, {
        experimental: false,
        args: ["db", "schema", "declarative", "sync", "--experimental=false"],
      });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const saved = process.env[ENV];
        process.env[ENV] = "1";
        const exit = yield* Effect.exit(dbSchemaDeclarativeSync(flags()));
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("DeclarativeNotEnabledError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--apply and --no-apply together with SUPABASE_EXPERIMENTAL set only in the project .env fail with the mutex error",
    () => {
      const saved = process.env["SUPABASE_EXPERIMENTAL"];
      delete process.env["SUPABASE_EXPERIMENTAL"];
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_EXPERIMENTAL=true\n");
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          dbSchemaDeclarativeSync(flags({ apply: Option.some(true), noApply: Option.some(true) })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeMutuallyExclusiveFlagsError",
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
    // The gate runs first, so `--experimental` is required here for the mutex error to surface.
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeSync(flags({ apply: Option.some(false), noApply: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeMutuallyExclusiveFlagsError",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when there are no declarative files", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeSync(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "no declarative schema found",
      );
      expect(stripAnsi(s.out.stderrText)).not.toContain("WARNING: found declarative schema files");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("warns when the tree still lives under the former supabase/database default", () => {
    const formerDir = join(tmp.current, "supabase", "database");
    mkdirSync(formerDir, { recursive: true });
    writeFileSync(join(formerDir, "public.sql"), "create table a();");
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbSchemaDeclarativeSync(flags()));
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
      yield* dbSchemaDeclarativeSync(flags());
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
      const exit = yield* Effect.exit(dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeShadowDbError",
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
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
      expect(migrations).toHaveLength(1);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.dbExec).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--yes bypasses the bootstrap prompt when no declarative files exist", () => {
    // No `promptConfirmResponses` are queued, so reaching the prompt would also error.
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: true, diffSql: "" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })),
      );
      expect(JSON.stringify(exit)).not.toContain("no declarative schema found");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap prints the declarative-schema-written line after generating", () => {
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      diffSql: "",
      promptConfirmResponses: [true], // generate a new one? yes (no migrations → no reset prompt)
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const line = `Declarative schema written to ${join("supabase", "schemas")}\n`;
      const written = s.out.rawChunks
        .map((c) => ({ text: stripAnsi(c.text), stream: c.stream }))
        .filter((c) => c.text === line);
      expect(written).toHaveLength(1);
      expect(written[0]?.stream).toBe("stderr");
      expect(
        existsSync(join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql")),
      ).toBe(true);
      expect(s.declarativeExportCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--yes bootstrap prints the declarative-schema-written line too", () => {
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: false,
      yes: true,
      diffSql: "",
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${join("supabase", "schemas")}\n`,
        stream: "stderr",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap with migrations offers the smart target choice (not local-only)", () => {
    // `projectId: "test"` is an invalid ref, so the linked choice is hidden.
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
      yield* Effect.exit(dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })));
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "custom"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap linked target does not run the local Postgres image check", () => {
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
        dbSchemaDeclarativeSync(flags({ noCache: true, noApply: Option.some(true) })),
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
      promptConfirmResponses: [true], // generate a new one? yes
      promptSelectResponses: ["linked"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbSchemaDeclarativeSync(
          flags({
            noCache: true,
            apply: Option.some(true),
            name: Option.some("bootstrap_apply"),
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeShadowDbError",
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
        dbSchemaDeclarativeSync(flags({ noCache: true, noApply: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap: an unreadable migrations path is treated as no migrations", () => {
    // Seeding `supabase/migrations` as a file makes the probe's list fail with ENOTDIR.
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
        dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })),
      );
      expect(JSON.stringify(exit)).not.toContain("failed to read directory");
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        existsSync(join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap: an unreadable ref file just omits the linked choice", () => {
    // Seeding `.temp/project-ref` as a directory makes the read fail.
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
        dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })),
      );
      expect((s.out.promptSelectCalls[0]?.options ?? []).map((o) => o.value)).toEqual([
        "local",
        "custom",
      ]);
      expect(JSON.stringify(exit)).not.toContain("failed to load project ref");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bootstrap caches the linked project after resolving the ref", () => {
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
      yield* Effect.exit(dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })));
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("does not cache when the workdir is not linked", () => {
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
      yield* Effect.exit(dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })));
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("empty diff prints 'No schema changes found' and writes nothing", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, { experimental: true, diffSql: "" });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
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
        yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
        const migrations = readdirSync(join(tmp.current, "supabase", "migrations"));
        expect(migrations).toHaveLength(1);
        expect(migrations[0]).toMatch(/^\d{14}_declarative_sync\.sql$/);
        expect(
          s.out.rawChunks.some((c) => c.text.includes("Found destructive changes in schema diff")),
        ).toBe(true);
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
      yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) }));
      expect(s.dbBatches).toContainEqual([
        "ALTER TABLE a ADD COLUMN b int",
        expect.stringContaining("supabase_migrations.schema_migrations"),
      ]);
      expect(localResetRemovedContainers(s.child.spawned)).toEqual([]);
      expect(s.out.rawChunks.some((c) => c.text.includes("Migration applied successfully"))).toBe(
        true,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("refuses a known implicit-extension load failure under --yes", () => {
    seedUuidDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      planErrors: [uuidLoadError()],
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags()).pipe(Effect.exit);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeCompatibilityError",
        message: expect.stringContaining("schemas/app/tables/members.sql:3"),
      });
      const error = failError(exit);
      expect(error).toMatchObject({
        message: expect.stringContaining("uuid-ossp"),
        suggestion: expect.stringContaining(
          "supabase db schema declarative generate --local --overwrite",
        ),
      });
      expect(JSON.stringify(error)).not.toContain("extension.sql");
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("adds a missing load-time extension declaration and re-plans", () => {
    seedUuidDeclarative(tmp.current);
    const s = setup(tmp.current, {
      stdinIsTty: true,
      planErrors: [uuidLoadError()],
      promptSelectResponses: ["repair"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(s.planCalls).toBe(2);
      expect(readFileSync(join(tmp.current, "supabase", "schemas", "extension.sql"), "utf8")).toBe(
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";\n',
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("stages a complete next export without changing the active tree", () => {
    seedUuidDeclarative(tmp.current);
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
      stdinIsTty: true,
      planErrors: [uuidLoadError()],
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [false], // decline the staged export's reset offer
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
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
    seedUuidDeclarative(tmp.current, "custom-declarative");
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
      stdinIsTty: true,
      planErrors: [uuidLoadError()],
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [false], // decline the staged export's reset offer
    });

    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ schema: ["app"], noApply: Option.some(true) }));

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
      yes: true,
      diffSql:
        "select cron.unschedule('refresh download metrics');\nDROP EXTENSION \"pgcrypto\";\n",
      removals: {
        extensions: ["pg_cron", "pgcrypto", "uuid-ossp"],
        extensionIntents: [
          { extension: "pg_cron", intentKind: "job", key: "refresh download metrics" },
        ],
      },
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags()).pipe(Effect.exit);
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeCompatibilityError",
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

  it.effect("writes cron job and pgmq queue removals without a legacy-export refusal", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      diffSql: "select cron.unschedule('refresh metrics');\nselect pgmq.drop_queue('emails');\n",
      removals: {
        extensions: [],
        extensionIntents: [
          { extension: "pg_cron", intentKind: "job", key: "refresh metrics" },
          { extension: "pgmq", intentKind: "queue", key: "emails" },
        ],
      },
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const migrationsDir = join(tmp.current, "supabase", "migrations");
      const [migration] = readdirSync(migrationsDir);
      const sql = readFileSync(join(migrationsDir, migration ?? ""), "utf8");
      expect(sql).toContain("cron.unschedule('refresh metrics')");
      expect(sql).toContain("pgmq.drop_queue('emails')");
      expect(stripAnsi(s.out.stderrText)).not.toContain("legacy pg-delta export");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("directs pg_net users to enable Database Webhooks before writing", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pg_net";\n',
      removals: { extensions: ["pg_net"], extensionIntents: [] },
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeCompatibilityError",
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
        stdinIsTty: true,
        diffSql: 'DROP EXTENSION "pgcrypto";\n',
        removals: { extensions: ["pgcrypto"], extensionIntents: [] },
        promptSelectResponses: ["continue"],
      });
      return Effect.gen(function* () {
        yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
        expect(readdirSync(join(tmp.current, "supabase", "migrations"))).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("repairs the active tree in place when the user picks the advanced choice", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      replannedDiffSql: "ALTER TABLE a ADD COLUMN b int;\n",
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
      promptSelectResponses: ["repair"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
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
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [false], // decline the staged export's reset offer
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
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
    // `resetLocalDatabase` resolves its own project id from `@supabase/config`; pin it so the
    // recreated container name matches the spawner route's assumption.
    writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
    const s = setup(tmp.current, {
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
      promptSelectResponses: ["stage"],
      promptConfirmResponses: [true], // accept the staged export's reset offer
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      expect(stripAnsi(s.out.stderrText)).toContain(
        "Exporting from the running local database (not the migrations state).",
      );
      expect(localResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
      expect(
        existsSync(join(tmp.current, "supabase", "schemas-next", ".pgdelta-export.json")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("cancels compatibility resolution without schema or migration writes", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      stdinIsTty: true,
      diffSql: 'DROP EXTENSION "uuid-ossp";\n',
      removals: { extensions: ["uuid-ossp"], extensionIntents: [] },
      promptSelectResponses: ["cancel"],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
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
      diffSql: 'DROP EXTENSION "pgcrypto";\n',
      removals: { extensions: ["pgcrypto"], extensionIntents: [] },
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const output = stripAnsi(s.out.rawChunks.map((chunk) => chunk.text).join(""));
      expect(output).not.toContain("looks like a legacy pg-delta export");
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
      yield* dbSchemaDeclarativeSync(
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
      // `resetLocalDatabase` resolves its own project id from `@supabase/config`, independently
      // of the mocked `CommandSettings.projectId`; pin it so the recreated container name
      // matches the spawner route's assumption.
      writeFileSync(join(tmp.current, "supabase", "config.toml"), 'project_id = "test"\n');
      const s = setup(tmp.current, {
        experimental: true,
        diffSql: "ALTER TABLE a ADD COLUMN b int;\n",
        applyFails: true,
        stdinIsTty: true,
        promptConfirmResponses: [true], // accept the reset offer
      });
      return Effect.gen(function* () {
        yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) }));
        expect(s.out.rawChunks.some((c) => c.text.includes("Migration failed to apply"))).toBe(
          true,
        );
        expect(localResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
        expect(localResetCreateArgs(s.child.spawned)).not.toBeUndefined();
        expect(s.out.rawChunks.some((c) => c.text.includes("Resetting local database"))).toBe(true);
        expect(
          s.out.rawChunks.some((c) =>
            c.text.includes("Database reset and all migrations applied successfully"),
          ),
        ).toBe(true);
        expect(existsSync(join(tmp.current, "supabase", ".temp", "pgdelta", "debug"))).toBe(true);
        expect(migrationEntries(tmp.current)).toHaveLength(1);
        // `resetLocalDatabase`'s own body never touches telemetry, so the outer command's single
        // `Effect.ensuring` finalizer must still fire exactly once, not twice.
        expect(s.telemetry.flushCount).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("surfaces the reset failure (not the apply error) when reset also fails", () => {
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
      const exit = yield* Effect.exit(dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        message: "supabase start is not running.",
      });
      expect(
        s.out.rawChunks.some((c) =>
          c.text.includes("Database reset also failed: supabase start is not running."),
        ),
      ).toBe(true);
      expect(localResetRemovedContainers(s.child.spawned)).toEqual([]);
      expect(migrationEntries(tmp.current)).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("forwards --network-id to the recovery reset", () => {
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
      yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) }));
      const createArgs = localResetCreateArgs(s.child.spawned);
      const networkIndex = createArgs?.indexOf("--network") ?? -1;
      expect(networkIndex).toBeGreaterThanOrEqual(0);
      expect(createArgs?.[networkIndex + 1]).toBe("my_net");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("preserves ordered migration segments as separate files", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      experimental: true,
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
      yield* dbSchemaDeclarativeSync(flags({ noApply: Option.some(true) }));
      const migrations = readdirSync(join(tmp.current, "supabase", "migrations")).sort();
      expect(migrations).toHaveLength(2);
      expect(migrations[0]).toMatch(/^\d{14}_declarative_sync_1\.sql$/);
      expect(migrations[1]).toMatch(/^\d{14}_declarative_sync_2\.sql$/);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects every transient-incompatible flag before local side effects", () => {
    seedDeclarative(tmp.current);
    const cases: ReadonlyArray<Partial<DbSchemaDeclarativeSyncFlags>> = [
      { transient: Option.some(true), noApply: Option.some(true) },
      { transient: Option.some(true), file: Option.some("change") },
      { transient: Option.some(true), name: Option.some("change") },
      { transient: Option.some(true), apply: Option.some(false) },
    ];
    return Effect.gen(function* () {
      for (const flagCase of cases) {
        const s = setup(tmp.current, { yes: true, diffSql: "ALTER TABLE a ADD COLUMN b int;" });
        const exit = yield* dbSchemaDeclarativeSync(flags(flagCase)).pipe(
          Effect.provide(s.layer),
          Effect.exit,
        );
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeMutuallyExclusiveFlagsError",
        });
        expect(s.localPostgresImageChecks).toEqual([]);
        expect(s.localDatabaseStarts).toEqual([]);
        expect(s.localDatabaseRunningChecks).toEqual([]);
        expect(s.planCalls).toBe(0);
      }
    });
  });

  it.effect("transient missing-tree failure never bootstraps or starts local Postgres", () => {
    const s = setup(tmp.current, { yes: true, diffSql: "ALTER TABLE a ADD COLUMN b int;" });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeNonInteractiveError",
        message: expect.stringContaining("generate first"),
      });
      expect(s.planCalls).toBe(0);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.localDatabaseStarts).toEqual([]);
      expect(s.localDatabaseRunningChecks).toEqual([]);
      expect(s.declarativeExportCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("transient treats trees without recursive SQL files as missing", () => {
    const declarativeDir = join(tmp.current, "supabase", "schemas");
    const s = setup(tmp.current, { yes: true, diffSql: "DROP TABLE public.accounts;" });
    return Effect.gen(function* () {
      for (const fixture of ["manifest", "empty-directory"] as const) {
        rmSync(declarativeDir, { recursive: true, force: true });
        mkdirSync(declarativeDir, { recursive: true });
        if (fixture === "manifest") {
          writeFileSync(
            join(declarativeDir, ".pgdelta-export.json"),
            JSON.stringify({ redactSecrets: true, scope: "database" }),
          );
        } else {
          mkdirSync(join(declarativeDir, "public", "tables"), { recursive: true });
        }
        const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
          Effect.exit,
        );
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeNonInteractiveError",
          message: expect.stringContaining("generate first"),
        });
      }
      expect(s.planCalls).toBe(0);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.localDatabaseStarts).toEqual([]);
      expect(s.localDatabaseRunningChecks).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("maps an unreadable declarative tree to a tagged diff error", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, { yes: true, declarativeReadFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeDiffError",
        message: expect.stringContaining("failed to read declarative schema directory"),
      });
      expect(s.planCalls).toBe(0);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.localDatabaseStarts).toEqual([]);
      expect(s.localDatabaseRunningChecks).toEqual([]);
      expect(s.declarativeExportCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("transient refuses when the local database is not running", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      localDatabaseNotRunning: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      const error = failError(exit);
      expect(error).toBeInstanceOf(DeclarativeLocalDbNotRunningError);
      expect(error).toMatchObject({
        suggestion: "Start the local database, then rerun sync --transient.",
      });
      expect(s.localDatabaseRunningChecks).toEqual([false]);
      expect(s.localPostgresImageChecks).toEqual([]);
      expect(s.localDatabaseStarts).toEqual([]);
      expect(s.planCalls).toBe(0);
      expect(s.dbExec).toEqual([]);
      expect(migrationEntries(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "transient applies ordered units from the running database with SQL visible twice and no durable artifacts",
    () => {
      seedDeclarative(tmp.current);
      const renderedFiles: ReadonlyArray<PgDeltaRenderedFile> = [
        {
          sequence: 1,
          name: "tables",
          sql: "ALTER TABLE a ADD COLUMN b int;",
          transactionMode: "transactional",
        },
        {
          sequence: 2,
          name: "enum_values",
          sql: "ALTER TYPE mood ADD VALUE 'fine';",
          transactionMode: "none",
        },
        {
          sequence: 3,
          name: "removals",
          sql: "DROP TABLE public.old_table;",
          transactionMode: "transactional",
        },
      ];
      const sql = renderedFiles.map((file) => file.sql).join("\n");
      const s = setup(tmp.current, { yes: true, renderedFiles });
      return Effect.gen(function* () {
        yield* dbSchemaDeclarativeSync(
          flags({ transient: Option.some(true), apply: Option.some(true) }),
        );
        expect(s.localDatabaseRunningChecks).toEqual([true]);
        expect(s.localPostgresImageChecks).toHaveLength(1);
        expect(s.localDatabaseStarts).toEqual([]);
        expect(s.planSources).toHaveLength(1);
        expect(s.planSources[0]).toContain("127.0.0.1");
        expect(s.dbExec).toEqual(renderedFiles.map((file) => file.sql.replace(/;$/u, "")));
        expect(s.dbExec.join("\n")).not.toContain("schema_migrations");
        expect(s.dbExec).not.toContain("RESET ALL");
        expect(migrationEntries(tmp.current)).toEqual([]);
        expect(s.out.stdoutText).toBe(`${sql}\n${sql}\n`);
        expect(stripAnsi(s.out.stderrText)).toContain("Found destructive changes");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("transient TTY cancellation leaves the planned SQL visible and applies nothing", () => {
    seedDeclarative(tmp.current);
    const sql = "ALTER TABLE a ADD COLUMN b int;";
    const s = setup(tmp.current, {
      stdinIsTty: true,
      diffSql: sql,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) }));
      expect(s.out.promptConfirmCalls).toContainEqual(
        expect.objectContaining({
          message: "Apply these schema changes directly to the local database?",
        }),
      );
      expect(s.out.stdoutText).toBe(`${sql}\n`);
      expect(s.dbExec).toEqual([]);
      expect(s.localDatabaseStarts).toEqual([]);
      expect(s.localDatabaseRunningChecks).toEqual([true]);
      expect(migrationEntries(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "transient noninteractive refusal ignores --apply=true and attaches the full plan to machine error context",
    () => {
      seedDeclarative(tmp.current);
      const sql = "ALTER TABLE a ADD COLUMN b int;";
      const s = setup(tmp.current, { outputFormat: "json", diffSql: sql });
      return Effect.gen(function* () {
        const exit = yield* dbSchemaDeclarativeSync(
          flags({ transient: Option.some(true), apply: Option.some(true) }),
        ).pipe(Effect.exit);
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeTransientConfirmationRequiredError",
        });
        const context = yield* MachineErrorContext;
        expect(yield* context.get).toEqual({
          changed: true,
          applied: false,
          migration_written: false,
          history_recorded: false,
          sql,
          units: [
            {
              name: "declarative_sync",
              transaction_mode: "transactional",
              sql,
            },
          ],
        });
        expect(s.dbExec).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("transient JSON and stream-json successes expose the same ordered plan", () => {
    seedDeclarative(tmp.current);
    const sql = "ALTER TABLE a ADD COLUMN b int;";
    return Effect.gen(function* () {
      for (const outputFormat of ["json", "stream-json"] as const) {
        const s = setup(tmp.current, { outputFormat, yes: true, diffSql: sql });
        yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
          Effect.provide(s.layer),
        );
        expect(s.out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: {
              changed: true,
              applied: true,
              migration_written: false,
              history_recorded: false,
              sql,
              units: [
                {
                  name: "declarative_sync",
                  transaction_mode: "transactional",
                  sql,
                },
              ],
            },
          }),
        );
        expect(s.out.stdoutText).toBe("");
        expect(migrationEntries(tmp.current)).toEqual([]);
      }
    });
  });

  it.effect("transient image preflight failure stops before planning or database startup", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      staleLocalImage: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(s.localDatabaseRunningChecks).toEqual([true]);
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.localDatabaseStarts).toEqual([]);
      expect(s.planCalls).toBe(0);
      expect(migrationEntries(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("transient execution failure saves SQL and never offers reset recovery", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      applyFails: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeApplyError",
        suggestion: expect.stringContaining("re-plan"),
      });
      expect(
        s.out.promptConfirmCalls.some((call) => call.message.includes("reset the local database")),
      ).toBe(false);
      expect(migrationEntries(tmp.current)).toEqual([]);
      expect(existsSync(join(tmp.current, "supabase", ".temp", "pgdelta", "debug"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("transient connection failure preserves connection classification", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      connectFails: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      const error = failError(exit);
      expect(error).toMatchObject({
        _tag: "DeclarativeApplyError",
        connect: true,
      });
      expect(error).not.toHaveProperty("suggestion");
      expect(stripAnsi(s.out.stderrText)).not.toContain("nontransactional or earlier units");
      expect(s.dbExec).toEqual([]);
      expect(migrationEntries(tmp.current)).toEqual([]);
      expect(existsSync(join(tmp.current, "supabase", ".temp", "pgdelta", "debug"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("transient batch connection failure preserves execution guidance", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      batchConnectFails: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ transient: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(failError(exit)).toMatchObject({
        _tag: "DeclarativeApplyError",
        connect: true,
        suggestion: expect.stringContaining("re-plan"),
      });
      expect(s.dbExec).toEqual([]);
      expect(migrationEntries(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects unsafe --file and --name stems with the tagged input error", () => {
    seedDeclarative(tmp.current);
    return Effect.gen(function* () {
      for (const unsafe of [
        { file: Option.some("nested/change") },
        { name: Option.some("change.SQL") },
        { file: Option.some(" padded ") },
        { name: Option.some(" padded ") },
      ]) {
        const s = setup(tmp.current, { diffSql: "ALTER TABLE a ADD COLUMN b int;" });
        const exit = yield* dbSchemaDeclarativeSync(flags(unsafe)).pipe(
          Effect.provide(s.layer),
          Effect.exit,
        );
        expect(failError(exit)).toMatchObject({
          _tag: "DeclarativeInvalidMigrationStemError",
        });
        expect(s.planCalls).toBe(0);
      }
    });
  });

  it.effect("failed image preflight saves diagnostics and keeps the generated file", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      yes: true,
      staleLocalImage: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stripAnsi(s.out.stderrText)).toContain("Migration apply preflight failed");
      expect(migrationEntries(tmp.current)).toHaveLength(1);
      expect(existsSync(join(tmp.current, "supabase", ".temp", "pgdelta", "debug"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declining reset keeps the generated migration", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      stdinIsTty: true,
      applyFails: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(migrationEntries(tmp.current)).toHaveLength(1);
      expect(s.out.promptConfirmCalls.map((call) => call.message)).toEqual([
        "Would you like to reset the local database and reapply all migrations? (local data will be lost)",
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("noninteractive failed apply keeps every generated segment", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      applyFails: true,
      renderedFiles: [
        {
          sequence: 1,
          name: "tables",
          suffix: "_1",
          sql: "ALTER TABLE a ADD COLUMN b int;",
          transactionMode: "transactional",
        },
        {
          sequence: 2,
          name: "enum_values",
          suffix: "_2",
          sql: "ALTER TYPE mood ADD VALUE 'fine';",
          transactionMode: "none",
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(migrationEntries(tmp.current)).toHaveLength(2);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "failed no-transaction apply keeps the generated file after earlier statements ran",
    () => {
      seedDeclarative(tmp.current);
      const s = setup(tmp.current, {
        stdinIsTty: true,
        applyFailurePrefix: "ALTER TYPE",
        promptConfirmResponses: [false],
        renderedFiles: [
          {
            sequence: 1,
            name: "enum_values",
            sql: "-- pg-delta: transaction=false\nSELECT 1;\nALTER TYPE mood ADD VALUE 'fine';",
            transactionMode: "none",
          },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(migrationEntries(tmp.current)).toHaveLength(1);
        expect(s.dbExec.some((sql) => sql.includes("SELECT 1"))).toBe(true);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("failed apply preserves all segments after an earlier segment was recorded", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, {
      applyFailurePrefix: "ALTER TYPE",
      renderedFiles: [
        {
          sequence: 1,
          name: "tables",
          suffix: "_1",
          sql: "CREATE TABLE public.applied_segment (id bigint);",
          transactionMode: "transactional",
        },
        {
          sequence: 2,
          name: "enum_values",
          suffix: "_2",
          sql: "ALTER TYPE mood ADD VALUE 'fine';",
          transactionMode: "none",
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(migrationEntries(tmp.current)).toHaveLength(2);
      expect(s.dbBatches).toContainEqual(
        expect.arrayContaining([
          "CREATE TABLE public.applied_segment (id bigint)",
          expect.stringContaining("supabase_migrations.schema_migrations"),
        ]),
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("debug-bundle failure retains generated files", () => {
    seedDeclarative(tmp.current);
    writeFileSync(join(tmp.current, "supabase", ".temp"), "blocks debug directory");
    const s = setup(tmp.current, {
      applyFails: true,
      diffSql: "ALTER TABLE a ADD COLUMN b int;",
    });
    return Effect.gen(function* () {
      const exit = yield* dbSchemaDeclarativeSync(flags({ apply: Option.some(true) })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(migrationEntries(tmp.current)).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });
});
