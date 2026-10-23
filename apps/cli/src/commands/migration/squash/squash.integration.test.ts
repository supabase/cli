import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { describeDbTargetSelection } from "../../../../tests/helpers/db-target-selection.ts";
import { unusedStackServices } from "../../../../tests/helpers/unused-stack.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  FAKE_SHADOW_CONTAINER_ID,
  VALID_REF,
  VALID_TOKEN,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  shadowCacheDisabledLayer,
  useTempWorkdir,
  withEmptyConfigEnv,
  withEnvVar,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../tests/helpers/mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  realDbConfigResolver,
  realLinkedProjectCache,
  recordingProjectHttpClient,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { slimImagesEnabled } from "../../../shared/services/slim-images.ts";
import { getRegistryImageUrl } from "../../../command-internal/docker-registry.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { INTERNAL_SCHEMAS } from "../../../command-internal/pg-dump.env.ts";
import { dumpSchemaScript } from "../../../command-internal/pg-dump.scripts.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import { DebugLogger } from "../../../shared/output/debug-logger.service.ts";
import { BundledPostgresClient } from "../../../command-internal/bundled-postgres-client.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import { DbSetupError } from "../../../command-internal/db-bootstrap/db-setup.ts";
import { HealthCheckTimeoutError } from "../../../command-internal/db-bootstrap/health-check.ts";
import { ShadowDbError } from "../../../command-internal/db-bootstrap/shadow-database.ts";
import { MigrationApplyError } from "../../../command-internal/migration-apply.ts";
import { HostedMutationDeclinedError } from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { TargetPasswordConflictError } from "../../../command-internal/target/target.errors.ts";
import { MigrationFileNotFoundError, MigrationInvalidVersionError } from "../migration.errors.ts";
import type { MigrationSquashFlags } from "./squash.command.ts";
import {
  MigrationSquashBaselineError,
  MigrationSquashDumpError,
  MigrationSquashMissingVersionError,
  MigrationSquashWriteError,
} from "./squash.errors.ts";
import { migrationSquash } from "./squash.handler.ts";
import { branchRow } from "../../../../tests/helpers/remote-selection.ts";

// Distinguishes squash's three pg_dump containers from the shadow's setup jobs by env:
// only a pg_dump invocation carries PGDATABASE. Among dump calls, the first two sharing
// EXTRA_FLAGS=--schema=auth|storage are the before/after dumps in call order; a call
// with no EXTRA_FLAGS is the full dump.
function mockSquashDockerRun(
  opts: {
    readonly beforeSql?: string;
    readonly afterSql?: string;
    readonly fullSql?: string;
    readonly failDump?: "before" | "after" | "full";
    readonly failSetupJob?: boolean;
  } = {},
) {
  const dumpCalls: Array<DockerRunOpts> = [];
  const setupJobCalls: Array<DockerRunOpts> = [];
  let authStorageCalls = 0;

  const layer = Layer.succeed(DockerRun, {
    run: () => Effect.die("DockerRun.run is unused by migration squash"),
    runCapture: () => Effect.die("DockerRun.runCapture is unused by migration squash"),
    runStream: (dockerOpts, streamOpts) => {
      const isDump = dockerOpts.env["PGDATABASE"] !== undefined;
      if (!isDump) {
        setupJobCalls.push(dockerOpts);
        return Effect.succeed({ exitCode: opts.failSetupJob === true ? 1 : 0, stderr: "" });
      }
      dumpCalls.push(dockerOpts);
      const isAuthStorage = dockerOpts.env["EXTRA_FLAGS"] === "--schema=auth|storage";
      let kind: "before" | "after" | "full";
      let sql: string;
      if (isAuthStorage) {
        authStorageCalls += 1;
        kind = authStorageCalls === 1 ? "before" : "after";
        sql = kind === "before" ? (opts.beforeSql ?? "") : (opts.afterSql ?? "");
      } else {
        kind = "full";
        sql = opts.fullSql ?? "";
      }
      const exitCode = opts.failDump === kind ? 1 : 0;
      return streamOpts
        .onStdout(new TextEncoder().encode(sql))
        .pipe(Effect.as({ exitCode, stderr: "" }));
    },
  });

  return { layer, dumpCalls, setupJobCalls };
}

// A wrapper layer covering every filesystem failure these scenarios need, keyed by
// exact absolute path so unrelated setup reads/writes stay unaffected.
const simulatedFsError = (path: string, method: string) =>
  new PlatformError(
    new SystemError({
      _tag: "Unknown",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: "simulated failure",
    }),
  );

interface FsFaultOpts {
  /** Makes `fs.open(file, { flag: "w" })` itself fail — squash's one target-file open call. */
  readonly failOpenFile?: string;
  /**
   * Lets the Nth+ `writeAll` call on the open handle for `file` fail (1-indexed),
   * succeeding on every earlier call, so the full-dump write (call 1) and the
   * separator/diff tail write (call 2) can be failed independently.
   */
  readonly failWriteAllFromCall?: { readonly file: string; readonly fromCall: number };
  readonly failRemoveFile?: string;
  readonly failMigrationsReadDirectoryAtCall?: number;
}

