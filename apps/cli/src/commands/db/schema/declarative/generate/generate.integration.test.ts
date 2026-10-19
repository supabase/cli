import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Redacted, Schema, Stream } from "effect";
import { StackError, type DatabaseInstance, type Stack } from "@supabase/stack/effect";
import { vi } from "vitest";

const fixtureNet = vi.hoisted(() => ({ directHostReachable: false }));

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net, fixtureNet)),
);

const reachableDirectHost = withReachableDirectHost(fixtureNet);
import { stripAnsi } from "../../../../../../tests/helpers/ansi.ts";
import { withReachableDirectHost } from "../../../../../../tests/helpers/refuse-invalid-db-hosts.ts";
import {
  BRANCH_PROJECT_REF,
  branchListApi,
  warningsOf,
} from "../../../../../../tests/helpers/db-remote-selection.ts";
import { assertPermissionDrift } from "../../../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  realDbConfigResolver,
  realLinkedProjectCache,
  recordingProjectHttpClient,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../../../tests/helpers/permission-real-layers.ts";
import { unusedGateway } from "../../../../../../tests/helpers/unused-stack.ts";

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
import { configValuesLayer } from "../../../../../../tests/helpers/config-values-layer.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockLocalDockerEngineUnavailableLayer,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
  withConfigEnv,
  withEmptyConfigEnv,
} from "../../../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../../../shared/cli/cli-args.service.ts";
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
import { stackBackendLayer } from "../../../../../command-internal/stack-backend.ts";
import { StackApi } from "../../../../../command-internal/stack-api.ts";
import { DbConfigResolver } from "../../../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../../../command-internal/db-config.types.ts";
import { TargetPasswordConflictError } from "../../../../../command-internal/target/target.errors.ts";
import { TargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import {
  type DbSession,
  DbConnection,
} from "../../../../../command-internal/db-connection.service.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../../../shared/pgdelta-engine.service.ts";
import { DeclarativeShadowDbError } from "../../../shared/pgdelta.errors.ts";
import { DeclarativeSeam } from "../../../shared/pgdelta.seam.service.ts";
import { DeclarativeNotEnabledError } from "../declarative.errors.ts";
import type { DbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import { dbSchemaDeclarativeGenerate } from "./generate.handler.ts";

interface SetupOpts {
  experimental?: boolean;
  args?: ReadonlyArray<string>;
  yes?: boolean;
  stdinIsTty?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  /**
   * Makes `--reset`'s `resetLocalDatabase` fail immediately
   * with `ResetLocalDbNotRunningError` (the local `db` container reports as
   * not running) instead of completing a real recreate.
   */
  resetShouldFail?: boolean;
  networkId?: Option.Option<string>;
  projectId?: Option.Option<string>;
  /** Makes the engine's `exportDeclarativeSchema` fail after recording the call. */
  exportFails?: boolean;
  staleLocalImage?: boolean;
  stackBackend?: boolean;
  /** Runs the real resolver and linked-project cache; `workdir` must be a real directory. */
  realLayers?: boolean;
}

/** What the handler handed the engine for one `exportDeclarativeSchema` call. */
interface EngineExportCall {
  readonly targetRef: string;
  readonly projectRef: string | undefined;
  readonly strictCoverage: boolean;
  readonly debug: boolean;
}

const GENERATE_STACK_ID = "e".repeat(64);
const unusedStack = Effect.die("unused");
const unusedStackFn = () => unusedStack;
const STACK_GENERATE_PORT = 54329;

function generateStackApi(workdir: string) {
  const database: DatabaseInstance = {
    id: "primary",
    service: "database",
    start: unusedStack,
    ready: unusedStack,
    stop: unusedStack,
    restart: unusedStackFn,
    destroy: unusedStack,
    prepare: unusedStack,
    credentials: unusedStackFn,
    saveSnapshot: unusedStackFn,
    restoreSnapshot: unusedStackFn,
    resetData: unusedStack,
    readLogs: () => Stream.empty,
    followStatus: Stream.empty,
    status: Effect.succeed({
      id: "primary",
      config: {
        service: "database",
        config: {
          version: "17",
          databasePassword: Redacted.make("postgres"),
          jwtSecret: Redacted.make("secret"),
          jwtExpiry: 3600,
        },
      },
      endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: STACK_GENERATE_PORT }],
      lifecycle: "running",
      health: "healthy",
      wakeEnabled: true,
      currentOperation: undefined,
      exit: undefined,
      error: undefined,
    }),
  };
  const composition = {
    members: [{ id: database.id, activation: "eager" as const }],
    dependencies: [],
  };
  const stack: Stack = {
    id: GENERATE_STACK_ID,
    services: {
      create: unusedStackFn,
      list: Effect.succeed([database]),
      get: (id) =>
        id === database.id
          ? Effect.succeed(database)
          : Effect.fail(new StackError({ operation: "get", message: "unknown instance" })),
    },
    credentials: { get: unusedStack },
    composition: {
      plan: () => Effect.succeed([]),
      describe: Effect.succeed(composition),
      supabase: unusedStackFn,
      configure: unusedStackFn,
      start: unusedStack,
      stop: unusedStack,
      restart: unusedStack,
    },
    startupEndpointChanges: unusedStack,
    stop: unusedStack,
    destroy: unusedStack,
    gateway: unusedGateway,
    commands: { run: unusedStackFn },
  };
  const identity = { projectRoot: workdir, branchContext: "main", stackName: "default" };
  return Layer.succeed(StackApi, {
    create: unusedStackFn,
    open: () => Effect.succeed(stack),
    discover: () => Effect.die("unused"),
    find: () =>
      Effect.succeed(
        Option.some({
          definition: {
            id: stack.id,
            identity,
            runtime: "native",
            instances: [],
            composition,
            lifetime: "detached" as const,
          },
          host: undefined,
        }),
      ),
    findDeleted: () => Effect.die("unused"),
  });
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const localPostgresImageChecks: Array<true> = [];
  let ensureStartedCalls = 0;
  const platformApi = mockCommandPlatformApiService({});
  // Backs `resetLocalDatabase`'s real, native container-recreate, reached by `--reset`.
  const child = mockContainerCliSpawner(
    defaultLocalResetRoute("test", { running: opts.resetShouldFail !== true }),
  );
  const dbExec: string[] = [];
  const dbConn = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        exec: (sql: string) =>
          Effect.sync(() => {
            dbExec.push(sql);
          }),
        query: (sql: string) =>
          Effect.sync(() => {
            dbExec.push(sql);
            return [];
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });
  const seam = Layer.succeed(DeclarativeSeam, {
    ensureLocalDatabaseStarted: Effect.sync(() => {
      ensureStartedCalls += 1;
    }),
    ensureLocalPostgresImageCurrent: Effect.sync(() => {
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
  const engineExportCalls: EngineExportCall[] = [];
  const engine = Layer.succeed(
    PgDeltaEngine,
    PgDeltaEngine.of({
      diffExplicit: () => Effect.die("diffExplicit not used in generate tests"),
      diffDatabase: () => Effect.die("diffDatabase not used in generate tests"),
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema not used in generate tests"),
      exportDeclarativeSchema: (input) =>
        Effect.suspend(() => {
          engineExportCalls.push({
            targetRef: input.target.ref,
            projectRef: input.projectRef,
            strictCoverage: input.strictCoverage,
            debug: input.debug,
          });
          return opts.exportFails === true
            ? Effect.fail(
                new PgDeltaEngineError({
                  message: "declarative export failed",
                  cause: undefined,
                }),
              )
            : Effect.succeed({
                files: [{ name: "public/tables/players.sql", sql: "create table players ();" }],
                manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
              });
        }),
    }),
  );
  const resolverCalls: DbConnectionInput[] = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input) =>
      Effect.sync(() => {
        resolverCalls.push(input);
        const { target } = input;
        if (target.kind === "local") {
          return {
            conn: {
              host: "127.0.0.1",
              port: opts.stackBackend === true ? STACK_GENERATE_PORT : 54322,
              user: "postgres",
              password: opts.stackBackend === true ? "stack-secret" : "postgres",
              database: "postgres",
            },
            isLocal: true,
            ref: Option.none(),
            target,
          } satisfies ResolvedDbConnection;
        }
        return {
          conn: {
            host: "db.remote",
            port: 5432,
            user: "postgres",
            password: "x",
            database: "postgres",
          },
          isLocal: false,
          ref: target.kind === "linked" ? Option.some(target.ref) : Option.none(),
          target,
        } satisfies ResolvedDbConnection;
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  const runtimeInfo = mockRuntimeInfo({ platform: "linux" });
  const processControl = mockProcessControl();
  const experimentalFlag = Layer.succeed(ExperimentalFlag, opts.experimental ?? true);
  const cliArgs = Layer.succeed(CliArgs, {
    args: opts.args ?? ["db", "schema", "declarative", "generate"],
  });
  const networkIdFlag = Layer.succeed(NetworkIdFlag, opts.networkId ?? Option.none());
  const debugFlag = Layer.succeed(DebugFlag, false);
  const dockerRun = dockerRunLayer.pipe(
    Layer.provide(child.layer),
    Layer.provide(processControl.layer),
  );
  const projectHttp = recordingProjectHttpClient(VALID_REF);
  const cliSettings = mockCommandSettings({
    workdir,
    projectId: opts.projectId ?? Option.some("test"),
  });
  const tty = mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false });
  const stdin = mockStdin(opts.stdinIsTty ?? false);
  const linkedProjectCache =
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: projectHttp.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : cache.layer;
  const runtime = buildTestRuntime({
    out,
    api: platformApi,
    cliSettings,
    tty,
    stdin,
    processControl,
    runtimeInfo,
    telemetry: telemetry.layer,
    linkedProjectCache,
    cliArgs: opts.args ?? ["db", "schema", "declarative", "generate"],
  });
  const layer = Layer.mergeAll(
    runtime,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    out.layer,
    configValuesLayer({
      output: out.layer,
      env: Option.match(opts.projectId ?? Option.some("test"), {
        onNone: () => ({}),
        onSome: (projectId) => ({ SUPABASE_PROJECT_ID: projectId }),
      }),
    }),
    telemetry.layer,
    linkedProjectCache,
    seam,
    engine,
    mockLocalDockerEngineUnavailableLayer,
    opts.realLayers === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: dbConn,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : resolver,
    dbConn,
    cliSettings,
    tty,
    stdin,
    experimentalFlag,
    cliArgs,
    Layer.succeed(YesFlag, opts.yes ?? false),
    networkIdFlag,
    Layer.succeed(DnsResolverFlag, "native"),
    debugFlag,
    // The local-reset bucket-seed core statically requires the (lazy) Management-API
    // factory; never invoked on the local reset (projectRef === "").
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
    dockerRun,
    ...(opts.stackBackend === true
      ? [stackBackendLayer("stack"), generateStackApi(workdir)]
      : [generateStackApi(workdir)]),
  );
  return {
    layer,
    out,
    cache,
    telemetry,
    child,
    dbExec,
    engineExportCalls,
    resolverCalls,
    projectHttp,
    localPostgresImageChecks,
    get ensureStartedCalls() {
      return ensureStartedCalls;
    },
  };
}

const REMOTE_LINKED: DbSchemaDeclarativeGenerateFlags["remote"] = Option.some({ _tag: "Linked" });

const flags = (
  over: Partial<DbSchemaDeclarativeGenerateFlags> = {},
): DbSchemaDeclarativeGenerateFlags => ({
  noCache: over.noCache ?? false,
  strictCoverage: over.strictCoverage ?? false,
  overwrite: over.overwrite ?? false,
  outputDir: over.outputDir ?? Option.none(),
  reset: over.reset ?? false,
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const disablePgDelta = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workdir, "supabase", "config.toml"),
      "[experimental.pgdelta]\nenabled = false\n",
    );
  });

describe("db schema declarative generate integration", () => {
  const tmp = useTempWorkdir();

  it.effect("gate is open by default: runs without --experimental or any pgdelta config", () => {
    const s = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(
        yield* fs.exists(
          path.join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("gate: fails when config disables pg-delta", () => {
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      yield* disablePgDelta(tmp.current);
      const error = yield* Effect.flip(dbSchemaDeclarativeGenerate(flags()));
      expect(error).toBeInstanceOf(DeclarativeNotEnabledError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--local --linked with --experimental fails with the selector conflict", () => {
    const { layer } = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        dbSchemaDeclarativeGenerate(flags({ local: true, linked: true })),
      );
      expect(error).toMatchObject({
        _tag: "TargetSelectorConflictError",
        message:
          "Only one of --remote, --linked, --db-url and --local can be set; got --linked and --local.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "--local --linked without --experimental fails with the gate error, not the selector conflict",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      return Effect.gen(function* () {
        yield* disablePgDelta(tmp.current);
        const error = yield* Effect.flip(
          dbSchemaDeclarativeGenerate(flags({ local: true, linked: true })),
        );
        expect(error).toBeInstanceOf(DeclarativeNotEnabledError);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--local --linked with SUPABASE_EXPERIMENTAL env (no --experimental flag) fails with the selector conflict",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        const error = yield* withConfigEnv(
          { [ENV]: "1" },
          Effect.flip(dbSchemaDeclarativeGenerate(flags({ local: true, linked: true }))),
        );
        expect(error).toMatchObject({
          _tag: "TargetSelectorConflictError",
          message:
            "Only one of --remote, --linked, --db-url and --local can be set; got --linked and --local.",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an explicit --experimental=false closes the gate even when SUPABASE_EXPERIMENTAL is set",
    () => {
      const { layer } = setup(tmp.current, {
        experimental: false,
        args: ["db", "schema", "declarative", "generate", "--experimental=false"],
      });
      const ENV = "SUPABASE_EXPERIMENTAL";
      return Effect.gen(function* () {
        yield* disablePgDelta(tmp.current);
        const error = yield* withConfigEnv(
          { [ENV]: "1" },
          Effect.flip(dbSchemaDeclarativeGenerate(flags())),
        );
        expect(error).toBeInstanceOf(DeclarativeNotEnabledError);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--local --linked with SUPABASE_EXPERIMENTAL set only in the project .env fails with the selector conflict",
    () => {
      const { layer } = setup(tmp.current, { experimental: false });
      return withEmptyConfigEnv(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            path.join(tmp.current, "supabase", ".env"),
            "SUPABASE_EXPERIMENTAL=true\n",
          );
          const error = yield* Effect.flip(
            dbSchemaDeclarativeGenerate(flags({ local: true, linked: true })),
          );
          expect(error).toMatchObject({
            _tag: "TargetSelectorConflictError",
            message:
              "Only one of --remote, --linked, --db-url and --local can be set; got --linked and --local.",
          });
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect("warns when the tree still lives under the former supabase/database default", () => {
    // Upgrade path: the implicit default moved from supabase/database to
    // supabase/schemas; a project relying on the old default must be told before
    // a fresh tree is generated somewhere its existing files are not.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase", "database"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "database", "public.sql"),
        "create table a();",
      );
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(stripAnsi(s.out.stderrText)).toContain(
        "WARNING: found declarative schema files in supabase/database, but the default declarative directory is now supabase/schemas.",
      );
      expect(stripAnsi(s.out.stderrText)).toContain('declarative_schema_path = "./database"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("exports from the default local database and writes files", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.engineExportCalls[0]?.targetRef).toContain(
        "postgresql://postgres:postgres@127.0.0.1:54322",
      );
      const written = yield* fs.readFileString(
        path.join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql"),
      );
      expect(written).toBe("create table players ();");
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${path.join("supabase", "schemas")}\n`,
        stream: "stderr",
      });
      expect(s.out.rawChunks.some((c) => c.text.includes(tmp.current))).toBe(false);
      expect(s.ensureStartedCalls).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "the default local target on the stack backend exports from stack credentials, not toml [db].port",
    () => {
      const s = setup(tmp.current, { experimental: true, stackBackend: true });
      return Effect.gen(function* () {
        yield* dbSchemaDeclarativeGenerate(flags());
        expect(s.engineExportCalls[0]?.targetRef).toContain(
          "postgresql://postgres:stack-secret@127.0.0.1:54329",
        );
        expect(s.engineExportCalls[0]?.targetRef).not.toContain(":54322");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("defaults to the local database with no target flag and no prompt", () => {
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.resolverCalls.map((call) => call.target.kind)).toEqual(["local"]);
      expect(s.engineExportCalls[0]?.targetRef).toContain("@127.0.0.1:54322");
      expect(s.ensureStartedCalls).toBe(1);
      expect(localResetRemovedContainers(s.child.spawned)).toEqual([]);
      expect(s.out.promptSelectCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("selects the linked project for a bare --remote", () => {
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(VALID_REF) });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ remote: Option.some({ _tag: "Linked" }) }));
      expect(s.resolverCalls.map((call) => call.target)).toEqual([
        expect.objectContaining({ kind: "linked", ref: VALID_REF }),
      ]);
      expect(s.ensureStartedCalls).toBe(0);
      expect(s.engineExportCalls[0]?.projectRef).toBe(VALID_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--remote=<ref> selects that project without a linked workdir", () => {
    const s = setup(tmp.current, { experimental: true, projectId: Option.none() });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(
        flags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const) }),
      );
      expect(s.resolverCalls.map((call) => call.target)).toEqual([
        expect.objectContaining({ kind: "linked", ref: VALID_REF, source: "flag" }),
      ]);
      expect(s.engineExportCalls[0]?.projectRef).toBe(VALID_REF);
      expect(s.ensureStartedCalls).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--reset recreates the local database before exporting", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "config.toml"),
        'project_id = "test"\n',
      );
      yield* dbSchemaDeclarativeGenerate(flags({ reset: true }));
      expect(localResetRemovedContainers(s.child.spawned)).toContain("supabase_db_test");
      expect(localResetCreateArgs(s.child.spawned)).not.toBeUndefined();
      expect(s.out.rawChunks.some((c) => c.text.includes("Resetting local database"))).toBe(true);
      expect(s.engineExportCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--reset forwards --network-id to the local reset", () => {
    const s = setup(tmp.current, { experimental: true, networkId: Option.some("my-net") });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "config.toml"),
        'project_id = "test"\n',
      );
      yield* dbSchemaDeclarativeGenerate(flags({ reset: true }));
      const createArgs = localResetCreateArgs(s.child.spawned);
      const networkIndex = createArgs?.indexOf("--network") ?? -1;
      expect(networkIndex).toBeGreaterThanOrEqual(0);
      expect(createArgs?.[networkIndex + 1]).toBe("my-net");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--reset propagates a reset failure instead of exiting the process", () => {
    const s = setup(tmp.current, { experimental: true, resetShouldFail: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(dbSchemaDeclarativeGenerate(flags({ reset: true })));
      expect(error).toMatchObject({
        message: "database reset failed: supabase start is not running.",
      });
      expect(localResetRemovedContainers(s.child.spawned)).toEqual([]);
      expect(s.engineExportCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--output-dir writes a complete export relative to the project without activating it",
    () => {
      const config = [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "supabase/database"',
        "",
      ].join("\n");
      const s = setup(tmp.current, { experimental: true });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(tmp.current, "supabase", "database"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(tmp.current, "supabase", "database", "configured.sql"),
          "select 1;",
        );
        const configPath = path.join(tmp.current, "supabase", "config.toml");
        yield* fs.writeFileString(configPath, config);
        const destination = path.join("supabase", "database-next");
        yield* dbSchemaDeclarativeGenerate(flags({ outputDir: Option.some(destination) }));

        expect(
          yield* fs.readFileString(
            path.join(tmp.current, destination, "public", "tables", "players.sql"),
          ),
        ).toBe("create table players ();");
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            yield* fs.readFileString(path.join(tmp.current, destination, ".pgdelta-export.json")),
          ),
        ).toMatchObject({
          formatVersion: 1,
          profile: "supabase",
          files: ["public/tables/players.sql"],
        });
        expect(
          yield* fs.readFileString(
            path.join(tmp.current, "supabase", "database", "configured.sql"),
          ),
        ).toBe("select 1;");
        expect(yield* fs.readFileString(configPath)).toBe(config);
        expect(
          s.out.rawChunks.map((chunk) => ({ text: stripAnsi(chunk.text), stream: chunk.stream })),
        ).toContainEqual({
          text: `Declarative schema written to ${destination}\n`,
          stream: "stderr",
        });
      }).pipe(Effect.provide(s.layer));
    },
  );

  for (const [label, target] of [
    ["the default local target", {}],
    [
      "--remote=<db-url>",
      { remote: Option.some({ _tag: "DbUrl", url: "postgresql://x" } as const) },
    ],
  ] as const) {
    it.effect(`rejects --password combined with ${label}`, () => {
      const s = setup(tmp.current, { experimental: true, realLayers: true });
      return Effect.gen(function* () {
        const error = yield* dbSchemaDeclarativeGenerate(
          flags({ ...target, password: Option.some("pw") }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(TargetPasswordConflictError);
        expect(s.engineExportCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });
  }

  it.effect("--output-dir protects a non-empty destination without --overwrite", () => {
    const s = setup(tmp.current, {
      experimental: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = path.join(tmp.current, "staged-schema");
      yield* fs.makeDirectory(destination, { recursive: true });
      yield* fs.writeFileString(path.join(destination, "keep.sql"), "select 'keep';");
      yield* dbSchemaDeclarativeGenerate(flags({ outputDir: Option.some(destination) }));
      expect(yield* fs.readFileString(path.join(destination, "keep.sql"))).toBe("select 'keep';");
      expect(yield* fs.exists(path.join(destination, ".pgdelta-export.json"))).toBe(false);
      expect(s.out.rawChunks.some((chunk) => chunk.text.includes("Skipped writing"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects output paths that could overwrite the project or an ancestor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = path.join(tmp.current, "project");
      yield* fs.makeDirectory(projectDir, { recursive: true });
      const sentinel = path.join(projectDir, "project-sentinel.txt");
      yield* fs.writeFileString(sentinel, "keep");
      const s = setup(projectDir, { experimental: true });
      yield* Effect.gen(function* () {
        for (const output of ["", ".", "..", path.dirname(projectDir)]) {
          const error = yield* dbSchemaDeclarativeGenerate(
            flags({ outputDir: Option.some(output), overwrite: true }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeclarativeWriteError",
            message:
              "declarative output directory must not be empty, resolve to the project directory, or contain the project directory",
          });
          expect(yield* fs.readFileString(sentinel)).toBe("keep");
        }
        expect(s.localPostgresImageChecks).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("--output-dir leaves the configured declarative tree untouched", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* dbSchemaDeclarativeGenerate(flags({ outputDir: Option.some("staged-schema") }));
      expect(
        yield* fs.exists(
          path.join(tmp.current, "staged-schema", "public", "tables", "players.sql"),
        ),
      ).toBe(true);
      expect(yield* fs.exists(path.join(tmp.current, "supabase", "schemas"))).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("the default local target checks the local Postgres image before generating", () => {
    const s = setup(tmp.current, { experimental: true, staleLocalImage: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(dbSchemaDeclarativeGenerate(flags()));
      expect(error).toMatchObject({
        _tag: "DeclarativeShadowDbError",
        message: "local Postgres container image is stale",
      });
      expect(s.localPostgresImageChecks).toHaveLength(1);
      expect(s.ensureStartedCalls).toBe(0);
      expect(s.engineExportCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --yes to overwrite existing declarative files without prompting", () => {
    // Pre-seeds the declarative dir so the overwrite branch is reached. No
    // `promptConfirmResponses` are queued, so reaching the prompt would error — success proves
    // `--yes` bypassed it.
    const s = setup(tmp.current, { experimental: true, yes: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase", "schemas"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "schemas", "existing.sql"),
        "create table x ();",
      );
      yield* dbSchemaDeclarativeGenerate(flags());
      const written = yield* fs.readFileString(
        path.join(tmp.current, "supabase", "schemas", "public", "tables", "players.sql"),
      );
      expect(written).toBe("create table players ();");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("aborts (does not overwrite) when the declarative dir cannot be read", () => {
    // Seeding `supabase/schemas` as a file makes `readDirectory` fail with ENOTDIR.
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(tmp.current, "supabase", "schemas"), "not a directory");
      const exit = yield* Effect.exit(dbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.readFileString(path.join(tmp.current, "supabase", "schemas"))).toBe(
        "not a directory",
      );
      expect(s.out.rawChunks.some((c) => c.text.includes("Declarative schema written to"))).toBe(
        false,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--remote=<db-url> resolves the URL via the resolver", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(
        flags({ remote: Option.some({ _tag: "DbUrl", url: "postgres://remote/db" } as const) }),
      );
      expect(s.resolverCalls.length).toBe(1);
      expect(s.engineExportCalls[0]?.targetRef).toContain("@db.remote:5432");
      expect(s.ensureStartedCalls).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes to an absolute declarative_schema_path as-is (no workdir prefix)", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const absSchema = yield* fs.makeTempDirectoryScoped({ prefix: "decl-abs-" });
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "config.toml"),
        [
          "[experimental.pgdelta]",
          "enabled = true",
          `declarative_schema_path = "${absSchema}"`,
          "",
        ].join("\n"),
      );
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(yield* fs.exists(path.join(absSchema, "public", "tables", "players.sql"))).toBe(true);
      expect(
        yield* fs.readFileString(path.join(absSchema, "public", "tables", "players.sql")),
      ).toBe("create table players ();");
      expect(
        s.out.rawChunks.map((c) => ({ text: stripAnsi(c.text), stream: c.stream })),
      ).toContainEqual({
        text: `Declarative schema written to ${absSchema}\n`,
        stream: "stderr",
      });
    }).pipe(Effect.scoped, Effect.provide(s.layer));
  });

  it.effect("--remote applies a matching [remotes.<ref>] schema-path override", () => {
    const ref = "abcdefghijklmnopqrst";
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "config.toml"),
        [
          'project_id = "base"',
          "[experimental.pgdelta]",
          "enabled = true",
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental.pgdelta]",
          'declarative_schema_path = "remote_schema"',
          "",
        ].join("\n"),
      );
      yield* dbSchemaDeclarativeGenerate(flags({ remote: REMOTE_LINKED }));
      const written = yield* fs.readFileString(
        path.join(tmp.current, "supabase", "remote_schema", "public", "tables", "players.sql"),
      );
      expect(written).toBe("create table players ();");
      expect(s.engineExportCalls[0]?.projectRef).toBe(ref);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("caches the linked project after generate --remote", () => {
    const ref = "abcdefghijklmnopqrst";
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ remote: REMOTE_LINKED }));
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cacheCount).toBe(1);
      expect(s.telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("does not cache the linked project for a local run in a linked workdir", () => {
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(VALID_REF) });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.cache.cached).toBe(false);
      expect(s.telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--remote gates pg-delta on base config, not a remote enabled override", () => {
    const ref = "abcdefghijklmnopqrst";
    const s = setup(tmp.current, { experimental: false, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tmp.current, "supabase", "config.toml"),
        [
          'project_id = "base"',
          "[experimental.pgdelta]",
          "enabled = false",
          "[remotes.prod]",
          `project_id = "${ref}"`,
          "[remotes.prod.experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
      );
      const error = yield* Effect.flip(
        dbSchemaDeclarativeGenerate(flags({ remote: REMOTE_LINKED })),
      );
      expect(error).toBeInstanceOf(DeclarativeNotEnabledError);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "existing declarative files without --overwrite are skipped when the prompt is declined",
    () => {
      const s = setup(tmp.current, {
        experimental: true,
        stdinIsTty: true,
        promptConfirmResponses: [false],
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const declDir = path.join(tmp.current, "supabase", "schemas");
        yield* fs.makeDirectory(declDir, { recursive: true });
        yield* fs.writeFileString(path.join(declDir, "existing.sql"), "-- existing");
        yield* dbSchemaDeclarativeGenerate(flags());
        expect(yield* fs.readFileString(path.join(declDir, "existing.sql"))).toBe("-- existing");
        expect(yield* fs.exists(path.join(declDir, "public", "tables", "players.sql"))).toBe(false);
        expect(
          s.out.rawChunks.some((c) => c.text.includes("Skipped writing declarative schema")),
        ).toBe(true);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("SUPABASE_YES=1 overwrites existing declarative files like --yes", () => {
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return withConfigEnv(
      { SUPABASE_YES: "1" },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const declDir = path.join(tmp.current, "supabase", "schemas");
        yield* fs.makeDirectory(declDir, { recursive: true });
        yield* fs.writeFileString(path.join(declDir, "existing.sql"), "-- existing");
        yield* dbSchemaDeclarativeGenerate(flags());
        expect(s.engineExportCalls).toHaveLength(1);
        expect(stripAnsi(s.out.stderrText)).toContain(
          "Overwrite declarative schema? Existing files may be deleted. [y/N] y\n",
        );
        expect(yield* fs.exists(path.join(declDir, "public", "tables", "players.sql"))).toBe(true);
      }).pipe(Effect.provide(s.layer)),
    );
  });

  it.effect("passes --strict-coverage through to the engine export", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags({ noCache: true, strictCoverage: true }));
      expect(s.engineExportCalls).toEqual([expect.objectContaining({ strictCoverage: true })]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect.each([
    { value: "1", debug: true },
    { value: "", debug: false },
  ])('passes PGDELTA_DEBUG="$value" through to the engine export', ({ value, debug }) => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags());
      expect(s.engineExportCalls.map((call) => call.debug)).toEqual([debug]);
    }).pipe(Effect.provide(s.layer), (body) => withConfigEnv({ PGDELTA_DEBUG: value }, body));
  });

  it.effect("fails generate when the engine export fails", () => {
    const s = setup(tmp.current, { experimental: true, exportFails: true });
    return Effect.gen(function* () {
      const error = yield* dbSchemaDeclarativeGenerate(flags()).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PgDeltaEngineError",
        message: "declarative export failed",
      });
      expect(s.out.rawChunks.some((c) => c.text.includes("Declarative schema written to"))).toBe(
        false,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes the engine's export manifest alongside the declarative tree", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* dbSchemaDeclarativeGenerate(flags());
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* fs.readFileString(
          path.join(tmp.current, "supabase", "schemas", ".pgdelta-export.json"),
        ),
      );
      expect(manifest).toMatchObject({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["public/tables/players.sql"],
      });
    }).pipe(Effect.provide(s.layer));
  });
});

describe("db schema declarative generate permissions through the real resolver and cache", () => {
  const tmp = useTempWorkdir();
  const asLines = (requests: ReadonlyArray<StubbedRequest>) =>
    requests.map(({ method, path }) => `${method} ${path}`);
  const loginRoleRequest = `POST /v1/projects/${VALID_REF}/cli/login-role`;
  const poolerRequest = `GET /v1/projects/${VALID_REF}/config/database/pooler`;
  const cacheRequest = `GET https://api.supabase.com/v1/projects/${VALID_REF}`;
  const cacheCalls = (calls: ReadonlyArray<{ readonly method: string; readonly url: string }>) =>
    calls.map(({ method, url }) => `${method} ${url}`);
  const saveLinkedRef = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${tmp.current}/supabase/.temp`, { recursive: true });
    yield* fs.writeFileString(`${tmp.current}/supabase/.temp/project-ref`, VALID_REF);
  });

  it.effect("mints a login role and fills the cache for a bare --remote", () => {
    const s = setup(tmp.current, { realLayers: true, projectId: Option.some(VALID_REF) });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* reachableDirectHost;
      yield* saveLinkedRef;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbSchemaDeclarativeGenerate(flags({ remote: REMOTE_LINKED })).pipe(
        Effect.provide(s.layer),
      );
      expect(s.engineExportCalls).toHaveLength(1);
      expect(asLines(requests)).toEqual([loginRoleRequest]);
      expect(cacheCalls(s.projectHttp.calls)).toEqual([cacheRequest]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "db schema declarative generate",
        activeFlags: { remote: true },
        requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("does not mint a login role for --remote with --password", () => {
    const s = setup(tmp.current, { realLayers: true, projectId: Option.some(VALID_REF) });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* reachableDirectHost;
      yield* saveLinkedRef;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbSchemaDeclarativeGenerate(
        flags({ remote: REMOTE_LINKED, password: Option.some("secret") }),
      ).pipe(Effect.provide(s.layer));
      expect(requests).toEqual([]);
      expect(cacheCalls(s.projectHttp.calls)).toEqual([cacheRequest]);
      assertPermissionDrift({
        command: "db schema declarative generate",
        activeFlags: { remote: true, password: true },
        requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for the default local target", () => {
    const s = setup(tmp.current, { realLayers: true, projectId: Option.some(VALID_REF) });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* saveLinkedRef;
      yield* stubManagementApi(requests, () => undefined);
      yield* dbSchemaDeclarativeGenerate(flags()).pipe(Effect.provide(s.layer));
      expect(s.engineExportCalls).toHaveLength(1);
      expect(requests).toEqual([]);
      expect(s.projectHttp.calls).toEqual([]);
      assertPermissionDrift({
        command: "db schema declarative generate",
        activeFlags: {},
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for --remote=<db-url>", () => {
    const s = setup(tmp.current, { realLayers: true, projectId: Option.some(VALID_REF) });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* saveLinkedRef;
      yield* stubManagementApi(requests, () => undefined);
      yield* dbSchemaDeclarativeGenerate(
        flags({
          remote: Option.some({
            _tag: "DbUrl",
            url: "postgres://alice:secret@example.com:6543/appdb",
          }),
        }),
      ).pipe(Effect.provide(s.layer));
      expect(s.engineExportCalls).toHaveLength(1);
      expect(requests).toEqual([]);
      expect(s.projectHttp.calls).toEqual([]);
      assertPermissionDrift({
        command: "db schema declarative generate",
        activeFlags: { remote: true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("fetches the pooler and mints a login role for --remote=<ref>", () => {
    const s = setup(tmp.current, { realLayers: true, projectId: Option.none() });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbSchemaDeclarativeGenerate(
        flags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const) }),
      ).pipe(Effect.provide(s.layer));
      expect(s.engineExportCalls).toHaveLength(1);
      expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
      assertPermissionDrift({
        command: "db schema declarative generate",
        activeFlags: { remote: VALID_REF },
        requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});

describe("db schema declarative generate target selection", () => {
  const tmp = useTempWorkdir();
  const FLAG_PROJECT_REF = "flagflagflagflagflag";

  const resolvedTarget = (
    selector: Partial<DbSchemaDeclarativeGenerateFlags>,
    options: { readonly branchApi?: ReturnType<typeof branchListApi> } = {},
  ) => {
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(VALID_REF) });
    const provided =
      options.branchApi === undefined ? s.layer : Layer.merge(s.layer, options.branchApi.layer);
    return Effect.gen(function* () {
      yield* dbSchemaDeclarativeGenerate(flags(selector)).pipe(Effect.provide(provided));
      return { target: s.resolverCalls[0]?.target, warnings: warningsOf(s.out) };
    });
  };

  it.effect("targets the local database, with no warning, when nothing selects one", () =>
    Effect.gen(function* () {
      const { target, warnings } = yield* resolvedTarget({});
      expect(target).toEqual({ kind: "local" });
      expect(warnings).toEqual([]);
    }),
  );

  it.effect("targets the project --remote=<ref> names, with no warning", () =>
    Effect.gen(function* () {
      const { target, warnings } = yield* resolvedTarget({
        remote: Option.some({ _tag: "Ref", ref: FLAG_PROJECT_REF } as const),
      });
      expect(target).toMatchObject({ kind: "linked", ref: FLAG_PROJECT_REF, source: "flag" });
      expect(warnings).toEqual([]);
    }),
  );

  it.effect("targets the database --remote=<db-url> names, with no warning", () =>
    Effect.gen(function* () {
      const { target, warnings } = yield* resolvedTarget({
        remote: Option.some({
          _tag: "DbUrl",
          url: "postgresql://postgres:pw@db.example.com/db",
        } as const),
      });
      expect(target?.kind).toBe("db-url");
      expect(warnings).toEqual([]);
    }),
  );

  it.effect("targets the project of the branch --remote=<branch> names", () => {
    const branchApi = branchListApi();
    return Effect.gen(function* () {
      const { target, warnings } = yield* resolvedTarget(
        { remote: Option.some({ _tag: "Branch", name: "feature-x" }) },
        { branchApi },
      );
      expect(target).toMatchObject({ kind: "linked", ref: BRANCH_PROJECT_REF, source: "flag" });
      expect(warnings).toEqual([]);
      assertPermissionDrift({
        command: "db schema declarative generate",
        activeFlags: { remote: "feature-x" },
        requests: branchApi.requests,
      });
    });
  });

  it.effect.each([
    {
      alias: "--linked",
      flags: { linked: true },
      kind: "linked",
      warning: "--linked is deprecated and will be removed in v4. Use --remote instead",
    },
    {
      alias: "--project-ref",
      flags: { projectRef: Option.some(FLAG_PROJECT_REF) },
      kind: "linked",
      warning: "--project-ref is deprecated and will be removed in v4. Use --remote instead",
    },
    {
      alias: "--db-url",
      flags: { dbUrl: Option.some("postgresql://postgres:pw@db.example.com/db") },
      kind: "db-url",
      warning: "--db-url is deprecated and will be removed in v4. Use --remote instead",
    },
    {
      alias: "--local",
      flags: { local: true },
      kind: "local",
      warning: "--local isn't needed (local is the default) and will be removed in v4",
    },
  ] satisfies ReadonlyArray<{
    alias: string;
    flags: Partial<DbSchemaDeclarativeGenerateFlags>;
    kind: string;
    warning: string;
  }>)("keeps $alias working and warns that it is deprecated", ({ flags, kind, warning }) =>
    Effect.gen(function* () {
      const { target, warnings } = yield* resolvedTarget(flags);
      expect(target?.kind).toBe(kind);
      expect(warnings).toEqual([expect.stringContaining(warning)]);
    }),
  );
});