function faultyFsLayer(workdir: string, opts: FsFaultOpts): Layer.Layer<FileSystem.FileSystem> {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const migrationsDir = pathService.join(workdir, "supabase", "migrations");
      const migrationFile = (file: string) => pathService.join(migrationsDir, file);
      let readDirCallsForPath = 0;
      return FileSystem.FileSystem.of({
        ...real,
        remove: (path, removeOpts) =>
          opts.failRemoveFile !== undefined && path === migrationFile(opts.failRemoveFile)
            ? Effect.fail(simulatedFsError(path, "remove"))
            : real.remove(path, removeOpts),
        readDirectory: (path, readOpts) => {
          if (opts.failMigrationsReadDirectoryAtCall !== undefined && path === migrationsDir) {
            readDirCallsForPath += 1;
            if (readDirCallsForPath === opts.failMigrationsReadDirectoryAtCall) {
              return Effect.fail(simulatedFsError(path, "readDirectory"));
            }
          }
          return real.readDirectory(path, readOpts);
        },
        open: (path, openOpts) => {
          if (
            opts.failOpenFile !== undefined &&
            path === migrationFile(opts.failOpenFile) &&
            openOpts?.flag === "w"
          ) {
            return Effect.fail(simulatedFsError(path, "open"));
          }
          return real.open(path, openOpts).pipe(
            Effect.map((file) => {
              const failWriteAll = opts.failWriteAllFromCall;
              if (failWriteAll === undefined || path !== migrationFile(failWriteAll.file)) {
                return file;
              }
              let writeAllCalls = 0;
              return {
                ...file,
                writeAll: (buffer: Uint8Array) => {
                  writeAllCalls += 1;
                  return writeAllCalls >= failWriteAll.fromCall
                    ? Effect.fail(simulatedFsError(path, "writeAll"))
                    : file.writeAll(buffer);
                },
              };
            }),
          );
        },
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  /** Whether the resolved connection counts as local; a `--db-url` can point either way. */
  readonly isLocal?: boolean;
  readonly failResolve?: boolean;
  readonly failSql?: string;
  readonly networkId?: string;
  readonly neverHealthyShadow?: boolean;
  readonly failCreateShadow?: boolean;
  readonly failRemoveShadow?: boolean;
  readonly failSetupJob?: boolean;
  readonly beforeDumpSql?: string;
  readonly afterDumpSql?: string;
  readonly fullDumpSql?: string;
  readonly failDumpKind?: "before" | "after" | "full";
  readonly fsFaults?: FsFaultOpts;
  readonly args?: ReadonlyArray<string>;
}

function fakeServices(workdir: string, opts: SetupOpts = {}) {
  const spawner = mockShadowContainerCliSpawner({
    neverHealthy: opts.neverHealthyShadow ?? false,
    failCreate: opts.failCreateShadow ?? false,
    failRemove: opts.failRemoveShadow ?? false,
  });
  const docker = mockSquashDockerRun({
    beforeSql: opts.beforeDumpSql,
    afterSql: opts.afterDumpSql,
    fullSql: opts.fullDumpSql,
    failDump: opts.failDumpKind,
    failSetupJob: opts.failSetupJob,
  });

  const execs: Array<string> = [];
  const queries: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  // A single combined call-order log; execs/queries alone can't prove statement order
  // (.toContain/.find are order-blind), so a swapped DELETE/INSERT would still pass
  // against them.
  const statements: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  const connectedDatabases: Array<string> = [];
  const connection = Layer.succeed(DbConnection, {
    connect: (cfg: PgConnInput) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        const session: DbSession = {
          exec: (sql: string) =>
            Effect.suspend(() => {
              execs.push(sql);
              statements.push({ sql });
              return opts.failSql !== undefined && sql.includes(opts.failSql)
                ? Effect.fail(new DbExecError({ message: "boom" }))
                : Effect.void;
            }),
          query: (sql: string, params?: ReadonlyArray<unknown>) =>
            Effect.suspend(() => {
              queries.push({ sql, params });
              statements.push({ sql, params });
              return opts.failSql !== undefined && sql.includes(opts.failSql)
                ? Effect.fail(new DbExecError({ message: "boom" }))
                : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
            }),
          // Replays each statement through exec/query so the call-order log and failure
          // injection still apply.
          execBatch: (batch) => sequentialExecBatch(session)(batch),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });

  const resolverCalls: Array<DbConnectionInput> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      resolverCalls.push(input);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? input.target.kind === "local",
        ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const debugLogs: Array<string> = [];
  const debugLogger = Layer.succeed(DebugLogger, {
    debug: (message: string) =>
      Effect.sync(() => {
        debugLogs.push(message);
      }),
    http: () => Effect.void,
  });

  const http = recordingProjectHttpClient(VALID_REF);
  const baseServices = Layer.mergeAll(
    unusedStackServices,
    // Listed first so every fake service layer below overrides it; Layer.mergeAll is
    // last-wins on a shared service.
    BunServices.layer,
    cliConfigValuesTestLayer,
    opts.realLayers === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: connection,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : resolver,
    connection,
    spawner.layer,
    docker.layer,
    Layer.succeed(BundledPostgresClient, {
      run: () => Effect.die("bundled postgres client unused"),
    }),
    debugLogger,
    alwaysReadyHttpClientLayer,
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(
      NetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    mockRuntimeInfo(),
    shadowCacheDisabledLayer,
  );

  const services =
    opts.fsFaults === undefined
      ? baseServices
      : Layer.merge(baseServices, faultyFsLayer(workdir, opts.fsFaults));

  return {
    services,
    http,
    execs,
    queries,
    statements,
    connectedDatabases,
    resolverCalls,
    debugLogs,
    shadowSpawned: spawner.spawned,
    dumpCalls: docker.dumpCalls,
    setupJobCalls: docker.setupJobCalls,
  };
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const interactive = opts.interactive ?? false;
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive,
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const { services, http, ...fake } = fakeServices(workdir, opts);

  // An explicit --project-ref takes precedence over the VALID_REF fallback, so a test
  // can prove the flag drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      opts.failResolve === true
        ? Effect.fail(
            new ProjectRefNotLinkedError({
              message: "Cannot find project ref. Have you run link?",
            }),
          )
        : Effect.succeed({
            ref: Option.getOrElse(flagValue, () => VALID_REF),
            source: Option.isSome(flagValue) ? ("flag" as const) : ("file" as const),
            matchesLinkedRef: Option.isNone(flagValue),
          }),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const branchApi = mockCommandPlatformApi({
    handler: (request) => Effect.succeed(jsonResponse(request, 200, [branchRow("feature-x")])),
  });
  const layer = Layer.mergeAll(
    services,
    branchApi.layer,
    out.layer,
    telemetry.layer,
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: http.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : cache.layer,
    projectRef,
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    commandRuntimeLayer(["migration", "squash"]).pipe(Layer.provide(BunServices.layer)),
    mockTty({ stdinIsTty: interactive, stdoutIsTty: interactive }),
  );

  return {
    layer,
    http,
    out,
    telemetry,
    cache,
    branchRequests: branchApi.requests,
    ...fake,
  };
}

const flags = (over: Partial<MigrationSquashFlags> = {}): MigrationSquashFlags => ({
  version: over.version ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  password: over.password ?? Option.none(),
  projectRef: over.projectRef ?? Option.none(),
});

const migrationsDirPath = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  return path.join(workdir, "supabase", "migrations");
});

const migrationPath = Effect.fnUntraced(function* (workdir: string, file: string) {
  const path = yield* Path.Path;
  return path.join(yield* migrationsDirPath(workdir), file);
});

const seedMigration = Effect.fnUntraced(function* (
  workdir: string,
  name: string,
  body = "create table t (id int);\n",
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* migrationsDirPath(workdir);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(yield* migrationPath(workdir, name), body);
});

const seedHappyPathMigrations = Effect.fnUntraced(function* (workdir: string) {
  yield* seedMigration(workdir, "0_init.sql", "create table a (id int);\n");
  yield* seedMigration(workdir, "1_target.sql", "create table b (id int);\n");
});

const writeProjectFile = Effect.fnUntraced(function* (workdir: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), body);
});

const readMigration = Effect.fnUntraced(function* (workdir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* migrationPath(workdir, file));
});

const migrationExists = Effect.fnUntraced(function* (workdir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .exists(yield* migrationPath(workdir, file))
    .pipe(Effect.orElseSucceed(() => false));
});

const stdout = (out: ReturnType<typeof mockOutput>) => stripAnsi(out.stdoutText);
const stderr = (out: ReturnType<typeof mockOutput>) => stripAnsi(out.stderrText);

const tmp = useTempWorkdir();

describe("migration squash", () => {
  describe("flag surface & ordering", () => {
    it.effect("rejects --password combined with --remote=<url> through the real resolver", () => {
      const s = setup(tmp.current, { realLayers: true });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        const error = yield* migrationSquash(
          flags({
            remote: Option.some({ _tag: "DbUrl", url: "postgresql://x" }),
            password: Option.some("y"),
          }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(TargetPasswordConflictError);
        expect(s.shadowSpawned).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    });

    it.effect(
      "rejects a non-numeric --version with the bare message (no 'failed to parse' prefix)",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const error = yield* migrationSquash(flags({ version: Option.some("0_init") })).pipe(
            Effect.flip,
          );
          expect(error).toBeInstanceOf(MigrationInvalidVersionError);
          expect(error.message).toBe("invalid version number");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("rejects an out-of-int64-range --version with the same bare message", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const error = yield* migrationSquash(
          flags({ version: Option.some("99999999999999999999") }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(MigrationInvalidVersionError);
        expect(error.message).toBe("invalid version number");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("fails with a glob not-found error when --version matches no local file", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        const error = yield* migrationSquash(flags({ version: Option.some("9") })).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(MigrationFileNotFoundError);
        expect(error.message).toBe("glob supabase/migrations/9_*.sql: file does not exist");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("surfaces a target resolution failure before validating --version", () => {
      const s = setup(tmp.current, { failResolve: true });
      return Effect.gen(function* () {
        const error = yield* migrationSquash(
          flags({ remote: Option.some({ _tag: "Linked" }), version: Option.some("not-a-number") }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
      }).pipe(Effect.provide(s.layer));
    });
  });

  describe("squashToVersion", () => {
    it.effect("fails with 'version not found' when the migrations directory is empty", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const error = yield* migrationSquash(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(MigrationSquashMissingVersionError);
        expect(error.message).toBe("version not found");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with 'version not found' when the only file is a deprecated <14-digit>_init.sql",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "20211208000000_init.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashMissingVersionError);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "surfaces 'failed to read directory' when supabase/migrations is a file, not a directory",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          yield* writeProjectFile(tmp.current, "migrations", "not a directory");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error.message).toContain("failed to read directory");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "no-ops on a single migration: prints the earliest-migration line, spawns no container, and still finishes",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* migrationSquash(flags());
          expect(stderr(s.out)).toContain(
            "supabase/migrations/0_init.sql is already the earliest migration.",
          );
          expect(s.shadowSpawned).toEqual([]);
          expect(s.dumpCalls).toEqual([]);
          // The Finished/repair-suggestion output still runs on the no-op path.
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
          expect(stderr(s.out)).toContain(
            "Run supabase migration repair --status applied --remote to update your remote migration history table.",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );
  });

  describe("squashing local migrations", () => {
    const BEFORE_SQL = "CREATE SCHEMA IF NOT EXISTS auth;\nold auth object;\n";
    const AFTER_SQL = "CREATE SCHEMA IF NOT EXISTS auth;\nnew auth object;\n";
    const FULL_SQL = "CREATE TABLE t (id int);\n";

    function setupHappyPath(opts: SetupOpts = {}) {
      return setup(tmp.current, {
        beforeDumpSql: BEFORE_SQL,
        afterDumpSql: AFTER_SQL,
        fullDumpSql: FULL_SQL,
        ...opts,
      });
    }

    it.effect(
      "squashes two migrations into the last file: applies every migration, deletes the earlier one, and prints the summary",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* migrationSquash(flags());

          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(stderr(s.out)).toContain("Initialising schema...");
          expect(stderr(s.out)).toContain("Applying migration 0_init.sql...");
          expect(stderr(s.out)).toContain("Applying migration 1_target.sql...");
          expect(stderr(s.out)).toContain(
            "Squashed local migrations to supabase/migrations/1_target.sql",
          );

          expect(yield* migrationExists(tmp.current, "0_init.sql")).toBe(false);
          expect(yield* migrationExists(tmp.current, "1_target.sql")).toBe(true);

          // Hardcoded rather than recomputed via squash.diff.ts's helpers, so a regression
          // in the separator constant or the diff algorithm itself still fails this
          // assertion.
          const expectedTail =
            "\n--\n-- Dumped schema changes for auth and storage\n--\n\n" + "new auth object;\n";
          expect(yield* readMigration(tmp.current, "1_target.sql")).toBe(FULL_SQL + expectedTail);

          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "runs the before/after dumps scoped to auth|storage and the full dump excluding the internal schemas",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          const [before, after, full] = s.dumpCalls;
          expect(before?.env["EXTRA_FLAGS"]).toBe("--schema=auth|storage");
          expect(before?.env["EXCLUDED_SCHEMAS"]).toBeUndefined();
          expect(after?.env["EXTRA_FLAGS"]).toBe("--schema=auth|storage");
          expect(after?.env["EXCLUDED_SCHEMAS"]).toBeUndefined();
          expect(full?.env["EXTRA_FLAGS"]).toBeUndefined();
          expect(full?.env["EXCLUDED_SCHEMAS"]).toBe(INTERNAL_SCHEMAS.join("|"));
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "runs every dump container on host networking with the shadow's connection env and the config Postgres image",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* migrationSquash(flags());
          const expectedImage = yield* getRegistryImageUrl(
            dockerfileServiceImage("pg", yield* slimImagesEnabled),
          );
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.env["PGPORT"]).toBe("54320");
            expect(call.env["PGUSER"]).toBe("postgres");
            expect(call.env["PGDATABASE"]).toBe("postgres");
            expect(call.network).toEqual({ _tag: "host" });
            expect(call.cmd).toEqual(["bash", "-c", dumpSchemaScript, "--"]);
            expect(call.image).toBe(expectedImage);
          }
          // Every dump dials the same shadow host, whatever this machine's Docker context
          // resolves (getHostname); checked for self-consistency rather than a hardcoded
          // value.
          const hosts = new Set(s.dumpCalls.map((c) => c.env["PGHOST"]));
          expect(hosts.size).toBe(1);
          const [host] = hosts;
          expect(host).toBeTruthy();
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "dials the shadow's PG15+ setup jobs at the container's 12-char short id (DB_HOST)",
      () => {
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* migrationSquash(flags());
          const expectedHost = FAKE_SHADOW_CONTAINER_ID.slice(0, 12);
          expect(s.setupJobCalls.length).toBeGreaterThan(0);
          let sawHost = false;
          for (const call of s.setupJobCalls) {
            if (call.env["DB_HOST"] !== undefined) {
              expect(call.env["DB_HOST"]).toBe(expectedHost);
              sawHost = true;
            }
            for (const value of Object.values(call.env)) {
              if (value.includes("@") && value.includes(":")) {
                expect(value).toContain(`@${expectedHost}:`);
                sawHost = true;
              }
            }
          }
          expect(sawHost).toBe(true);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "forwards --network-id to every dump container as a named network instead of host",
      () => {
        const s = setupHappyPath({ networkId: "custom-net" });
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.network).toEqual({ _tag: "named", name: "custom-net" });
          }
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "resolves the pg_dump image via SUPABASE_INTERNAL_IMAGE_REGISTRY from supabase/.env",
      () => {
        // The project env is passed explicitly to each pg_dump invocation.
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* writeProjectFile(
            tmp.current,
            ".env",
            "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\n",
          );
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.image).toMatch(/^my-mirror\.example\.com\/supabase\//u);
          }
          // Reverted once the command's scope closes; never leaks into a later command in
          // the same process.
          const ambient = yield* Config.option(
            Config.String("SUPABASE_INTERNAL_IMAGE_REGISTRY"),
          ).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
            ),
          );
          expect(Option.isNone(ambient)).toBe(true);
        }).pipe(Effect.provide(s.layer), (body) =>
          withEnvVar("SUPABASE_INTERNAL_IMAGE_REGISTRY", undefined, body),
        );
      },
    );

    it.effect(
      "resolves the pg_dump network via SUPABASE_NETWORK_ID from supabase/.env when neither the flag nor the ambient env is set",
      () => {
        // Host networking is the default; an explicit network id overrides it whenever
        // it resolves non-empty, even when sourced only from supabase/.env.
        const s = setupHappyPath();
        return Effect.gen(function* () {
          yield* seedHappyPathMigrations(tmp.current);
          yield* writeProjectFile(tmp.current, ".env", "SUPABASE_NETWORK_ID=dotenv-net\n");
          yield* migrationSquash(flags());
          expect(s.dumpCalls).toHaveLength(3);
          for (const call of s.dumpCalls) {
            expect(call.network).toEqual({ _tag: "named", name: "dotenv-net" });
          }
        }).pipe(Effect.provide(s.layer), withEmptyConfigEnv, (body) =>
          withEnvVar("SUPABASE_NETWORK_ID", undefined, body),
        );
      },
    );

    it.effect("squashes only the migrations up to --version, leaving newer ones untouched", () => {
      const s = setup(tmp.current, {
        beforeDumpSql: BEFORE_SQL,
        afterDumpSql: AFTER_SQL,
        fullDumpSql: FULL_SQL,
      });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
        yield* seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
        yield* seedMigration(tmp.current, "2_after.sql", "create table c (id int);\n");
        yield* migrationSquash(flags({ version: Option.some("1") }));
        expect(yield* migrationExists(tmp.current, "0_init.sql")).toBe(false);
        expect(yield* migrationExists(tmp.current, "1_target.sql")).toBe(true);
        expect(yield* readMigration(tmp.current, "2_after.sql")).toBe("create table c (id int);\n");
      }).pipe(Effect.provide(s.layer));
    });
  });

  // Every failure path removes the shadow, unless creation itself failed (the
  // established leak-on-create-failure behavior).
  describe("squashMigrations failure paths", () => {
    it.effect("fails when the shadow container cannot be created and never attempts a dump", () => {
      const s = setup(tmp.current, { failCreateShadow: true });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* seedMigration(tmp.current, "1_target.sql");
        const error = yield* migrationSquash(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ShadowDbError);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        // Nothing to release; the container was never created (see createShadowDatabase's doc).
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toEqual([]);
        expect(s.dumpCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with a health-check timeout when the shadow never becomes healthy, and removes it",
      () => {
        // A zero-second health timeout means zero retries after the first failed
        // probe — an immediate, deterministic timeout with no real/virtual delay.
        const s = setup(tmp.current, { neverHealthyShadow: true });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          yield* writeProjectFile(tmp.current, "config.toml", '[db]\nhealth_timeout = "0s"\n');
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(HealthCheckTimeoutError);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(s.dumpCalls).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails when the shadow's platform-baseline setup job exits non-zero, and removes it",
      () => {
        const s = setup(tmp.current, { failSetupJob: true });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(DbSetupError);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(s.dumpCalls).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails when applying a migration to the shadow errors, and removes it", () => {
      const s = setup(tmp.current, { failSql: "create table boom" });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql", "create table boom;\n");
        yield* seedMigration(tmp.current, "1_target.sql");
        const error = yield* migrationSquash(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(MigrationApplyError);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with 'error running container: exit 1' when the before/after dump container exits non-zero",
      () => {
        const s = setup(tmp.current, { failDumpKind: "before" });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashDumpError);
          expect(error.message).toBe("error running container: exit 1");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'error running container: exit 1' when the full-schema dump exits non-zero, leaving the target file truncated",
      () => {
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "partial output before the container died",
          failDumpKind: "full",
        });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashDumpError);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          // Truncated by the earlier O_TRUNC, then only the partial stream the dying
          // container wrote before failing; no separator/diff was ever appended.
          expect(yield* readMigration(tmp.current, "1_target.sql")).toBe(
            "partial output before the container died",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to open migration file' when the target file cannot be truncated/opened",
      () => {
        // Squash's single O_TRUNC-equivalent open call, so there is exactly one failure
        // site here, not two.
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          fsFaults: { failOpenFile: "1_target.sql" },
        });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashWriteError);
          expect(error.message).toContain("failed to open migration file:");
          // Relativized: the absolute tmp workdir never leaks.
          expect(error.message).not.toContain(tmp.current);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to copy docker logs' when streaming the full dump into the target file fails",
      () => {
        // The underlying failure here is the docker-log-stream write into the target
        // file, so it reports "failed to copy docker logs:", not lineByLineDiff's
        // "failed to write line:".
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          fsFaults: { failWriteAllFromCall: { file: "1_target.sql", fromCall: 1 } },
        });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashWriteError);
          expect(error.message).toContain("failed to copy docker logs:");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'failed to write line' when appending the separator/diff tail fails (the full dump itself wrote fine)",
      () => {
        const s = setup(tmp.current, {
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          // fromCall: 2 lets the full-dump write (call 1) succeed, isolating the tail
          // write (call 2).
          fsFaults: { failWriteAllFromCall: { file: "1_target.sql", fromCall: 2 } },
        });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(flags()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashWriteError);
          expect(error.message).toContain("failed to write line:");
          // Relativized: the absolute tmp workdir never leaks.
          expect(error.message).not.toContain(tmp.current);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(yield* readMigration(tmp.current, "1_target.sql")).toBe("full;\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("prints a merged-file removal error to stderr non-fatally and still succeeds", () => {
      const s = setup(tmp.current, {
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        fsFaults: { failRemoveFile: "0_init.sql" },
      });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* seedMigration(tmp.current, "1_target.sql");
        yield* migrationSquash(flags());
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        expect(stderr(s.out)).toContain("FileSystem.remove (supabase/migrations/0_init.sql)");
        expect(yield* migrationExists(tmp.current, "0_init.sql")).toBe(true);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "reports the removal failure in the machine-mode payload's removeFailures, leaving removed empty",
      () => {
        const s = setup(tmp.current, {
          format: "json",
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          fsFaults: { failRemoveFile: "0_init.sql" },
        });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          yield* migrationSquash(flags());
          const success = s.out.messages.find((m) => m.type === "success");
          expect(success?.data).toMatchObject({
            removed: [],
            removeFailures: [
              {
                path: "supabase/migrations/0_init.sql",
                message: expect.stringContaining(
                  "FileSystem.remove (supabase/migrations/0_init.sql)",
                ),
              },
            ],
          });
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("reports a shadow cleanup failure without failing the command", () => {
      const s = setup(tmp.current, {
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        failRemoveShadow: true,
      });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* seedMigration(tmp.current, "1_target.sql");
        yield* migrationSquash(flags());
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        expect(stderr(s.out)).toContain(`Failed to remove container: ${FAKE_SHADOW_CONTAINER_ID}`);
      }).pipe(Effect.provide(s.layer));
    });
  });

  describe("local target", () => {
    it.effect(
      "prints Finished on stdout and the repair suggestion on stderr, and never prompts",
      () => {
        const s = setup(tmp.current, { interactive: true });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* migrationSquash(flags());
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
          expect(stderr(s.out)).toContain(
            "Run supabase migration repair --status applied --remote to update your remote migration history table.",
          );
          expect(s.out.promptConfirmCalls).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "a --remote=<url> pointing at the local stack also takes the local-suggestion path",
      () => {
        const s = setup(tmp.current, { interactive: true, isLocal: true });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* migrationSquash(
            flags({ remote: Option.some({ _tag: "DbUrl", url: "postgresql://local" }) }),
          );
          expect(stdout(s.out)).toContain("Finished supabase migration squash.");
          expect(s.out.promptConfirmCalls).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );
  });

  describe("hosted target", () => {
    function setupRemote(opts: SetupOpts = {}) {
      return setup(tmp.current, { yes: true, ...opts });
    }
    const hosted = (over: Partial<MigrationSquashFlags> = {}) =>
      flags({ remote: Option.some({ _tag: "Linked" }), ...over });

    it.effect("baselines the remote history table once the consent is given", () => {
      const s = setupRemote();
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(hosted());
        expect(stderr(s.out)).toContain(
          "Confirmed by --yes: Squash local migrations and update the remote migration history table",
        );
        expect(s.queries.some((q) => q.sql.includes("DELETE FROM supabase_migrations"))).toBe(true);
        expect(s.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(true);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "asks once, lists the squash plan, defaults to No, and writes after the accept",
      () => {
        const s = setup(tmp.current, { interactive: true, confirm: true });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
          yield* seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
          yield* migrationSquash(hosted());
          expect(s.out.promptConfirmCalls).toHaveLength(1);
          expect(s.out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
          const text = stderr(s.out);
          expect(text).toContain(
            "Squash 2 local migrations into supabase/migrations/1_target.sql and remove the 1 merged file",
          );
          expect(text).toContain(
            "Reset the remote migration history table to the squashed migration",
          );
          expect(yield* migrationExists(tmp.current, "0_init.sql")).toBe(false);
          expect(s.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(
            true,
          );
          expect(s.cache.cachedRef).toBe(VALID_REF);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "declining aborts before the checkout is rewritten or the remote history is touched",
      () => {
        const s = setup(tmp.current, { interactive: true, confirm: false });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
          yield* seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
          const error = yield* migrationSquash(hosted()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(HostedMutationDeclinedError);
          expect(s.shadowSpawned).toEqual([]);
          expect(s.dumpCalls).toEqual([]);
          expect(s.execs).toEqual([]);
          expect(s.queries).toEqual([]);
          expect(yield* readMigration(tmp.current, "0_init.sql")).toBe(
            "create table a (id int);\n",
          );
          expect(yield* readMigration(tmp.current, "1_target.sql")).toBe(
            "create table b (id int);\n",
          );
          expect(s.cache.cachedRef).toBe(VALID_REF);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "baselines via one transaction: BEGIN, DELETE ... WHERE version <= $1, INSERT ..., COMMIT",
      () => {
        const s = setupRemote();
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* migrationSquash(hosted());
          // The ordered log is the only way to catch an INSERT-before-DELETE regression;
          // the baseline transaction is the last 4 statements, after createMigrationTable's own.
          const baseline = s.statements.slice(-4);
          expect(baseline.map((entry) => entry.sql)).toEqual([
            "BEGIN",
            "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1",
            "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)",
            "COMMIT",
          ]);
          expect(baseline[1]?.params).toEqual(["0"]);
          expect(baseline[2]?.params).toEqual(["0", "init", ["create table t (id int)"]]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "rolls back and reports a baseline failure when the history-table batch fails",
      () => {
        const s = setupRemote({ failSql: "INSERT INTO supabase_migrations" });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          const error = yield* migrationSquash(hosted()).pipe(Effect.flip);
          expect(error).toBeInstanceOf(MigrationSquashBaselineError);
          expect(error.message).toContain("failed to update migration history:");
          expect(s.execs).toContain("ROLLBACK");
          // createMigrationTable's own setup transaction is the only COMMIT.
          expect(s.execs.filter((e) => e === "COMMIT")).toHaveLength(1);
          expect(s.execs.filter((e) => e === "BEGIN")).toHaveLength(2);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "--version 0 baselines exactly version 0 even though a newer migration survives",
      () => {
        const s = setupRemote();
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_newer.sql");
          yield* migrationSquash(hosted({ version: Option.some("0") }));
          const insert = s.queries.find((q) => q.sql.includes("INSERT INTO supabase_migrations"));
          expect(insert?.params?.[0]).toBe("0");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("baselines the surviving older version when a merged-file removal failed", () => {
      // Local versions are re-listed after the file removals, so a failed removal leaves
      // the older merged file's version as what an empty --version baselines to, not the
      // squash target.
      const s = setupRemote({
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
        fsFaults: { failRemoveFile: "0_init.sql" },
      });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* seedMigration(tmp.current, "1_target.sql");
        yield* migrationSquash(hosted());
        const insert = s.queries.find((q) => q.sql.includes("INSERT INTO supabase_migrations"));
        expect(insert?.params?.[0]).toBe("0");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "debug-logs and baselines with an empty version when the post-squash version reload fails",
      () => {
        const s = setupRemote({
          beforeDumpSql: "before;\n",
          afterDumpSql: "after;\n",
          fullDumpSql: "full;\n",
          // Read 1 is the up-front listing (must succeed); read 2 is the baseline's
          // post-removal re-list, which this fails; read 3 (inside resolveMigrationFile)
          // must succeed again to isolate the reload failure.
          fsFaults: { failMigrationsReadDirectoryAtCall: 2 },
        });
        return Effect.gen(function* () {
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* seedMigration(tmp.current, "1_target.sql");
          const error = yield* migrationSquash(hosted()).pipe(Effect.flip);
          expect(s.debugLogs).toHaveLength(1);
          expect(s.debugLogs[0]).toContain("failed to read directory");
          expect(s.debugLogs[0]).toContain("simulated failure");
          expect(stderr(s.out)).toContain("Baselining migration history to \n");
          // The empty-version glob fails, surfacing as the baseline's missing-file error
          // and proving resolvedVersion stayed "" rather than falling back to the squash target.
          expect(error).toBeInstanceOf(MigrationFileNotFoundError);
          expect(error.message).toBe("glob supabase/migrations/_*.sql: file does not exist");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("--remote caches the linked project ref even when the squash fails", () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const error = yield* migrationSquash(hosted({ version: Option.some("bad") })).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(MigrationInvalidVersionError);
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe(VALID_REF);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "--remote reads [remotes.<ref>] and prints the config-override line before the consent",
      () => {
        const s = setupRemote();
        return Effect.gen(function* () {
          yield* writeProjectFile(
            tmp.current,
            "config.toml",
            ["[remotes.dev]", `project_id = "${VALID_REF}"`, ""].join("\n"),
          );
          yield* seedMigration(tmp.current, "0_init.sql");
          yield* migrationSquash(hosted());
          const text = stderr(s.out);
          const overrideAt = text.indexOf("Loading config override: [remotes.dev]");
          const consentAt = text.indexOf("Confirmed by --yes: ");
          expect(overrideAt).toBeGreaterThanOrEqual(0);
          expect(consentAt).toBeGreaterThan(overrideAt);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
      const s = setupRemote({ realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(flags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF }) }));
        expect(s.queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(true);
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `GET /v1/projects/${VALID_REF}/config/database/pooler`,
          `POST /v1/projects/${VALID_REF}/cli/login-role`,
        ]);
        expect(s.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
        assertPermissionDrift({
          command: "migration squash",
          activeFlags: { remote: VALID_REF },
          requests: [...asRecordedRequests(requests), ...s.http.calls],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(s.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    });

    it.effect("fetches the pooler config but mints no login role when --password is given", () => {
      const s = setupRemote({ realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(
          flags({
            password: Option.some("pw"),
            remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
          }),
        );
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        ]);
        assertPermissionDrift({
          command: "migration squash",
          activeFlags: { password: true, remote: VALID_REF },
          requests: [...asRecordedRequests(requests), ...s.http.calls],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(s.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    });
  });

  describe("real resolver on the local target", () => {
    it.effect("defaults to the local target and makes no Management API request", () => {
      const s = setup(tmp.current, { realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, () => undefined);
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(flags());
        expect(stdout(s.out)).toContain("Finished supabase migration squash.");
        expect(requests).toEqual([]);
        expect(s.http.calls).toEqual([]);
        assertPermissionDrift({
          command: "migration squash",
          requests: [],
          exact: true,
        });
        expect(() =>
          assertPermissionDrift({
            command: "migration squash",
            requests: [
              {
                method: "POST",
                url: `https://api.supabase.com/v1/projects/${VALID_REF}/cli/login-role`,
              },
            ],
          }),
        ).toThrow(/condition doesn't hold/);
      }).pipe(
        Effect.scoped,
        Effect.provide(s.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    });
  });

  describe("output formats", () => {
    it.effect("json emits the squash payload on stdout and keeps progress on stderr", () => {
      const s = setup(tmp.current, { format: "json" });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(flags());
        expect(s.out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "Migrations squashed",
            data: {
              squashedInto: "supabase/migrations/0_init.sql",
              removed: [],
              removeFailures: [],
              alreadyEarliest: true,
              isLocal: true,
              baselinedVersion: null,
            },
          }),
        );
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("json suppresses the Finished line and the repair suggestion", () => {
      const s = setup(tmp.current, { format: "json" });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(flags());
        expect(stdout(s.out)).not.toContain("Finished");
        expect(stderr(s.out)).not.toContain("Run supabase migration repair");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("stream-json emits the result event on stdout with progress lines on stderr", () => {
      const s = setup(tmp.current, { format: "stream-json" });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql");
        yield* migrationSquash(flags());
        expect(s.out.messages.some((m) => m.type === "success")).toBe(true);
        expect(stderr(s.out)).toContain("is already the earliest migration.");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("json on the hosted 2-migration path reports the full real payload", () => {
      const s = setup(tmp.current, {
        format: "json",
        yes: true,
        beforeDumpSql: "before;\n",
        afterDumpSql: "after;\n",
        fullDumpSql: "full;\n",
      });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "0_init.sql", "create table a (id int);\n");
        yield* seedMigration(tmp.current, "1_target.sql", "create table b (id int);\n");
        yield* migrationSquash(flags({ remote: Option.some({ _tag: "Linked" }) }));
        const success = s.out.messages.find((m) => m.type === "success");
        // "1_target.sql" is the sole surviving file once "0_init.sql" is removed, so the
        // empty-version baseline reload (run after the removal) resolves to its own
        // version, "1", matching squashedInto below.
        expect(success?.data).toEqual({
          squashedInto: "supabase/migrations/1_target.sql",
          removed: ["supabase/migrations/0_init.sql"],
          removeFailures: [],
          alreadyEarliest: false,
          isLocal: false,
          baselinedVersion: "1",
        });
      }).pipe(Effect.provide(s.layer));
    });
  });
});

describeDbTargetSelection("migration squash", {
  dbUrl: true,
  workdir: () => tmp.current,
  attempt: ({ workdir, args, target }) => {
    const s = setup(workdir, { yes: true, args });
    return {
      layer: s.layer,
      out: s.out,
      run: seedMigration(workdir, "0_init.sql").pipe(
        Effect.andThen(migrationSquash(flags(target))),
      ),
      target: () => s.resolverCalls[0]?.target,
      cachedRef: () => s.cache.cachedRef,
      branchLookups: () => s.branchRequests,
      apiRequests: () => s.branchRequests,
    };
  },
});

describeHostedConsent("migration squash", {
  setup: (workdir) =>
    Effect.gen(function* () {
      yield* seedMigration(workdir, "0_init.sql", "create table a (id int);\n");
      yield* seedMigration(workdir, "1_target.sql", "create table b (id int);\n");
    }).pipe(Effect.provide(Path.layer)),
  invoke: ({ workdir }) => {
    const fake = fakeServices(workdir);
    const historyWrites = () =>
      fake.statements.filter(
        (entry) =>
          entry.sql.includes("INSERT INTO supabase_migrations") ||
          entry.sql.includes("DELETE FROM supabase_migrations"),
      ).length;
    return {
      run: migrationSquash(flags({ remote: Option.some({ _tag: "Linked" }) })).pipe(
        Effect.provide(fake.services),
      ),
      mutations: () => fake.shadowSpawned.length + historyWrites(),
    };
  },
});
