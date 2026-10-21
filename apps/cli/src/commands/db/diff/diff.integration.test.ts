import { unusedGateway, unusedStackServices } from "../../../../tests/helpers/unused-stack.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { DatabaseInstance, Stack } from "@supabase/stack/effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import { describeDbTargetSelection } from "../../../../tests/helpers/db-target-selection.ts";
import {
  BRANCH_PROJECT_REF,
  branchListApi,
  warningsOf,
} from "../../../../tests/helpers/remote-selection.ts";
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
import {
  FAKE_SHADOW_CONTAINER_ID,
  VALID_REF,
  VALID_TOKEN,
  failWriteStringMatchingFsLayer,
  failWriteStringOnNthCallFsLayer,
  withConfigEnv,
  withEnvVar,
  mockCommandSettings,
  mockDockerDaemonCliSpawner,
  mockLinkedProjectCacheTracked,
  mockLocalDockerEngineUnavailableLayer,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  shadowCacheDisabledLayer,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import { configValuesLayer, flagInput } from "../../../../tests/helpers/config-values-layer.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import { commandTargetLayer } from "../../../shared/output/command-target.layer.ts";
import { CommandTarget } from "../../../shared/output/command-target.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import {
  DbConfigIpv6Error,
  DbConfigLoadError,
} from "../../../command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { describeLinkedTarget } from "../../../command-internal/target/target-identity.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import {
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import { DockerRunError } from "../../../command-internal/docker-run.errors.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScriptError } from "../../../command-internal/edge-runtime-script.errors.ts";
import {
  type EdgeRuntimeRunOpts,
  EdgeRuntimeScript,
} from "../../../command-internal/edge-runtime-script.service.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import {
  PgDeltaEngine,
  type PgDeltaDatabaseDiffInput,
  type PgDeltaExplicitDiffInput,
  type PgDeltaHazardReport,
} from "../shared/pgdelta-engine.service.ts";
import { RemovedSurfaceError } from "../../../command-internal/removed-command.ts";
import type { DbDiffFlags } from "./diff.command.ts";
import { dbDiff } from "./diff.handler.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import { StackApi } from "../../../command-internal/stack-api.ts";
import { StackNativeEngineError } from "../../../command-internal/stack-local-database.ts";
import { PGADMIN_DESKTOP_NOTE_PREFIX, PGADMIN_DIFF_HEADER } from "./pgadmin-diff.ts";

interface SetupOpts {
  readonly usePgDelta?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly format?: OutputFormat;
  readonly isLocal?: boolean;
  readonly linkedRef?: string;
  readonly diffSql?: string;
  // When set, the pg-delta strategy mock returns one rendered file per entry.
  readonly diffFiles?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  // Exact suffixes returned by the pg-delta renderer, parallel to `diffFiles`.
  readonly diffSuffixes?: ReadonlyArray<string | null>;
  readonly hazards?: PgDeltaHazardReport;
  readonly oom?: boolean; // edge-runtime OOMs; the bash fallback returns `diffSql`
  // Message for a failing PGDELTA_DEBUG shadow-catalog export.
  readonly diffFailWith?: string;
  // Makes the shadow's PG15+ baseline job(s) exit non-zero; the shadow should
  // still be removed.
  readonly failShadowSetupJob?: boolean;
  readonly networkId?: string; // --network-id value forwarded to docker runs
  // When set, the Nth `writeFileString` fails, exercising cleanup-on-failure.
  readonly failWriteOnCall?: number;
  // Fails the first `writeFileString` call whose path matches; prefer over
  // `failWriteOnCall` when shadow setup writes extra files first.
  readonly failWriteMatching?: (path: string) => boolean;
  // Makes the shadow container never report healthy; only the `--use-pgadmin` branch
  // gates on this (the shadow-source branch uses `neverConnectableShadow` instead).
  readonly neverHealthyShadow?: boolean;
  // Refuses every connect to the shadow's port, so `waitForShadowReady` keeps
  // polling — the shadow-source branch's equivalent of `neverHealthyShadow`.
  readonly neverConnectableShadow?: boolean;
  // `CommandSettings.projectId`; defaults to `Option.some("test")`. Pass
  // `Option.none()` to exercise the config.toml/workdir-basename fallback.
  readonly projectId?: Option.Option<string>;
  // Simulates an unlinked workdir: the project-ref resolver fails with
  // `ProjectRefNotLinkedError` absent an explicit `--remote=<ref>`.
  readonly linkedFails?: boolean;
  readonly resolveFailsWith?: DbConfigIpv6Error;
  // Per-differ-run `--json-diff` stdout, indexed by run order; falls back to `""`
  // once exhausted, so a single-run test only needs one element.
  readonly pgadminStdout?: ReadonlyArray<string>;
  // Per-differ-run stderr; falls back to `""` once exhausted.
  readonly pgadminStderr?: ReadonlyArray<string>;
  // Exit code applied to every differ `runCapture` call.
  readonly pgadminExitCode?: number;
  // Fails every differ `runCapture` call at the docker boundary: `"spawn"` (daemon
  // unreachable) or `"pull"` (registry failure).
  readonly pgadminDockerFail?: "spawn" | "pull";
  // Makes the pre-flight `isLocalDbRunning` probe report "container not found",
  // surfacing as "supabase start is not running.".
  readonly dbNotRunning?: boolean;
  // Makes the same probe fail with a daemon-unreachable stderr instead (mutually
  // exclusive with `dbNotRunning`).
  readonly dbInspectFailsWith?: string;
  // `RuntimeInfo.platform`; defaults to `"linux"`. Pass `"darwin"`/`"win32"` to
  // exercise the no-add-host branch (`--add-host` is Linux-only).
  readonly platform?: NodeJS.Platform;
  // Swaps in the stateful Docker model (real `stop`/`cp`/`start`), required by the
  // shadow baseline cache tests.
  readonly statefulDocker?: boolean;
  readonly dirs?: ReadonlyArray<string>;
  readonly files?: Readonly<Record<string, string>>;
  // Runs the real resolver and linked-project cache; `workdir` must be a real directory.
  readonly realLayers?: boolean;
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

const WrittenMigrations = Schema.Struct({
  file: Schema.String,
  files: Schema.Array(Schema.String),
});

/** `[db] shadow_port`'s schema default — the port every connect to the shadow itself dials. */
const SHADOW_PORT = 54320;

/**
 * Records every `DbConnection.connect` target's database name and every `exec`/`query` run
 * against it. `neverConnectableShadow` fails every connect to the shadow port, leaving local
 * connects untouched — this keeps a provisioning fiber suspended in `waitForShadowReady`'s
 * retry loop.
 */
function fakeShadowDbConnection(opts: { readonly neverConnectableShadow?: boolean } = {}) {
  const connectedDatabases: Array<string> = [];
  const execCalls: Array<string> = [];
  const shadowConnectRefused = Deferred.makeUnsafe<void>();
  const layer = Layer.succeed(DbConnection, {
    connect: (cfg: PgConnInput) =>
      Effect.gen(function* () {
        connectedDatabases.push(cfg.database);
        if (opts.neverConnectableShadow === true && cfg.port === SHADOW_PORT) {
          yield* Deferred.succeed(shadowConnectRefused, undefined);
          return yield* new DbConnectError({ message: "connection refused" });
        }
        const session: DbSession = {
          exec: (sql) =>
            Effect.sync(() => {
              execCalls.push(sql);
            }),
          query: () => Effect.succeed([]),
          execBatch: (statements) => sequentialExecBatch(session)(statements),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });
  return { layer, connectedDatabases, execCalls, shadowConnectRefused };
}

const STACK_SQL_PORT = 54329;

const runningStackApi = (projectRoot: string) => {
  const unused = Effect.die("unused by db diff");
  const database: DatabaseInstance = {
    id: "database-primary",
    service: "database",
    start: unused,
    ready: unused,
    stop: unused,
    restart: () => unused,
    destroy: unused,
    prepare: unused,
    status: Effect.succeed({
      id: "database-primary",
      endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: STACK_SQL_PORT }],
      config: {
        service: "database",
        config: {
          version: "17.6.1.173",
          databasePassword: Redacted.make("stack-password"),
          jwtSecret: Redacted.make("secret"),
          jwtExpiry: 3600,
        },
        endpoints: {},
      },
      lifecycle: "running",
      health: "healthy",
      error: undefined,
      exit: undefined,
      currentOperation: undefined,
      wakeEnabled: true,
    }),
    followStatus: Stream.empty,
    readLogs: () => Stream.empty,
    credentials: () => unused,
    saveSnapshot: () => unused,
    restoreSnapshot: () => unused,
    resetData: unused,
  };
  const stack: Stack = {
    id: "b".repeat(64),
    services: { create: () => unused, get: () => Effect.succeed(database), list: unused },
    credentials: { get: unused },
    composition: {
      plan: () => unused,
      describe: Effect.succeed({
        members: [{ id: database.id, activation: "eager" }],
        dependencies: [],
      }),
      supabase: () => unused,
      configure: () => unused,
      start: unused,
      stop: unused,
      restart: unused,
    },
    startupEndpointChanges: unused,
    stop: unused,
    destroy: unused,
    gateway: unusedGateway,
    commands: { run: () => unused },
  };
  return Layer.succeed(StackApi, {
    create: () => unused,
    open: () => Effect.succeed(stack),
    discover: () => unused,
    find: () =>
      Effect.succeed(
        Option.some({
          definition: {
            id: stack.id,
            identity: { projectRoot, branchContext: "main", stackName: "default" },
            runtime: "native" as const,
            instances: [],
            lifetime: "detached" as const,
            composition: { members: [], dependencies: [] },
          },
          host: undefined,
        }),
      ),
    findDeleted: () => unused,
  });
};

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  // A docker-spawner fake backs container lifecycle; a fake Postgres session backs
  // shadow setup.
  const shadowSpawner = mockShadowContainerCliSpawner({
    neverHealthy: opts.neverHealthyShadow ?? false,
    dbNotRunning: opts.dbNotRunning ?? false,
    dbInspectFailsWith: opts.dbInspectFailsWith,
  });
  const shadowHealthProbed = Deferred.makeUnsafe<void>();
  const shadowSpawnerLayer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (inner) =>
      ChildProcessSpawner.make((command) =>
        inner
          .spawn(command)
          .pipe(
            Effect.tap(() =>
              ChildProcess.isStandardCommand(command) &&
              command.args[0] === "container" &&
              command.args[1] === "inspect" &&
              command.args[2] === FAKE_SHADOW_CONTAINER_ID
                ? Deferred.succeed(shadowHealthProbed, undefined)
                : Effect.void,
            ),
          ),
      ),
    ),
  ).pipe(Layer.provide(shadowSpawner.layer));
  // Cache tests need the stateful Docker model since `docker cp` needs real container state.
  const dockerDaemon = opts.statefulDocker === true ? mockDockerDaemonCliSpawner() : undefined;
  const shadowDbConnection = fakeShadowDbConnection({
    neverConnectableShadow: opts.neverConnectableShadow ?? false,
  });

  const explicitDiffCalls: PgDeltaExplicitDiffInput[] = [];
  const databaseDiffCalls: PgDeltaDatabaseDiffInput[] = [];
  const pgDeltaResult = () => {
    const sql = opts.diffSql ?? "";
    const files =
      opts.diffFiles !== undefined
        ? opts.diffFiles.map((file, index) => ({
            sequence: index + 1,
            name: file.name,
            ...(opts.diffSuffixes?.[index] !== undefined
              ? { suffix: opts.diffSuffixes[index] }
              : {}),
            sql: file.sql,
            transactionMode: "transactional" as const,
          }))
        : sql.length > 0
          ? [
              {
                sequence: 1,
                name: "schema_changes",
                sql,
                transactionMode: "transactional" as const,
              },
            ]
          : [];
    return {
      changes: files.length > 0,
      sql: opts.diffFiles !== undefined ? files.map((file) => file.sql).join("\n\n") : sql,
      files,
      ...(opts.hazards !== undefined ? { hazards: opts.hazards } : {}),
    };
  };
  const pgDeltaEngine = Layer.succeed(
    PgDeltaEngine,
    PgDeltaEngine.of({
      diffExplicit: (input) =>
        Effect.sync(() => {
          explicitDiffCalls.push(input);
          return pgDeltaResult();
        }),
      diffDatabase: (input) =>
        Effect.sync(() => {
          databaseDiffCalls.push(input);
          return pgDeltaResult();
        }),
      exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema unused"),
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema unused"),
    }),
  );

  const edgeCalls: EdgeRuntimeRunOpts[] = [];
  const spawnedBeforeEdgeRun: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
  const edge = Layer.succeed(EdgeRuntimeScript, {
    run: (runOpts: EdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
      spawnedBeforeEdgeRun.push(shadowSpawner.spawned.map((call) => call.args));
      if (opts.oom) {
        return Effect.fail(
          new EdgeRuntimeScriptError({ message: "Fatal JavaScript out of memory" }),
        );
      }
      if (opts.diffFailWith !== undefined) {
        return Effect.fail(new EdgeRuntimeScriptError({ message: opts.diffFailWith }));
      }
      const diffSql = opts.diffSql ?? "";
      // The pg-delta script (identified by `renderPlanFiles`) prints a JSON envelope
      // with one file per plan unit; the migra script returns raw SQL unchanged.
      const isPgDelta = runOpts.script.includes("renderPlanFiles");
      const planFiles =
        opts.diffFiles !== undefined
          ? opts.diffFiles.map((file, i) => ({
              order: i + 1,
              name: file.name,
              transactionMode: "transactional",
              sql: file.sql,
            }))
          : diffSql.length > 0
            ? [{ order: 1, name: "schema_changes", transactionMode: "transactional", sql: diffSql }]
            : [];
      const stdout =
        isPgDelta && planFiles.length > 0
          ? JSON.stringify({ version: 1, files: planFiles })
          : diffSql;
      return Effect.succeed({ stdout, stderr: "" });
    },
  });

  // Tracks the migra OOM bash fallback's own `runCapture` calls; the native shadow's
  // PG15+ one-shot setup jobs go through `runStream` instead and are tracked
  // separately in `shadowSetupJobCalls`.
  const dockerCalls: Array<DockerRunOpts> = [];
  // The pgAdmin differ's own `runCapture` calls, distinguished from `dockerCalls`
  // by `image` (both share the same `DockerRun.runCapture` seam).
  const differCalls: Array<DockerRunOpts> = [];
  // The `runCapture` options argument for every differ call, parallel to
  // `differCalls`; stays `undefined` since the differ's stderr is never teed to
  // the parent terminal.
  const differCaptureOpts: Array<{ readonly teeStderr?: boolean } | undefined> = [];
  // Snapshots the project registry value at each differ `runCapture` call.
  const differRegistryEnvAtCall: Array<string | undefined> = [];
  const shadowSetupJobCalls: Array<{ readonly env: Readonly<Record<string, string>> }> = [];
  const docker = Layer.succeed(DockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: (dockerOpts, captureOpts) => {
      if (dockerOpts.image.includes("pgadmin-schema-diff")) {
        differCalls.push(dockerOpts);
        differCaptureOpts.push(captureOpts);
        differRegistryEnvAtCall.push(
          dockerOpts.projectEnvValues?.["SUPABASE_INTERNAL_IMAGE_REGISTRY"],
        );
        if (opts.pgadminDockerFail !== undefined) {
          return Effect.fail(
            new DockerRunError({
              message: "failed to run docker: not found",
              reason: opts.pgadminDockerFail,
              daemonDown: opts.pgadminDockerFail === "spawn",
            }),
          );
        }
        const i = differCalls.length - 1;
        return Effect.succeed({
          exitCode: opts.pgadminExitCode ?? 0,
          stdout: new TextEncoder().encode(opts.pgadminStdout?.[i] ?? ""),
          stderr: opts.pgadminStderr?.[i] ?? "",
        });
      }
      dockerCalls.push(dockerOpts);
      return Effect.succeed({
        exitCode: 0,
        stdout: new TextEncoder().encode(opts.diffSql ?? ""),
        stderr: "",
      });
    },
    // The shadow's own PG15+ one-shot platform-baseline job(s).
    runStream: (dockerOpts) => {
      shadowSetupJobCalls.push(dockerOpts);
      return Effect.succeed({
        exitCode: opts.failShadowSetupJob === true ? 1 : 0,
        stderr: "",
      });
    },
  });

  const resolverCalls: DbConnectionInput[] = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      resolverCalls.push(input);
      if (opts.resolveFailsWith !== undefined) return Effect.fail(opts.resolveFailsWith);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? input.target.kind === "local",
        ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const commandTarget = commandTargetLayer.pipe(Layer.provide(out.layer));
  const projectRefResolver = Layer.effect(
    ProjectRefResolver,
    Effect.gen(function* () {
      const target = yield* CommandTarget;
      return ProjectRefResolver.of({
        resolve: () => Effect.die("resolve is not used by this test"),
        resolveForLink: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
        resolveRef: (flagValue: Option.Option<string>) =>
          Effect.gen(function* () {
            const resolved =
              Option.isSome(flagValue) && flagValue.value.length > 0
                ? { ref: flagValue.value, source: "flag" as const, matchesLinkedRef: false }
                : opts.linkedFails === true
                  ? yield* new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE })
                  : {
                      ref: opts.linkedRef ?? VALID_REF,
                      source: "file" as const,
                      matchesLinkedRef: true,
                    };
            yield* target.announce(
              describeLinkedTarget({ ref: resolved.ref, cache: Option.none() }),
            );
            return resolved;
          }),
        resolveOptional: () => Effect.succeed(Option.some(opts.linkedRef ?? VALID_REF)),
        promptProjectRef: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
      });
    }),
  ).pipe(Layer.provide(commandTarget));

  const workdirFiles = Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const dir of opts.dirs ?? []) {
        yield* fs.makeDirectory(path.join(workdir, dir), { recursive: true });
      }
      for (const [file, content] of Object.entries(opts.files ?? {})) {
        yield* fs.makeDirectory(path.dirname(path.join(workdir, file)), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, file), content);
      }
    }),
  ).pipe(Layer.provide(BunServices.layer));

  const projectHttp = recordingProjectHttpClient(VALID_REF);
  const baseLayer = Layer.mergeAll(
    unusedStackServices,
    // Listed first so the fake service layers below (`Layer.mergeAll` is last-wins)
    // override its real implementations, matching `start.integration.test.ts`.
    BunServices.layer,
    out.layer,
    configValuesLayer({
      output: out.layer,
      flags:
        opts.usePgDelta === undefined
          ? []
          : [flagInput("experimental.pgdelta.enabled", "use-pg-delta", opts.usePgDelta)],
      env: opts.env,
    }),
    telemetry.layer,
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: projectHttp.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : cache.layer,
    pgDeltaEngine,
    edge,
    docker,
    shadowDbConnection.layer,
    dockerDaemon?.layer ?? shadowSpawnerLayer,
    mockLocalDockerEngineUnavailableLayer,
    alwaysReadyHttpClientLayer,
    opts.realLayers === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: shadowDbConnection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : resolver,
    projectRefResolver,
    commandTarget,
    mockCommandSettings({
      workdir,
      projectId: opts.projectId ?? Option.some("test"),
      ...(opts.realLayers === true ? { projectHost: "invalid" } : {}),
    }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(
      NetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(PgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    Layer.succeed(YesFlag, false),
    mockRuntimeInfo({ platform: opts.platform ?? "linux" }),
    workdirFiles,
    shadowCacheDisabledLayer,
  );
  // Merged last so its `FileSystem` overrides everything above (last-wins).
  const failWriteLayer =
    opts.failWriteMatching !== undefined
      ? failWriteStringMatchingFsLayer(opts.failWriteMatching)
      : opts.failWriteOnCall !== undefined
        ? failWriteStringOnNthCallFsLayer(opts.failWriteOnCall)
        : undefined;
  const layer = failWriteLayer === undefined ? baseLayer : Layer.merge(baseLayer, failWriteLayer);

  return {
    layer,
    out,
    cache,
    telemetry,
    explicitDiffCalls,
    databaseDiffCalls,
    edgeCalls,
    spawnedBeforeEdgeRun,
    resolverCalls,
    dockerCalls,
    differCalls,
    differCaptureOpts,
    differRegistryEnvAtCall,
    shadowSetupJobCalls,
    shadowSpawned: shadowSpawner.spawned,
    shadowHealthProbed,
    dockerDaemon,
    shadowConnectedDatabases: shadowDbConnection.connectedDatabases,
    shadowExecCalls: shadowDbConnection.execCalls,
    shadowConnectRefused: shadowDbConnection.shadowConnectRefused,
    projectHttp,
  };
}

const REMOTE_LINKED: DbDiffFlags["remote"] = Option.some({ _tag: "Linked" });

const flags = (over: Partial<DbDiffFlags> = {}): DbDiffFlags => ({
  useMigra: over.useMigra ?? Option.none(),
  usePgAdmin: over.usePgAdmin ?? Option.none(),
  usePgSchema: over.usePgSchema ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  strictCoverage: over.strictCoverage ?? false,
  from: over.from ?? Option.none(),
  to: over.to ?? Option.none(),
  output: over.output ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  file: over.file ?? Option.none(),
  schema: over.schema ?? [],
});

const stdout = (out: ReturnType<typeof mockOutput>) =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.text)
      .join(""),
  );
const stderr = (out: ReturnType<typeof mockOutput>) =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.text)
      .join(""),
  );

const targetLines = (out: ReturnType<typeof mockOutput>) =>
  stderr(out)
    .split("\n")
    .filter((line) => line.startsWith("Target: "));

const readFileText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(file));
  });

const tmp = useTempWorkdir();

/** `DiffEntry` shape, defaulting to a kept entry. */
function pgadminEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "table",
    status: "Different",
    diff_ddl: "ALTER TABLE test;",
    group_name: "public",
    ...overrides,
  };
}

/** `processPgAdminDiffOutput`'s exact output for a single default `pgadminEntry()`. */
const PGADMIN_DIFF_SQL = `${PGADMIN_DIFF_HEADER}\n\nALTER TABLE test;\n`;

// Matches `setup()`'s default resolver/shadow-port fixtures (conn 127.0.0.1:54322,
// shadow port 54320), as seen from the differ's project network.
const PGADMIN_SOURCE_URL =
  "postgresql://postgres:postgres@host.docker.internal:54322/postgres?connect_timeout=10";
const PGADMIN_TARGET_URL = "postgresql://postgres:postgres@host.docker.internal:54320/postgres";

describe("db diff", () => {
  it.effect(
    "diffs local with --use-migra over the pg-delta default and prints SQL to stdout",
    () => {
      const s = setup(tmp.current, { diffSql: "create table players ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ useMigra: Option.some(true) }));
        expect(s.edgeCalls).toHaveLength(1);
        expect(s.databaseDiffCalls).toEqual([]);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        expect(stdout(s.out)).toBe("create table players ();\n\n");
        expect(stderr(s.out)).toContain("Creating shadow database...");
        expect(stderr(s.out)).toContain("Diffing schemas...");
        // The temp workdir sits outside any git checkout, so the branch is unknown and
        // the "Finished" line omits the clause instead of falsely claiming "main".
        expect(stderr(s.out)).toContain("Finished supabase db diff.\n");
        expect(s.telemetry.flushed).toBe(true);
        const expectedHost = FAKE_SHADOW_CONTAINER_ID.slice(0, 12);
        expect(s.shadowSetupJobCalls.length).toBeGreaterThan(0);
        let sawHost = false;
        for (const call of s.shadowSetupJobCalls) {
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
      }).pipe(Effect.provide(s.layer), (body) => withEnvVar("GITHUB_HEAD_REF", undefined, body));
    },
  );

  it.effect("forwards SUPABASE_SSL_DEBUG=TRUE to the migra script as true", () => {
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ useMigra: Option.some(true) })).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            { SUPABASE_SSL_DEBUG: "TRUE", SUPABASE_SHADOW_CACHE: "0" },
            { preserveEmptyStrings: true },
          ),
        ),
      );
      expect(s.edgeCalls).toHaveLength(1);
      expect(s.edgeCalls[0]?.env["SUPABASE_SSL_DEBUG"]).toBe("true");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("omits SUPABASE_SSL_DEBUG from the migra script when it is set empty", () => {
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ useMigra: Option.some(true) })).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            { SUPABASE_SSL_DEBUG: "", SUPABASE_SHADOW_CACHE: "0" },
            { preserveEmptyStrings: true },
          ),
        ),
      );
      expect(s.edgeCalls).toHaveLength(1);
      expect(s.edgeCalls[0]?.env).not.toHaveProperty("SUPABASE_SSL_DEBUG");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates the labeled Deno-cache volume before the migra run mounts it", () => {
    const s = setup(tmp.current, {
      diffSql: "create table players ();\n",
      env: { SUPABASE_PROJECT_ID: "test" },
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ useMigra: Option.some(true) }));
      expect(s.edgeCalls[0]?.binds).toEqual(["supabase_edge_runtime_test:/root/.cache/deno:rw"]);
      expect(s.spawnedBeforeEdgeRun[0]).toContainEqual([
        "volume",
        "create",
        "--label",
        "com.supabase.cli.project=test",
        "--label",
        "com.docker.compose.project=test",
        "supabase_edge_runtime_test",
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("skips creating the Deno-cache volume under Bitbucket Pipelines", () => {
    const s = setup(tmp.current, {
      diffSql: "create table players ();\n",
      files: { "supabase/.env": "BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n" },
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ useMigra: Option.some(true) }));
      expect(s.edgeCalls).toHaveLength(1);
      expect(
        s.shadowSpawned.filter(
          (call) => call.args[0] === "volume" && call.args.includes("supabase_edge_runtime_test"),
        ),
      ).toEqual([]);
      expect(stdout(s.out)).toBe("create table players ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs local with pgdelta when --use-pg-delta is set", () => {
    const s = setup(tmp.current, { usePgDelta: true, diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(
        flags({ usePgDelta: Option.some(true), strictCoverage: true, schema: ["public"] }),
      );
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.databaseDiffCalls[0]).toMatchObject({
        source: {
          kind: "database",
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
        schema: ["public"],
        strictCoverage: true,
        target: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
      });
      expect(s.edgeCalls).toEqual([]);
      expect(stderr(s.out)).toContain("Diffing schemas: public");
      expect(stdout(s.out)).toBe("create table p ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect.each([
    { value: "1", debug: true },
    { value: "", debug: false },
  ])('passes PGDELTA_DEBUG="$value" to both pg-delta diff modes', ({ value, debug }) => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true) }));
      yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("local") }));
      expect(s.databaseDiffCalls.map((call) => call.debug)).toEqual([debug]);
      expect(s.explicitDiffCalls.map((call) => call.debug)).toEqual([debug]);
    }).pipe(Effect.provide(s.layer), (body) => withConfigEnv({ PGDELTA_DEBUG: value }, body));
  });

  it.effect("diffs local with pg-delta when no [experimental.pgdelta] config is present", () => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.edgeCalls).toEqual([]);
      expect(stdout(s.out)).toBe("create table p ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("keeps the pg-delta default with --use-migra=false", () => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ useMigra: Option.some(false) }));
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs local with migra when [experimental.pgdelta] enabled = false", () => {
    const s = setup(tmp.current, {
      files: { "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n" },
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(s.edgeCalls).toHaveLength(1);
      expect(s.databaseDiffCalls).toEqual([]);
      expect(stdout(s.out)).toBe("create table m ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pg-delta overrides [experimental.pgdelta] enabled = false", () => {
    const s = setup(tmp.current, {
      usePgDelta: true,
      files: { "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n" },
      diffSql: "create table p ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explains ignored declarative files when a default local diff finds no changes", () => {
    const s = setup(tmp.current, {
      files: { "supabase/schemas/public.sql": "create table declared ();\n" },
      diffSql: "",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ file: Option.some("declared") }));
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(stderr(s.out)).toContain("No schema changes found");
      expect(stderr(s.out)).toContain("declarative schema files in supabase/schemas are not read");
      expect(stderr(s.out)).toContain("Run supabase db schema declarative sync to generate");
      expect(stderr(s.out)).toContain("or pass --use-migra to diff them with migra");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("keeps a local diff without -f quiet while reporting the declarative advisory", () => {
    const s = setup(tmp.current, {
      files: { "supabase/schemas/public.sql": "create table declared ();\n" },
      format: "json",
      diffSql: "",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stderr(s.out)).not.toContain("are not read");
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).toHaveProperty("advisories");
    }).pipe(Effect.provide(s.layer));
  });

  const ignoredDeclarativeNote = (config: string, file: string) =>
    Effect.gen(function* () {
      const s = setup(tmp.current, {
        usePgDelta: true,
        files: { "supabase/config.toml": config, [file]: "create table declared ();\n" },
        diffSql: "",
      });
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("declared") })).pipe(
        Effect.provide(s.layer),
      );
      return stderr(s.out);
    });

  it.effect("suggests --use-migra for supabase/schemas even when config disables pg-delta", () =>
    Effect.gen(function* () {
      const err = yield* ignoredDeclarativeNote(
        "[experimental.pgdelta]\nenabled = false\n",
        "supabase/schemas/public.sql",
      );
      expect(err).toContain("declarative schema files in supabase/schemas are not read");
      expect(err).toContain("Run supabase db schema declarative sync --experimental to generate");
      expect(err).toContain("or pass --use-migra to diff them with migra");
    }),
  );

  it.effect("reads a string-typed [experimental.pgdelta] enabled in the declarative advisory", () =>
    Effect.gen(function* () {
      const err = yield* ignoredDeclarativeNote(
        '[experimental.pgdelta]\nenabled = "false"\n',
        "supabase/schemas/public.sql",
      );
      expect(err).toContain("Run supabase db schema declarative sync --experimental to generate");
      expect(err).toContain("or pass --use-migra to diff them with migra");
    }),
  );

  it.effect("keeps the diff successful when the advisory cannot read the config file value", () =>
    Effect.gen(function* () {
      const s = setup(tmp.current, {
        usePgDelta: true,
        files: {
          "supabase/config.toml": '[db.seed]\nenabled = "banana"\n',
          "supabase/.env": "SUPABASE_DB_SEED_ENABLED=true\n",
          "supabase/schemas/public.sql": "create table declared ();\n",
        },
        diffSql: "",
      });

      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("declared") })).pipe(
        Effect.provide(s.layer),
      );

      expect(stderr(s.out)).toContain("declarative schema files in supabase/schemas are not read");
    }),
  );

  it.effect(
    "suggests --use-migra for an absolute path to supabase/schemas with pg-delta disabled",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const absoluteSchemas = path.join(tmp.current, "supabase", "schemas");
        const err = yield* ignoredDeclarativeNote(
          `[experimental.pgdelta]\nenabled = false\ndeclarative_schema_path = '${absoluteSchemas}'\n`,
          "supabase/schemas/public.sql",
        );
        expect(err).toContain("the configured declarative schema directory are not read");
        expect(err).toContain("or pass --use-migra to diff them with migra");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("omits the migra suggestion for a custom dir migra would not read", () =>
    Effect.gen(function* () {
      const err = yield* ignoredDeclarativeNote(
        '[experimental.pgdelta]\nenabled = false\ndeclarative_schema_path = "./decl"\n',
        "supabase/decl/public.sql",
      );
      expect(err).toContain("declarative schema files in supabase/decl are not read");
      expect(err).toContain("Run supabase db schema declarative sync --experimental to generate");
      expect(err).not.toContain("or pass --use-migra");
    }),
  );

  it.effect("omits the migra suggestion when schema_paths selects other files", () =>
    Effect.gen(function* () {
      const err = yield* ignoredDeclarativeNote(
        '[db.migrations]\nschema_paths = ["other.sql"]\n',
        "supabase/schemas/public.sql",
      );
      expect(err).toContain("declarative schema files in supabase/schemas are not read");
      expect(err).not.toContain("or pass --use-migra");
    }),
  );

  it.effect("does not explain declarative files on a linked diff without -f", () => {
    const s = setup(tmp.current, {
      files: { "supabase/schemas/public.sql": "create table declared ();\n" },
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ remote: REMOTE_LINKED }));
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(stderr(s.out)).not.toContain("are not read");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pg-delta local diff ignores schema_paths and declarative files", () => {
    const s = setup(tmp.current, {
      usePgDelta: true,
      files: {
        "supabase/config.toml": [
          "[db.migrations]",
          'schema_paths = ["configured.sql"]',
          "",
          "[experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
        "supabase/configured.sql": "create table configured ();\n",
        "supabase/schemas/ignored.sql": "create table ignored ();\n",
      },
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(s.databaseDiffCalls[0]).not.toHaveProperty("declarativeFiles");
      expect(s.databaseDiffCalls[0]).not.toHaveProperty("declarativeManifest");
      expect(s.shadowConnectedDatabases).not.toContain("contrib_regression");
      expect(s.databaseDiffCalls[0]?.target.ref).toContain("@127.0.0.1:54322/postgres");
      expect(s.databaseDiffCalls[0]?.target).toMatchObject({
        connection: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        connectOptions: { isLocal: true, dnsResolver: "native" },
      });
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
      expect(stderr(s.out)).toContain("declarative sync` reads declarative_schema_path");
      expect(stderr(s.out)).toContain("still reads schema_paths, and only for local targets");
      expect(stderr(s.out)).not.toContain("are not read");
      expect(stdout(s.out)).toBe("create table result ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  // Migra still routes declarative files through the `contrib_regression` override,
  // so schema_paths still shapes its output — only pg-delta prints this warning.
  const writeSchemaPathsConfig = (pgDeltaEnabled: boolean) => ({
    dirs: ["supabase/database"],
    files: {
      "supabase/config.toml": [
        "[db.migrations]",
        'schema_paths = ["configured.sql"]',
        "",
        "[experimental.pgdelta]",
        `enabled = ${pgDeltaEnabled}`,
        "",
      ].join("\n"),
      "supabase/configured.sql": "create table configured ();\n",
    },
  });

  it.effect("migra local diff does not print the schema_paths transition warning", () => {
    const s = setup(tmp.current, {
      ...writeSchemaPathsConfig(false),
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stderr(s.out)).not.toContain("schema_paths no longer changes the migrations baseline");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pg-delta=false beats [experimental.pgdelta] enabled in config", () => {
    const s = setup(tmp.current, {
      ...writeSchemaPathsConfig(true),
      usePgDelta: false,
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(false) }));
      expect(s.databaseDiffCalls).toEqual([]);
      expect(s.edgeCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--use-pg-delta=false beats SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED and config together",
    () => {
      const s = setup(tmp.current, {
        ...writeSchemaPathsConfig(true),
        usePgDelta: false,
        env: { SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "true" },
        diffSql: "create table result ();\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgDelta: Option.some(false) }));
        expect(s.databaseDiffCalls).toEqual([]);
        expect(s.edgeCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED beats [experimental.pgdelta] enabled in config",
    () => {
      const s = setup(tmp.current, {
        ...writeSchemaPathsConfig(true),
        env: { SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false" },
        diffSql: "create table result ();\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags());
        expect(s.databaseDiffCalls).toEqual([]);
        expect(s.edgeCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false selects migra without a pgdelta section",
    () => {
      const s = setup(tmp.current, {
        env: { SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false" },
        diffSql: "create table result ();\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags());
        expect(s.databaseDiffCalls).toEqual([]);
        expect(s.edgeCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("ignores SUPABASE_EXPERIMENTAL_PG_DELTA, so the pg-delta default stays on", () => {
    const s = setup(tmp.current, {
      env: { SUPABASE_EXPERIMENTAL_PG_DELTA: "false" },
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "rejects an unparseable SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED instead of ignoring it",
    () => {
      const s = setup(tmp.current, {
        env: { SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "banana" },
        diffSql: "create table result ();\n",
      });
      return Effect.gen(function* () {
        const exit = yield* dbDiff(flags()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.databaseDiffCalls).toEqual([]);
        expect(s.edgeCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("PG14: provisions a shadow via the SQL-exec init path (no PG15+ one-shot jobs)", () => {
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": "[db]\nmajor_version = 14\n",
      },
      diffSql: "create table pg14 ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stdout(s.out)).toBe("create table pg14 ();\n\n");
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      expect(s.dockerCalls).toEqual([]);
      expect(s.shadowExecCalls.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "removes the shadow even when its own platform-baseline setup fails midway (ok-sentinel cleanup)",
    () => {
      const s = setup(tmp.current, { diffSql: "create table x ();\n", failShadowSetupJob: true });
      return Effect.gen(function* () {
        const exit = yield* dbDiff(flags()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );
  it.effect("a linked [remotes.<ref>] block enabling pg-delta selects the pg-delta engine", () => {
    // Base config disables pg-delta; the remote override enables it.
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": [
          "[experimental.pgdelta]",
          "enabled = false",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
      },
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ remote: REMOTE_LINKED }));
      expect(s.databaseDiffCalls[0]?.target.connectOptions.isLocal).toBe(false);
      expect(s.databaseDiffCalls[0]?.source.connectOptions.isLocal).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a linked [remotes.<ref>] db.major_version override reaches the shadow's OWN container spec, not just cfg",
    () => {
      // The remote's own container spec must reflect the `[remotes.<ref>]` override too, not
      // just the config read for pg-delta/schema_paths; `major_version` is used as a probe
      // since PG <= 14 is the only branch that emits `--tmpfs` on `docker create`.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": [
            "[db]",
            "major_version = 17",
            "",
            "[remotes.staging]",
            'project_id = "abcdefghijklmnopqrst"',
            "",
            "[remotes.staging.db]",
            "major_version = 14",
            "",
          ].join("\n"),
        },
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "alter table x;\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ remote: REMOTE_LINKED }));
        const createArgs = s.shadowSpawned.find((c) => c.args[0] === "create")?.args ?? [];
        expect(createArgs).toContain("--tmpfs");
        expect(s.dockerCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("suggests sync --experimental when a remote block overrides the base gate", () => {
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": [
          "[experimental.pgdelta]",
          "enabled = false",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
        "supabase/schemas/public.sql": "create table declared ();\n",
      },
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ remote: REMOTE_LINKED, file: Option.some("declared") }));
      expect(stderr(s.out)).toContain(
        "Run supabase db schema declarative sync --experimental to generate",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("the base config (default local target) does not merge a remote block", () => {
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": [
          "[experimental.pgdelta]",
          "enabled = false",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
      },
      diffSql: "create table players ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(s.edgeCalls[0]?.script).not.toContain("renderPlanFiles");
    }).pipe(Effect.provide(s.layer));
  });

  describeDbTargetSelection("db diff", {
    dbUrl: true,
    workdir: () => tmp.current,
    attempt: ({ workdir, target }) => {
      const s = setup(workdir, { projectId: Option.some(VALID_REF), diffSql: "alter table x;\n" });
      const branchApi = branchListApi();
      return {
        layer: Layer.merge(s.layer, branchApi.layer),
        out: s.out,
        run: dbDiff(flags({ ...target })),
        target: () => s.resolverCalls[0]?.target,
        cachedRef: () => s.cache.cachedRef,
        branchLookups: () => branchApi.requests,
        apiRequests: () => branchApi.requests,
      };
    },
  });

  describe("explicit --from and --to values", () => {
    const FLAG_PROJECT_REF = "flagflagflagflagflag";
    const DB_URL = "postgresql://postgres:pw@db.example.com/db";
    const CREDENTIALED_URL = "postgresql://u:secret@db.example.com:6543/postgres";
    const LOCAL_LINE = "Target: local stack (127.0.0.1:54322)";
    const PROJECT_LINE = `Target: project ${VALID_REF}`;
    const DB_URL_LINE = "Target: custom Postgres (db.example.com:6543)";

    const sides = (["from", "to"] as const).flatMap((side) =>
      [
        {
          value: "remote",
          expected: { kind: "linked", source: "file" },
          warning: undefined,
        },
        {
          value: FLAG_PROJECT_REF,
          expected: { kind: "linked", ref: FLAG_PROJECT_REF, source: "flag" },
          warning: undefined,
        },
        {
          value: "feature-x",
          expected: { kind: "linked", ref: BRANCH_PROJECT_REF, source: "flag" },
          warning: undefined,
        },
        {
          value: "linked",
          expected: { kind: "linked", source: "file" },
          warning: `--${side} linked is deprecated and will be removed in v4. Use --${side}=remote instead`,
        },
      ].map((row) => ({ side, ...row })),
    );

    it.effect.each(sides)(
      "--$side $value resolves the hosted project it names",
      ({ side, value, expected, warning }) => {
        const s = setup(tmp.current, {
          isLocal: false,
          projectId: Option.some(VALID_REF),
          diffSql: "create table e ();\n",
        });
        const other = side === "from" ? "to" : "from";
        return Effect.gen(function* () {
          yield* dbDiff(
            flags({
              [side]: Option.some(value),
              [other]: Option.some("migrations"),
            }),
          ).pipe(Effect.provide(Layer.merge(s.layer, branchListApi().layer)));
          expect(s.resolverCalls.map((call) => call.target)).toEqual([
            expect.objectContaining(expected),
          ]);
          expect(warningsOf(s.out)).toEqual(warning === undefined ? [] : [warning]);
        });
      },
    );

    it.effect.each(
      (["from", "to"] as const).map((side) => ({
        side,
        other: side === "from" ? "to" : "from",
      })),
    )(
      "--$side <db-url> diffs the database it names without minting a connection",
      ({ side, other }) => {
        const s = setup(tmp.current, { diffSql: "create table u ();\n" });
        return Effect.gen(function* () {
          yield* dbDiff(
            flags({ [side]: Option.some(DB_URL), [other]: Option.some("migrations") }),
          ).pipe(Effect.provide(s.layer));
          const endpoint =
            side === "from" ? s.explicitDiffCalls[0]?.source : s.explicitDiffCalls[0]?.desired;
          expect(endpoint).toEqual({
            kind: "database",
            ref: DB_URL,
            connection: expect.objectContaining({
              host: "db.example.com",
              user: "postgres",
              password: "pw",
              database: "db",
            }),
            connectOptions: { isLocal: false, dnsResolver: "native" },
          });
          expect(s.resolverCalls).toEqual([]);
        });
      },
    );

    it.effect.each([
      {
        label: "--from <db-url> --to remote",
        from: CREDENTIALED_URL,
        to: "remote",
        lines: [DB_URL_LINE, PROJECT_LINE],
        first: { kind: "db-url", host: "db.example.com", port: 6543 },
      },
      {
        label: "--from remote --to <db-url>",
        from: "remote",
        to: CREDENTIALED_URL,
        lines: [PROJECT_LINE, DB_URL_LINE],
        first: { kind: "linked", project_ref: VALID_REF, environment: "unverified" },
      },
      {
        label: "--from local --to remote",
        from: "local",
        to: "remote",
        lines: [LOCAL_LINE, PROJECT_LINE],
        first: { kind: "local", host: "127.0.0.1", port: 54322 },
      },
      {
        label: "--from local --to <db-url>",
        from: "local",
        to: CREDENTIALED_URL,
        lines: [LOCAL_LINE, DB_URL_LINE],
        first: { kind: "local", host: "127.0.0.1", port: 54322 },
      },
    ])("$label announces each database in resolution order, without credentials", (row) => {
      const s = setup(tmp.current, { isLocal: false, diffSql: "create table o ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ from: Option.some(row.from), to: Option.some(row.to) }));
        expect(targetLines(s.out)).toEqual(row.lines);
        expect(yield* CommandTarget.use((cell) => cell.json)).toEqual(Option.some(row.first));
        expect(`${s.out.stdoutText}${s.out.stderrText}`).not.toContain("secret");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect.each([
      { label: "--from local --to local", value: "local", line: LOCAL_LINE },
      {
        label: "--from <db-url> --to <the same db-url>",
        value: CREDENTIALED_URL,
        line: DB_URL_LINE,
      },
    ])("$label announces the database once", ({ value, line }) => {
      const s = setup(tmp.current, { diffSql: "create table o ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ from: Option.some(value), to: Option.some(value) }));
        expect(targetLines(s.out)).toEqual([line]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("--from local on the stack backend announces the stack's database", () => {
      const s = setup(tmp.current, { diffSql: "create table k ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("migrations") }));
        expect(targetLines(s.out)).toEqual([`Target: local stack (127.0.0.1:${STACK_SQL_PORT})`]);
        expect(yield* CommandTarget.use((cell) => cell.json)).toEqual(
          Option.some({ kind: "local", host: "127.0.0.1", port: STACK_SQL_PORT }),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(s.layer, stackBackendLayer("stack"), runningStackApi(tmp.current)),
        ),
      );
    });

    it.effect("--from <malformed db-url> fails before the hosted side resolves, unechoed", () => {
      const s = setup(tmp.current, { isLocal: false });
      return Effect.gen(function* () {
        const exit = yield* dbDiff(
          flags({
            from: Option.some(`${CREDENTIALED_URL}?sslmode=bogus`),
            to: Option.some("remote"),
          }),
        ).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "PgDeltaEngineError",
            message: "failed to parse Postgres connection string for pg-delta",
          });
          expect(Cause.pretty(exit.cause)).not.toContain("secret");
        }
        expect(`${s.out.stdoutText}${s.out.stderrText}`).not.toContain("secret");
        expect(targetLines(s.out)).toEqual([]);
        expect(s.resolverCalls).toEqual([]);
        expect(s.explicitDiffCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("--from local --to migrations reaches no hosted project", () => {
      const s = setup(tmp.current, { diffSql: "create table l ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("migrations") })).pipe(
          Effect.provide(s.layer),
        );
        expect(s.explicitDiffCalls[0]?.source).toMatchObject({ kind: "database" });
        expect(s.explicitDiffCalls[0]?.desired).toEqual({ kind: "migrations" });
        expect(s.resolverCalls).toEqual([]);
        expect(warningsOf(s.out)).toEqual([]);
      });
    });

    it.effect.each(
      (["from", "to"] as const).map((side) => ({
        side,
        other: side === "from" ? "to" : "from",
      })),
    )(
      "--$side <keyword dsn> is rejected without echoing the connection string",
      ({ side, other }) => {
        const branchApi = branchListApi();
        const s = setup(tmp.current, {
          isLocal: false,
          projectId: Option.some(VALID_REF),
          diffSql: "create table e ();\n",
        });
        return Effect.gen(function* () {
          const exit = yield* dbDiff(
            flags({ [side]: Option.some("host=h password=x"), [other]: Option.some("migrations") }),
          ).pipe(Effect.provide(Layer.merge(s.layer, branchApi.layer)), Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause);
            expect(error).toMatchObject({
              _tag: "DbDiffExplicitFlagsError",
              message: expect.stringContaining(`pass --${side}=<url>`),
            });
            expect(Cause.pretty(exit.cause)).not.toContain("password=x");
          }
          expect(`${s.out.stdoutText}${s.out.stderrText}`).not.toContain("password=x");
          expect(branchApi.requests).toEqual([]);
          expect(s.resolverCalls).toEqual([]);
        });
      },
    );

    it.effect.each([
      {
        value: "https://u:p@db.example.com/x",
        message:
          "--from takes local, migrations, remote, a project ref, a branch name or a postgresql:// URL.",
      },
      {
        value: "https://flagflagflagflagflag.supabase.co",
        message:
          "--from takes local, migrations, remote, a project ref, a branch name or a postgresql:// URL; to target that project, use --from=flagflagflagflagflag.",
      },
    ])(
      "--from $value is rejected as a non-postgres URL without echoing it",
      ({ value, message }) => {
        const branchApi = branchListApi();
        const s = setup(tmp.current, {
          isLocal: false,
          projectId: Option.some(VALID_REF),
          diffSql: "create table e ();\n",
        });
        return Effect.gen(function* () {
          const exit = yield* dbDiff(
            flags({ from: Option.some(value), to: Option.some("migrations") }),
          ).pipe(Effect.provide(Layer.merge(s.layer, branchApi.layer)), Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toMatchObject({
              _tag: "DbDiffExplicitFlagsError",
              message,
            });
            expect(Cause.pretty(exit.cause)).not.toContain("u:p");
          }
          expect(`${s.out.stdoutText}${s.out.stderrText}`).not.toContain("u:p");
          expect(branchApi.requests).toEqual([]);
          expect(s.resolverCalls).toEqual([]);
        });
      },
    );

    it.effect("--from <branch> asks the linked project's branch list", () => {
      const branchApi = branchListApi();
      const s = setup(tmp.current, {
        isLocal: false,
        projectId: Option.some(VALID_REF),
        diffSql: "create table e ();\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({ from: Option.some("feature-x"), to: Option.some("migrations") }),
        ).pipe(Effect.provide(Layer.merge(s.layer, branchApi.layer)));
        assertPermissionDrift({
          command: "db diff",
          activeFlags: { from: "feature-x", to: "migrations" },
          requests: branchApi.requests,
        });
      });
    });

    describe("a --from/--to value that reads as a branch name no branch matches", () => {
      const accepted = (flag: string) =>
        `${flag} accepts local, migrations, remote, a project ref, a branch of the linked project, or a postgresql:// URL.`;
      const failWith = (
        value: string,
        side: "from" | "to",
        opts: { readonly linked: boolean; readonly branch?: string },
      ) => {
        const branchApi = branchListApi(opts.branch);
        const s = setup(tmp.current, {
          isLocal: false,
          projectId: opts.linked ? Option.some(VALID_REF) : Option.none(),
          diffSql: "create table e ();\n",
        });
        const other = side === "from" ? "to" : "from";
        return dbDiff(
          flags({ [side]: Option.some(value), [other]: Option.some("migrations") }),
        ).pipe(Effect.provide(Layer.merge(s.layer, branchApi.layer)), Effect.flip);
      };

      it.effect.each([
        { side: "from", value: "lcoal", keyword: "local" },
        { side: "to", value: "lcoal", keyword: "local" },
        { side: "from", value: "migraitons", keyword: "migrations" },
        { side: "to", value: "remtoe", keyword: "remote" },
        { side: "from", value: "Locall", keyword: "local" },
      ] as const)(
        "--$side $value suggests --$side=$keyword before listing what it accepts",
        ({ side, value, keyword }) =>
          Effect.gen(function* () {
            const error = yield* failWith(value, side, { linked: true });
            expect(error).toMatchObject({
              _tag: "LinkBranchNotFoundError",
              suggestion: `Did you mean --${side}=${keyword}? ${accepted(`--${side}`)}`,
            });
          }),
      );

      it.effect("lists what --from accepts when the value is not near a keyword", () =>
        Effect.gen(function* () {
          const error = yield* failWith("feature-y", "from", { linked: true });
          expect(error).toMatchObject({
            _tag: "LinkBranchNotFoundError",
            suggestion: accepted("--from"),
          });
        }),
      );

      it.effect("adds the same suggestion when no project is linked to look the branch up in", () =>
        Effect.gen(function* () {
          const error = yield* failWith("lcoal", "to", { linked: false });
          expect(error).toMatchObject({
            _tag: "LinkBranchNotLinkedError",
            suggestion: `Did you mean --to=local? ${accepted("--to")}`,
          });
        }),
      );

      it.effect("still resolves a real branch whose name is near a keyword", () => {
        const s = setup(tmp.current, {
          isLocal: false,
          projectId: Option.some(VALID_REF),
          diffSql: "create table e ();\n",
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ from: Option.some("locale"), to: Option.some("migrations") })).pipe(
            Effect.provide(Layer.merge(s.layer, branchListApi("locale").layer)),
          );
          expect(s.resolverCalls.map((call) => call.target)).toEqual([
            expect.objectContaining({ kind: "linked", ref: BRANCH_PROJECT_REF, source: "flag" }),
          ]);
        });
      });
    });

    describe("when the project's database is unreachable over IPv6 and has no pooler URL", () => {
      const message = "IPv6 is not supported on your current network";

      it.effect(
        "suggests the pooler URL as --from/--to for a project other than the linked one",
        () => {
          const s = setup(tmp.current, {
            isLocal: false,
            resolveFailsWith: new DbConfigIpv6Error({
              message,
              remedy: "pooler-url",
              suggestion:
                "Pass the project's connection pooler URL with --remote=<pooler db-url> to connect over IPv4.",
            }),
          });
          return Effect.gen(function* () {
            const error = yield* dbDiff(
              flags({ from: Option.some(FLAG_PROJECT_REF), to: Option.some("migrations") }),
            ).pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: "DbConfigIpv6Error",
              message,
              suggestion:
                "Pass the project's connection pooler URL as --from=<url> or --to=<url> to connect over IPv4.",
            });
            expect(error).toMatchObject({ suggestion: expect.not.stringContaining("--remote") });
            expect(s.explicitDiffCalls).toEqual([]);
          }).pipe(Effect.provide(Layer.merge(s.layer, branchListApi().layer)));
        },
      );

      it.effect("keeps the link suggestion for the linked project", () => {
        const suggestion = `Run supabase link --project-ref ${VALID_REF} to setup IPv4 connection.`;
        const s = setup(tmp.current, {
          isLocal: false,
          projectId: Option.some(VALID_REF),
          resolveFailsWith: new DbConfigIpv6Error({ message, remedy: "link", suggestion }),
        });
        return Effect.gen(function* () {
          const error = yield* dbDiff(
            flags({ from: Option.some("remote"), to: Option.some("migrations") }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DbConfigIpv6Error",
            message,
            remedy: "link",
            suggestion,
          });
          expect(s.explicitDiffCalls).toEqual([]);
        }).pipe(Effect.provide(Layer.merge(s.layer, branchListApi().layer)));
      });
    });
  });

  it.effect(
    "explicit --from <ref> --to migrations applies the ref's remote override and caches the ref",
    () => {
      // `[remotes.staging]`'s `project_id` matches the `--from` ref, not `opts.linkedRef`
      // (left unset), so the override only applies if the ref's own project resolved it.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": [
            "[db]",
            "major_version = 17",
            "",
            "[remotes.staging]",
            `project_id = "flagflagflagflagflag"`,
            "",
            "[remotes.staging.db]",
            "major_version = 14",
            "",
          ].join("\n"),
        },
        isLocal: false,
        diffSql: "create table m ();\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({ from: Option.some("flagflagflagflagflag"), to: Option.some("migrations") }),
        );
        expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(14);
        expect(s.explicitDiffCalls[0]?.desired).toEqual({
          kind: "migrations",
          projectRef: "flagflagflagflagflag",
        });
        expect(s.cache.cachedRef).toBe("flagflagflagflagflag");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // `db.migrations.enabled = "notabool"` fails config-load after the ref is
      // already cached.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": ["[db.migrations]", 'enabled = "notabool"', ""].join("\n"),
        },
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "alter table x;\n",
      });
      return Effect.gen(function* () {
        const exit = yield* dbDiff(flags({ remote: REMOTE_LINKED })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "migra provisions a local-target declarative shadow and diffs against the override database",
    () => {
      // A declarative schema file makes `loadDeclaredSchemas` non-empty, redirecting
      // the diff target to a second (contrib_regression) database on the same shadow
      // container.
      const s = setup(tmp.current, {
        files: {
          "supabase/schemas/public.sql": "select 1;\n",
        },
        diffSql: "create table o ();\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ useMigra: Option.some(true) }));
        expect(stdout(s.out)).toBe("create table o ();\n\n");
        expect(s.shadowConnectedDatabases).toContain("contrib_regression");
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("diffs with the native pgAdmin engine: shadow create/rm, one differ run", () => {
    const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      expect(s.differCalls).toHaveLength(1);
      // Status lines go to stdout, not stderr.
      expect(stdout(s.out)).toBe(
        `Creating shadow database...\nDiffing local database with current migrations...\n${PGADMIN_DIFF_SQL}\n`,
      );
      // Stderr carries the shared shadow-setup diagnostics but not pgAdmin's own status
      // lines (those are on stdout) or the migra/pg-delta-only status lines.
      const err = stderr(s.out);
      expect(err).not.toContain("Creating shadow database...");
      expect(err).not.toContain("Diffing local database with current migrations...");
      expect(err).not.toContain("Diffing schemas");
      expect(err).not.toContain("Finished");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "rejects --use-pg-schema with a removal error before any engine-conflict or shadow work",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const error = yield* dbDiff(flags({ usePgSchema: Option.some(true) })).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RemovedSurfaceError);
        expect(s.shadowSpawned).toEqual([]);
        expect(s.resolverCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("rejects --use-pg-schema=false the same as an explicit true value", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* dbDiff(flags({ usePgSchema: Option.some(false) })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(RemovedSurfaceError);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "rejects --use-pg-schema combined with --use-pgadmin before the engine-conflict check",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const error = yield* dbDiff(
          flags({ usePgSchema: Option.some(true), usePgAdmin: Option.some(true) }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RemovedSurfaceError);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--use-pgadmin --remote honors --remote=<ref> like the other native engines", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      pgadminStdout: [JSON.stringify([pgadminEntry()])],
    });
    return Effect.gen(function* () {
      yield* dbDiff(
        flags({
          usePgAdmin: Option.some(true),
          remote: Option.some({ _tag: "Ref", ref: FLAG_REF } as const),
        }),
      );
      expect(s.differCalls).toHaveLength(1);
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--use-pgadmin --remote succeeds when only the [remotes.<ref>] override fixes an invalid base config",
    () => {
      // pgadmin shares the same target resolve as migra/pg-delta, so it validates the
      // remote-merged config and succeeds.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": [
            "[db]",
            "major_version = 16",
            "",
            "[remotes.staging]",
            'project_id = "abcdefghijklmnopqrst"',
            "",
            "[remotes.staging.db]",
            "major_version = 15",
            "",
          ].join("\n"),
        },
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), remote: REMOTE_LINKED }));
        expect(stderr(s.out)).toContain("Loading config override: [remotes.staging]");
        expect(s.differCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pgadmin --remote's preflight probe targets the resolved LINKED project id, not the base config's",
    () => {
      // The preflight probe's project id comes from the config after the linked
      // remote merge, not the base config's own `project_id`.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": [
            'project_id = "test"',
            "",
            "[remotes.staging]",
            'project_id = "abcdefghijklmnopqrst"',
            "",
          ].join("\n"),
        },
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), remote: REMOTE_LINKED }));
        // `mockShadowContainerCliSpawner` distinguishes this preflight probe from the
        // shadow's own health-check inspect by the `supabase_db_` container-name prefix.
        const inspectTargets = s.shadowSpawned
          .filter((c) => c.args[0] === "container" && c.args[1] === "inspect")
          .map((c) => c.args[2]);
        expect(inspectTargets).toContain("supabase_db_abcdefghijklmnopqrst");
        expect(inspectTargets).not.toContain("supabase_db_test");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pgadmin fails on an invalid base config when no [remotes.<ref>] override exists (parity with the native local path)",
    () => {
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": "[db]\nmajor_version = 16\n",
        },
      });
      return Effect.gen(function* () {
        const exit = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.resolverCalls).toHaveLength(0);
        expect(s.differCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a native local diff still validates the base config", () => {
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": "[db]\nmajor_version = 16\n",
      },
      diffSql: "create table x ();\n",
    });
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "validates the shadow's own local config (api.tls cert file) BEFORE resolving the connection",
    () => {
      // `api.tls`'s cert/key files are only validated by `buildLocalDbContainerInputs`,
      // which must run strictly before `resolver.resolve()` — `resolverCalls` staying
      // empty here proves validation ran first, not just that the command failed.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": [
            "[api]",
            "enabled = true",
            "[api.tls]",
            "enabled = true",
            'cert_path = "missing-cert.pem"',
            'key_path = "missing-key.pem"',
            "",
          ].join("\n"),
        },
        diffSql: "create table x ();\n",
      });
      return Effect.gen(function* () {
        const error = yield* dbDiff(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(DbConfigLoadError);
        if (error instanceof DbConfigLoadError) {
          expect(error.message).toContain("failed to read TLS cert");
        }
        expect(s.resolverCalls).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "forwards a comma-containing --schema value to the differ raw, with no CSV re-quoting (native path)",
    () => {
      // The native differ argv is never re-parsed by a CSV-splitting flag parser, so the
      // value reaches the container unchanged.
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), schema: ["tenant,one"] }));
        const call = s.differCalls[0];
        const idx = call?.cmd.indexOf("--schema") ?? -1;
        expect(call?.cmd[idx + 1]).toBe("tenant,one");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "emits a json envelope for --use-pgadmin with status lines redirected to stderr (payload-only stdout)",
    () => {
      const s = setup(tmp.current, {
        format: "json",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(stdout(s.out)).toBe("");
        const err = stderr(s.out);
        expect(err).toContain("Creating shadow database...");
        expect(err).toContain("Diffing local database with current migrations...");
        const success = s.out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({
          diff: PGADMIN_DIFF_SQL,
          file: null,
          files: [],
          schemas: [],
          engine: "pgadmin",
          dropStatements: [],
        });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a json-mode --use-pgadmin --file reports the written migration path instead of null (regression vs the old delegate)",
    () => {
      const s = setup(tmp.current, {
        format: "json",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), file: Option.some("pgadmin_diff") }));
        const success = s.out.messages.find((m) => m.type === "success");
        const data = yield* Schema.decodeUnknownEffect(WrittenMigrations)(success?.data);
        expect(data.file).toMatch(/\d{14}_pgadmin_diff\.sql$/);
        expect(data.files).toEqual([data.file]);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(data.file)).toBe(true);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("delivers the pgadmin payload as a stream-json result event too", () => {
    const s = setup(tmp.current, {
      format: "stream-json",
      pgadminStdout: [JSON.stringify([pgadminEntry()])],
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ diff: PGADMIN_DIFF_SQL, engine: "pgadmin" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes live-only SQL with --file even when declarative targets are configured", () => {
    const s = setup(tmp.current, {
      usePgDelta: true,
      files: {
        "supabase/config.toml": [
          "[db.migrations]",
          'schema_paths = ["schemas/*.sql"]',
          "",
          "[experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
        "supabase/schemas/declarative.sql": "create table declarative_only ();\n",
      },
      diffSql: "create table live_only ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      expect(stdout(s.out)).toBe("");
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
      expect(stderr(s.out)).toContain("-f names the migration; it does not filter objects");
      expect(stderr(s.out)).toContain("Run supabase db schema declarative sync to generate");
      expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      const files = yield* fs.readDirectory(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_my_diff\.sql$/);
      expect(yield* readFileText(path.join(dir, files[0] ?? ""))).toBe(
        "create table live_only ();\n",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("includes the ignored declarative baseline advisory in JSON output", () => {
    const s = setup(tmp.current, {
      usePgDelta: true,
      files: {
        "supabase/schemas/items.sql": "create table items ();\n",
      },
      format: "json",
      diffSql: "create table dogfood_note ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }));
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table dogfood_note ();\n",
        engine: "pg-delta",
        advisories: [
          {
            code: "DeclarativeSchemaNotUsedAsDiffBaseline",
            severity: "info",
            context: {
              baseline: "supabase/migrations",
              declarativePath: "supabase/schemas",
              fileFlagFiltersObjects: false,
            },
          },
        ],
      });
      expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("ignores declarative inspection errors without changing diff success", () => {
    const s = setup(tmp.current, {
      usePgDelta: true,
      files: {
        "supabase/config.toml": [
          "[experimental.pgdelta]",
          "enabled = true",
          'declarative_schema_path = "not-a-directory.sql"',
          "",
        ].join("\n"),
        "supabase/not-a-directory.sql": "select 1;\n",
      },
      format: "json",
      diffSql: "create table dogfood_note ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }));
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).not.toHaveProperty("advisories");
      expect(success?.data).toMatchObject({ diff: "create table dogfood_note ();\n" });
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes one migration file per unit for a multi-unit pg-delta plan", () => {
    const s = setup(tmp.current, {
      usePgDelta: true,
      format: "json",
      diffFiles: [
        { name: "ignored", sql: "alter type mood add value 'ok';" },
        { name: "ignored", sql: "insert into t values ('ok');" },
      ],
      diffSuffixes: ["_1", "_2"],
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      const files = (yield* fs.readDirectory(dir)).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toBe("19700101000000_my_diff_1.sql");
      expect(files[1]).toBe("19700101000001_my_diff_2.sql");
      expect(yield* readFileText(path.join(dir, files[0] ?? ""))).toBe(
        "alter type mood add value 'ok';\n",
      );
      const success = s.out.messages.find((m) => m.type === "success");
      const data = yield* Schema.decodeUnknownEffect(WrittenMigrations)(success?.data);
      expect(data.files).toHaveLength(2);
      expect(data.file).toBe(data.files[0]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested single-unit --file name", () => {
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ file: Option.some("snapshots/remote") }));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsRoot = path.join(tmp.current, "supabase", "migrations");
      const dirs = yield* fs.readDirectory(migrationsRoot);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
      expect(yield* fs.readDirectory(path.join(migrationsRoot, dirs[0] ?? ""))).toEqual([
        "remote.sql",
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to remote prints the diff to stdout", () => {
    const s = setup(tmp.current, { isLocal: false, diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("remote") }));
      expect(s.explicitDiffCalls[0]).toMatchObject({
        source: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            user: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
        desired: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: false, dnsResolver: "native" },
        },
      });
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
      expect(stdout(s.out)).toBe("create table e ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("resolves both explicit local refs before completing the diff", () => {
    const s = setup(tmp.current, { isLocal: false, diffSql: "create table local ( );\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("local") }));
      expect(s.explicitDiffCalls[0]?.source).toMatchObject({
        kind: "database",
        connection: { host: "127.0.0.1", port: 54322 },
        connectOptions: { isLocal: true, dnsResolver: "native" },
      });
      expect(s.explicitDiffCalls[0]?.desired).toMatchObject({
        kind: "database",
        connection: { host: "127.0.0.1", port: 54322 },
        connectOptions: { isLocal: true, dnsResolver: "native" },
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit URL endpoints retain the raw ref and remote connection options", () => {
    const s = setup(tmp.current, { diffSql: "create table u ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(
        flags({
          from: Option.some("postgresql://source.example/postgres"),
          to: Option.some("postgresql://desired.example/postgres"),
        }),
      );
      expect(s.explicitDiffCalls[0]?.source).toEqual({
        kind: "database",
        ref: "postgresql://source.example/postgres",
        connection: expect.objectContaining({ host: "source.example", database: "postgres" }),
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "database",
        ref: "postgresql://desired.example/postgres",
        connection: expect.objectContaining({ host: "desired.example", database: "postgres" }),
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --output writes raw SQL to the given path", () => {
    const s = setup(tmp.current, { diffSql: "create table w ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("local"),
          output: Option.some("out.sql"),
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(tmp.current, "out.sql"))).toBe(true);
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an empty --file value prints to stdout instead of writing a nameless migration",
    () => {
      // The file write is gated on non-empty; an empty --file falls through to stdout
      // instead of writing `<timestamp>_.sql`.
      const s = setup(tmp.current, { diffSql: "create table y ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ file: Option.some("") }));
        expect(stdout(s.out)).toContain("create table y ();");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migrationsDir = path.join(tmp.current, "supabase", "migrations");
        expect(
          (yield* fs.exists(migrationsDir)) ? yield* fs.readDirectory(migrationsDir) : [],
        ).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "explicit --output with an empty value prints to stdout instead of writing a file",
    () => {
      // The file write is gated on non-empty; an empty --output falls through to stdout
      // instead of writing into the project directory.
      const s = setup(tmp.current, { diffSql: "create table z ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({ from: Option.some("local"), to: Option.some("local"), output: Option.some("") }),
        );
        expect(stdout(s.out)).toBe("create table z ();\n");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("explicit --from migrations routes the migrations endpoint to the strategy", () => {
    const s = setup(tmp.current, { diffSql: "create table m ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("migrations"), to: Option.some("local") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from remote --to migrations passes the linked ref to the strategy", () => {
    // Linked resolves first, so the later migrations catalog uses the remote-merged config.
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": [
          "[db]",
          "major_version = 17",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.db]",
          "major_version = 14",
          "",
        ].join("\n"),
      },
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("remote"), to: Option.some("migrations") }));
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
      // Linked resolves first here (opposite of the sibling test below), so the
      // remote-merged config reaches the catalog.
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(14);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from migrations --to remote passes base config to the strategy", () => {
    // Migrations resolves before linked here, so the catalog must use base config
    // (no ref forwarded yet).
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": [
          "[db]",
          "major_version = 17",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.db]",
          "major_version = 14",
          "",
          // Set only under the remote block, so it would flip to true if the
          // linked-merged config leaked in.
          "[remotes.staging.experimental.webhooks]",
          "enabled = true",
          "",
        ].join("\n"),
      },
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("migrations"), to: Option.some("remote") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(17);
      expect(s.explicitDiffCalls[0]?.toml?.webhooksEnabled).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from=remote --to=migrations validates the merged config", () => {
    // 16 is not a supported major version: the base config only validates once the linked
    // project's remote override replaces it, so reading it before the ref resolves would fail.
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": [
          "[db]",
          "major_version = 16",
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
          "[remotes.staging.db]",
          "major_version = 15",
          "",
        ].join("\n"),
      },
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("remote"), to: Option.some("migrations") }));
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(15);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("empty --from/--to (shell vars) fall through to the normal diff", () => {
    // `--from "" --to ""` is unset and runs the normal local diff, not an
    // unknown-target error.
    const s = setup(tmp.current, { diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some(""), to: Option.some("") }));
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table e ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an explicit --from with an empty --to still errors 'must set both'", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("") })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  describe.each([
    { selector: { remote: REMOTE_LINKED } },
    {
      selector: { remote: Option.some({ _tag: "Ref", ref: "flagflagflagflagflag" } as const) },
    },
    {
      selector: { remote: Option.some({ _tag: "DbUrl", url: "postgresql://x" } as const) },
    },
  ] satisfies ReadonlyArray<{ selector: Partial<DbDiffFlags> }>)(
    "explicit --from/--to with --remote",
    ({ selector }) => {
      it.effect("is rejected before any target resolves", () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const error = yield* dbDiff(
            flags({ from: Option.some("local"), to: Option.some("migrations"), ...selector }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DbDiffExplicitFlagsError",
            message: "--remote doesn't apply with --from/--to; use --from=remote or --to=remote.",
          });
          expect(s.resolverCalls).toEqual([]);
          expect(s.explicitDiffCalls).toEqual([]);
          expect(s.cache.cached).toBe(false);
          expect(warningsOf(s.out)).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      });
    },
  );

  describe("explicit --from/--to with the deprecated selector flags", () => {
    const FLAG_PROJECT_REF = "flagflagflagflagflag";
    const CREDENTIALED_URL = "postgresql://u:secret@db.example.com:6543/postgres";
    const PROJECT_REF_WARNING =
      "--project-ref is deprecated and will be removed in v4. Use --from=<ref> or --to=<ref> instead";

    const hostedSetup = () =>
      setup(tmp.current, {
        isLocal: false,
        projectId: Option.some(VALID_REF),
        diffSql: "create table r ();\n",
      });

    it.effect.each([
      {
        flag: "--local",
        selector: { local: true },
        warning: "--local isn't needed (local is the default) and will be removed in v4",
      },
      {
        flag: "--linked",
        selector: { linked: true },
        warning:
          "--linked is deprecated and will be removed in v4. Use --from=remote or --to=remote instead",
      },
      {
        flag: "--db-url",
        selector: { dbUrl: Option.some(CREDENTIALED_URL) },
        warning:
          "--db-url is deprecated and will be removed in v4. Use --from=<url> or --to=<url> instead",
      },
    ] satisfies ReadonlyArray<{ flag: string; selector: Partial<DbDiffFlags>; warning: string }>)(
      "$flag warns and leaves --from local --to migrations as they are",
      ({ selector, warning }) => {
        const s = setup(tmp.current, { diffSql: "create table c ();\n" });
        return Effect.gen(function* () {
          yield* dbDiff(
            flags({ from: Option.some("local"), to: Option.some("migrations"), ...selector }),
          );
          expect(warningsOf(s.out)).toEqual([warning]);
          expect(s.explicitDiffCalls[0]?.source).toMatchObject({
            kind: "database",
            connectOptions: { isLocal: true },
          });
          expect(s.explicitDiffCalls[0]?.desired).toEqual({ kind: "migrations" });
          expect(s.resolverCalls).toEqual([]);
          expect(s.cache.cached).toBe(false);
          expect(`${s.out.stdoutText}${s.out.stderrText}`).not.toContain("secret");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("--linked with --from remote resolves the linked project once", () => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({ from: Option.some("remote"), to: Option.some("local"), linked: true }),
        );
        expect(s.resolverCalls.map((call) => call.target)).toEqual([
          expect.objectContaining({ kind: "linked", ref: VALID_REF, source: "file" }),
        ]);
        expect(warningsOf(s.out)).toEqual([
          "--linked is deprecated and will be removed in v4. Use --from=remote or --to=remote instead",
        ]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect.each(
      (["from", "to"] as const).flatMap((side) =>
        (["remote", "linked"] as const).map((keyword) => ({ side, keyword })),
      ),
    )("--project-ref redirects --$side $keyword to the project it names", ({ side, keyword }) => {
      const s = hostedSetup();
      const other = side === "from" ? "to" : "from";
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({
            [side]: Option.some(keyword),
            [other]: Option.some("migrations"),
            projectRef: Option.some(FLAG_PROJECT_REF),
          }),
        );
        expect(s.resolverCalls.map((call) => call.target)).toEqual([
          expect.objectContaining({ kind: "linked", ref: FLAG_PROJECT_REF, source: "flag" }),
        ]);
        expect(targetLines(s.out)).toEqual([`Target: project ${FLAG_PROJECT_REF}`]);
        expect(yield* CommandTarget.use((cell) => cell.json)).toEqual(
          Option.some({ kind: "linked", project_ref: FLAG_PROJECT_REF, environment: "unverified" }),
        );
        expect(warningsOf(s.out)).toEqual([
          PROJECT_REF_WARNING,
          ...(keyword === "linked"
            ? [
                `--${side} linked is deprecated and will be removed in v4. Use --${side}=remote instead`,
              ]
            : []),
        ]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("--project-ref redirects both remote sides to one shared connection", () => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({
            from: Option.some("remote"),
            to: Option.some("remote"),
            projectRef: Option.some(FLAG_PROJECT_REF),
          }),
        );
        expect(s.resolverCalls.map((call) => call.target)).toEqual([
          expect.objectContaining({ kind: "linked", ref: FLAG_PROJECT_REF, source: "flag" }),
        ]);
        expect(targetLines(s.out)).toEqual([`Target: project ${FLAG_PROJECT_REF}`]);
        expect(warningsOf(s.out)).toEqual([PROJECT_REF_WARNING]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("--project-ref=<branch> redirects the remote side to the branch's project", () => {
      const branchApi = branchListApi();
      const s = hostedSetup();
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({
            from: Option.some("remote"),
            to: Option.some("migrations"),
            projectRef: Option.some("feature-x"),
          }),
        ).pipe(Effect.provide(Layer.merge(s.layer, branchApi.layer)));
        expect(s.resolverCalls.map((call) => call.target)).toEqual([
          expect.objectContaining({ kind: "linked", ref: BRANCH_PROJECT_REF, source: "flag" }),
        ]);
        expect(warningsOf(s.out)).toEqual([
          "--project-ref is deprecated and will be removed in v4. Use --from=<branch> or --to=<branch> instead",
        ]);
        assertPermissionDrift({
          command: "db diff",
          activeFlags: { "project-ref": "feature-x", from: "remote", to: "migrations" },
          requests: branchApi.requests,
        });
      });
    });

    it.effect("--linked with --project-ref redirects the remote side under one warning", () => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({
            from: Option.some("remote"),
            to: Option.some("migrations"),
            linked: true,
            projectRef: Option.some(FLAG_PROJECT_REF),
          }),
        );
        expect(s.resolverCalls.map((call) => call.target)).toEqual([
          expect.objectContaining({ kind: "linked", ref: FLAG_PROJECT_REF, source: "flag" }),
        ]);
        expect(warningsOf(s.out)).toEqual([
          "--linked and --project-ref are deprecated and will be removed in v4. Use --from=<ref> or --to=<ref> instead",
        ]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect.each([
      {
        label: "--project-ref",
        selector: { projectRef: Option.some(FLAG_PROJECT_REF) },
        from: "local",
        to: "migrations",
      },
      {
        label: "--project-ref with a ref on the other side",
        selector: { projectRef: Option.some(FLAG_PROJECT_REF) },
        from: "abcdefghijklmnopqrst",
        to: "migrations",
      },
      {
        label: "--linked --project-ref",
        selector: { linked: true, projectRef: Option.some(FLAG_PROJECT_REF) },
        from: "local",
        to: "migrations",
      },
    ] satisfies ReadonlyArray<{
      label: string;
      selector: Partial<DbDiffFlags>;
      from: string;
      to: string;
    }>)("fails $label when neither side is remote", ({ selector, from, to }) => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        const error = yield* dbDiff(
          flags({ from: Option.some(from), to: Option.some(to), ...selector }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "DbDiffExplicitFlagsError",
          message:
            "--project-ref only applies when --from or --to is remote; to diff another project, use --from=<ref> or --to=<ref>.",
        });
        expect(s.resolverCalls).toEqual([]);
        expect(s.explicitDiffCalls).toEqual([]);
        expect(s.cache.cached).toBe(false);
        expect(warningsOf(s.out)).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect.each([
      { value: `https://${FLAG_PROJECT_REF}.supabase.co`, tag: "TargetInvalidValueError" },
      { value: CREDENTIALED_URL, tag: "DbDiffExplicitFlagsError" },
    ])("rejects --project-ref=<url> without echoing it ($tag)", ({ value, tag }) => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        const error = yield* dbDiff(
          flags({
            from: Option.some("remote"),
            to: Option.some("migrations"),
            projectRef: Option.some(value),
          }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: tag,
          message: "--project-ref takes a project ref or a branch name, not a URL.",
        });
        expect(error.message).not.toContain("secret");
        expect(s.resolverCalls).toEqual([]);
        expect(s.explicitDiffCalls).toEqual([]);
        expect(warningsOf(s.out)).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect.each([
      {
        label: "--linked with --local",
        selector: { linked: true, local: true },
        tag: "TargetSelectorConflictError",
        suggestion: "Use --from=remote or --to=remote instead of --linked, and drop --local.",
      },
      {
        label: "--project-ref with --db-url",
        selector: {
          projectRef: Option.some(FLAG_PROJECT_REF),
          dbUrl: Option.some(CREDENTIALED_URL),
        },
        tag: "TargetProjectRefConflictError",
        suggestion:
          "Use --from=<ref> or --to=<ref> instead of --project-ref, and --from=<url> or --to=<url> instead of --db-url.",
      },
    ] satisfies ReadonlyArray<{
      label: string;
      selector: Partial<DbDiffFlags>;
      tag: string;
      suggestion: string;
    }>)("still rejects $label, suggesting --from/--to", ({ selector, tag, suggestion }) => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        const error = yield* dbDiff(
          flags({ from: Option.some("remote"), to: Option.some("migrations"), ...selector }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: tag, suggestion });
        expect(s.resolverCalls).toEqual([]);
        expect(s.explicitDiffCalls).toEqual([]);
        expect(warningsOf(s.out)).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect.each([
      {
        label: "a --project-ref URL",
        selector: { projectRef: Option.some(`https://${FLAG_PROJECT_REF}.supabase.co`) },
        expected: {
          _tag: "TargetInvalidValueError",
          message: "--project-ref takes a project ref or a branch name, not a URL.",
          suggestion: `Use --from=${FLAG_PROJECT_REF} or --to=${FLAG_PROJECT_REF}.`,
        },
      },
      {
        label: "an empty --project-ref",
        selector: { projectRef: Option.some("") },
        expected: {
          _tag: "TargetEmptyValueError",
          message: "--project-ref cannot be empty.",
          suggestion: "Pass a project ref as --from=<ref> or --to=<ref>.",
        },
      },
    ] satisfies ReadonlyArray<{
      label: string;
      selector: Partial<DbDiffFlags>;
      expected: { _tag: string; message: string; suggestion: string };
    }>)("suggests --from/--to, not --remote, for $label", ({ selector, expected }) => {
      const s = hostedSetup();
      return Effect.gen(function* () {
        const error = yield* dbDiff(
          flags({ from: Option.some("remote"), to: Option.some("migrations"), ...selector }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject(expected);
        expect(s.resolverCalls).toEqual([]);
        expect(s.explicitDiffCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });
  });

  it.effect("fails when --from is set without --to", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ from: Option.some("local") })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on engine-flag conflict (--use-migra with --use-pg-delta)", () => {
    const s = setup(tmp.current, { usePgDelta: true });
    return Effect.gen(function* () {
      const exit = yield* dbDiff(
        flags({ useMigra: Option.some(true), usePgDelta: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects --use-migra on the stack backend", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ useMigra: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(StackNativeEngineError);
      if (!(error instanceof StackNativeEngineError)) return;
      expect(error.message).toContain("The stack backend only supports the pg-delta engine.");
      expect(error.message).toContain("--use-migra");
    }).pipe(Effect.provide(Layer.mergeAll(s.layer, stackBackendLayer("stack"))));
  });

  it.effect("accepts --use-migra=false on the stack backend and proceeds to stack services", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ useMigra: Option.some(false) })).pipe(Effect.exit);
      expect(stderr(s.out)).toContain("Creating shadow database...");
      // The fixture's stack services are placeholders, so the run stops at its first stack call
      // after the engine check; a typed error here would mean the flag was rejected.
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.pretty(exit.cause)).toContain("Stack services must not run");
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeUndefined();
    }).pipe(Effect.provide(Layer.mergeAll(s.layer, stackBackendLayer("stack"))));
  });

  it.effect("warns on drop statements in the diff", () => {
    const s = setup(tmp.current, { diffSql: "drop table gone;\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stderr(s.out)).toContain("Found drop statements in schema diff");
      expect(stderr(s.out)).toContain("drop table gone");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("warns on semantic data-loss hazards without a DROP statement", () => {
    const sql = "ALTER TABLE public.accounts ALTER COLUMN email TYPE text;";
    const s = setup(tmp.current, {
      usePgDelta: true,
      diffSql: sql,
      hazards: {
        actions: [{ actionIndex: 0, kinds: ["data_loss"] }],
        dataLoss: [{ actionIndex: 0, sql }],
        coverage: ["data_loss"],
        kinds: ["data_loss"],
      },
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(stderr(s.out)).toContain("Found destructive changes in schema diff");
      expect(stderr(s.out)).toContain(sql);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("emits a json envelope with --output-format json (payload-only stdout)", () => {
    const s = setup(tmp.current, { format: "json", diffSql: "create table j ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stdout(s.out)).toBe("");
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table j ();\n",
        file: null,
        engine: "pg-delta",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("prints 'No schema changes found' and exits 0 on an empty diff", () => {
    const s = setup(tmp.current, { diffSql: "" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stderr(s.out)).toContain("No schema changes found");
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("surfaces a crashed migra script instead of reporting no schema changes", () => {
    const s = setup(tmp.current, {
      diffFailWith:
        "error diffing schema: error running script:\nTypeError: Cannot read properties of undefined (reading 'constraints')\nPGDELTA_SCRIPT_ERROR\n",
    });
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ useMigra: Option.some(true) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stderr(s.out)).not.toContain("No schema changes found");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("falls back to the migra Docker image when edge-runtime OOMs", () => {
    const s = setup(tmp.current, { oom: true, diffSql: "create table fb ();\n", isLocal: true });
    return Effect.gen(function* () {
      // Pass --schema so the fallback does not need a live DB to list schemas.
      yield* dbDiff(flags({ useMigra: Option.some(true), schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table fb ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("the migra OOM fallback honors --network-id over host networking", () => {
    // Routes through Docker start, which overrides host networking with --network-id.
    const s = setup(tmp.current, {
      oom: true,
      diffSql: "create table fb ();\n",
      isLocal: true,
      networkId: "my-net",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ useMigra: Option.some(true), schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect(s.dockerCalls[0]?.network).toEqual({
        _tag: "named",
        name: "my-net",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "the migra OOM fallback on a named network targets loopback databases via the host",
    () => {
      const s = setup(tmp.current, {
        oom: true,
        diffSql: "create table fb ();\n",
        isLocal: true,
        networkId: "my-net",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ useMigra: Option.some(true), schema: ["public"] }));
        const env = s.dockerCalls[0]?.env;
        expect(new URL(env?.["SOURCE"] ?? "").hostname).toBe("host.docker.internal");
        expect(new URL(env?.["TARGET"] ?? "").host).toBe("host.docker.internal:54322");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "removes the shadow container on a SIGINT-style interruption during the readiness wait, without waiting for the readiness timeout",
    () => {
      // `acquire` covers only `createShadowDatabase`; the readiness wait runs in the
      // interruptible `use` phase instead, so a `Fiber.interrupt` here must land
      // promptly rather than waiting for the readiness timeout.
      const s = setup(tmp.current, { neverConnectableShadow: true });
      return Effect.gen(function* () {
        const fiber = yield* dbDiff(flags()).pipe(
          Effect.provide(s.layer),
          Effect.forkChild({ startImmediately: true }),
        );
        // Waits until the shadow's readiness gate has refused a connect at least once,
        // proving the fiber is suspended in `waitForShadowReady`'s retry loop.
        yield* Deferred.await(s.shadowConnectRefused);
        // `Fiber.interrupt` only resolves once finalizers complete; this would hang (the readiness
        // timeout never elapses under the test clock) if `acquire` still covered the readiness wait.
        yield* Fiber.interrupt(fiber);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        expect(s.edgeCalls).toHaveLength(0);
      });
    },
  );

  describe("--use-pgadmin (native differ, CLI-1968)", () => {
    it.effect(
      "prints 'No schema changes found' and writes nothing when the differ output is empty",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [""] });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(stderr(s.out)).toContain("No schema changes found");
          expect(stdout(s.out)).toBe(
            "Creating shadow database...\nDiffing local database with current migrations...\n",
          );
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const migrationsDir = path.join(tmp.current, "supabase", "migrations");
          expect(
            (yield* fs.exists(migrationsDir)) ? yield* fs.readDirectory(migrationsDir) : [],
          ).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "prints 'No schema changes found' when every diff entry is filtered out (all Identical)",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry({ status: "Identical" })])],
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(stderr(s.out)).toContain("No schema changes found");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("writes a timestamped migration for --use-pgadmin --file instead of printing", () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), file: Option.some("pgadmin_diff") }));
        expect(stdout(s.out)).not.toContain("ALTER TABLE");
        expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(tmp.current, "supabase", "migrations");
        const files = yield* fs.readDirectory(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{14}_pgadmin_diff\.sql$/);
        expect(yield* readFileText(path.join(dir, files[0] ?? ""))).toBe(PGADMIN_DIFF_SQL);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("creates nested parent directories for a nested --use-pgadmin --file name", () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({ usePgAdmin: Option.some(true), file: Option.some("snapshots/remote") }),
        );
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migrationsRoot = path.join(tmp.current, "supabase", "migrations");
        const dirs = yield* fs.readDirectory(migrationsRoot);
        expect(dirs).toHaveLength(1);
        expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
        expect(yield* fs.readDirectory(path.join(migrationsRoot, dirs[0] ?? ""))).toEqual([
          "remote.sql",
        ]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "an empty --use-pgadmin --file value falls through to stdout instead of writing",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true), file: Option.some("") }));
          expect(stdout(s.out)).toContain("ALTER TABLE test;");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const migrationsDir = path.join(tmp.current, "supabase", "migrations");
          expect(
            (yield* fs.exists(migrationsDir)) ? yield* fs.readDirectory(migrationsDir) : [],
          ).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "never prints the 'Finished ... on branch' banner or a drop-statement warning, even with a DROP in the SQL",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry({ diff_ddl: "drop table gone;" })])],
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(stderr(s.out)).not.toContain("Finished");
          expect(stderr(s.out)).not.toContain("Found drop statements");
          expect(stdout(s.out)).toContain("drop table gone;");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "invokes the differ with the exact argv, image, network, labels, and empty env/binds (no --schema)",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          const path = yield* Path.Path;
          // `CommandSettings.projectId` only feeds pg-delta's project id; the differ's
          // network/labels come from `loadLocalProjectContext`'s own resolution, falling
          // back to the workdir basename.
          const projectId = path.basename(tmp.current);
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(s.differCalls).toHaveLength(1);
          const call = s.differCalls[0];
          expect(call?.image).toBe(dockerfileServiceImage("differ", false));
          expect(call?.image).toBe("supabase/pgadmin-schema-diff:cli-0.0.5");
          expect(call?.cmd).toEqual(["--json-diff", PGADMIN_SOURCE_URL, PGADMIN_TARGET_URL]);
          expect(call?.env).toEqual({});
          expect(call?.binds).toEqual([]);
          expect(call?.securityOpt).toEqual([]);
          expect(call?.workingDir).toEqual(Option.none());
          expect(call?.entrypoint).toBeUndefined();
          expect(call?.network).toEqual({ _tag: "named", name: `supabase_network_${projectId}` });
          expect(call?.labels).toEqual({
            "com.supabase.cli.project": projectId,
            "com.docker.compose.project": projectId,
          });
          expect(call?.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
          // The differ's stderr is never teed to the parent terminal.
          expect(s.differCaptureOpts[0]).toBeUndefined();
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("--network-id forwards to the differ's --network, same as the shadow", () => {
      const s = setup(tmp.current, {
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
        networkId: "custom-net",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
        const call = s.differCalls[0];
        expect(call?.network).toEqual({ _tag: "named", name: "custom-net" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("omits --add-host on a non-Linux host", () => {
      const s = setup(tmp.current, {
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
        platform: "darwin",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
        const call = s.differCalls[0];
        expect(call?.extraHosts).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "hardcodes the shadow target's postgres:postgres credentials, ignoring a configured [db] password",
      () => {
        const s = setup(tmp.current, {
          files: {
            "supabase/config.toml": '[db]\npassword = "distinctive-pw"\n',
          },
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          const call = s.differCalls[0];
          expect(call?.cmd.at(-1)).toBe(PGADMIN_TARGET_URL);
          expect(call?.cmd.join(" ")).not.toContain("distinctive-pw");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "a supabase/.env-only SUPABASE_INTERNAL_IMAGE_REGISTRY reaches the differ's image resolver without global mutation",
      () => {
        // The project environment is passed to the differ explicitly, so a dotenv-only
        // registry override reaches image resolution without mutating the ambient environment.
        const s = setup(tmp.current, {
          files: {
            "supabase/.env": "SUPABASE_INTERNAL_IMAGE_REGISTRY=registry.example.com\n",
          },
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
        });
        const ambientRegistry = () =>
          Config.option(Config.String("SUPABASE_INTERNAL_IMAGE_REGISTRY")).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
            ),
          );
        return Effect.gen(function* () {
          const ambientBefore = yield* ambientRegistry();
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true }),
            ),
          );
          expect(s.differRegistryEnvAtCall).toEqual(["registry.example.com"]);
          expect(yield* ambientRegistry()).toEqual(ambientBefore);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "filters differ stderr through ProcessDiffProgress, printing only the matched status text to stdout",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
          pgadminStderr: [
            "Starting schema diff...\nComparing Tables 45%\nnoise line\nDiffing 100%\n",
          ],
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          const text = stdout(s.out);
          expect(text).toContain("Comparing Tables \n");
          expect(text).toContain("Diffing 1\n");
          expect(text).not.toContain("Starting schema diff...");
          expect(text).not.toContain("noise line");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("still parses --json-diff output prefixed with the DESKTOP-mode NOTE line", () => {
      const s = setup(tmp.current, {
        pgadminStdout: [`${PGADMIN_DESKTOP_NOTE_PREFIX}${JSON.stringify([pgadminEntry()])}`],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(stdout(s.out)).toContain("ALTER TABLE test;");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "loops one differ run per --schema, in flag order, with per-run 'Diffing schema:' status lines",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry({ diff_ddl: "create table pub ();" })]), ""],
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true), schema: ["public", "app"] }));
          expect(s.differCalls).toHaveLength(2);
          expect(s.differCalls[0]?.cmd).toEqual([
            "--schema",
            "public",
            "--json-diff",
            PGADMIN_SOURCE_URL,
            PGADMIN_TARGET_URL,
          ]);
          expect(s.differCalls[1]?.cmd).toEqual([
            "--schema",
            "app",
            "--json-diff",
            PGADMIN_SOURCE_URL,
            PGADMIN_TARGET_URL,
          ]);
          const text = stdout(s.out);
          const idxPublic = text.indexOf("Diffing schema: public");
          const idxApp = text.indexOf("Diffing schema: app");
          expect(idxPublic).toBeGreaterThanOrEqual(0);
          expect(idxApp).toBeGreaterThan(idxPublic);
          expect(text).toContain("create table pub ();");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      ">=2 --schema runs each emitting a diff array succeed, aggregating every run's DDL under ONE header (CLI-1968 round 2: parsed per run, not concatenated then parsed once)",
      () => {
        // Each run's stdout is parsed on its own (see `pgadmin-diff.ts`), including its
        // own DESKTOP-mode NOTE prefix trim, not just the first run's.
        const s = setup(tmp.current, {
          pgadminStdout: [
            `${PGADMIN_DESKTOP_NOTE_PREFIX}${JSON.stringify([pgadminEntry({ diff_ddl: "create table pub ();" })])}`,
            `${PGADMIN_DESKTOP_NOTE_PREFIX}${JSON.stringify([pgadminEntry({ diff_ddl: "create table app ();" })])}`,
          ],
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true), schema: ["public", "app"] }));
          const text = stdout(s.out);
          expect(text.split(PGADMIN_DIFF_HEADER)).toHaveLength(2);
          expect(text).toContain(
            `${PGADMIN_DIFF_HEADER}\n\ncreate table pub ();\n\ncreate table app ();\n`,
          );
          const idxPublic = text.indexOf("Diffing schema: public");
          const idxApp = text.indexOf("Diffing schema: app");
          expect(idxPublic).toBeGreaterThanOrEqual(0);
          expect(idxApp).toBeGreaterThan(idxPublic);
          expect(text).not.toContain("NOTE: Configuring authentication for DESKTOP mode.");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails with invalid_output when a run's own --json-diff stdout doesn't parse", () => {
      const s = setup(tmp.current, { pgadminStdout: ["not valid json"] });
      return Effect.gen(function* () {
        const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "DbDiffPgAdminError",
          reason: "invalid_output",
        });
        expect(error.message).toContain("failed to parse schema diff output:");
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "emits a failed run's captured progress statuses before the container-error surfaces",
      () => {
        const s = setup(tmp.current, {
          pgadminExitCode: 1,
          pgadminStderr: ["Comparing Tables 45%\nDiffing 100%\n"],
        });
        return Effect.gen(function* () {
          const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DbDiffPgAdminError",
            reason: "differ",
            message: "error running container: exit 1",
          });
          const text = stdout(s.out);
          expect(text).toContain("Comparing Tables \n");
          expect(text).toContain("Diffing 1\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "in stream-json mode, a failed run's captured progress statuses redirect to stderr (CLI-1546) but are still emitted before the container-error result",
      () => {
        const s = setup(tmp.current, {
          format: "stream-json",
          pgadminExitCode: 1,
          pgadminStderr: ["Comparing Tables 45%\n"],
        });
        return Effect.gen(function* () {
          const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "DbDiffPgAdminError", reason: "differ" });
          expect(stderr(s.out)).toContain("Comparing Tables \n");
          expect(stdout(s.out)).toBe("");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails with 'error running container: exit 1' when the differ exits non-zero, and still removes the shadow",
      () => {
        const s = setup(tmp.current, {
          pgadminExitCode: 1,
          pgadminStderr: ["some differ crash text\n"],
        });
        return Effect.gen(function* () {
          const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DbDiffPgAdminError",
            reason: "differ",
            message: "error running container: exit 1",
          });
          // The differ's own stderr never reaches the error message.
          expect(error.message).not.toContain("some differ crash text");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails with 'error running container: exit 137' on an OOM-killed differ", () => {
      const s = setup(tmp.current, { pgadminExitCode: 137 });
      return Effect.gen(function* () {
        const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "DbDiffPgAdminError",
          reason: "differ",
          message: "error running container: exit 137",
        });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("classifies a differ spawn failure as docker_daemon", () => {
      const s = setup(tmp.current, { pgadminDockerFail: "spawn" });
      return Effect.gen(function* () {
        const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DbDiffPgAdminError", reason: "docker_daemon" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("classifies a differ image-pull failure as registry_pull", () => {
      const s = setup(tmp.current, { pgadminDockerFail: "pull" });
      return Effect.gen(function* () {
        const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DbDiffPgAdminError", reason: "registry_pull" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails with 'supabase start is not running.' before ever creating a shadow, but after the target resolve",
      () => {
        const s = setup(tmp.current, { dbNotRunning: true });
        return Effect.gen(function* () {
          const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "DbDiffDbNotRunningError" });
          expect(stripAnsi(error.message)).toBe("supabase start is not running.");
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
          expect(s.differCalls).toEqual([]);
          expect(s.resolverCalls.length).toBeGreaterThan(0);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "classifies a daemon-unreachable local-db inspect as daemonDown with the Docker install suggestion",
      () => {
        const s = setup(tmp.current, {
          dbInspectFailsWith:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        });
        return Effect.gen(function* () {
          const error = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DbDiffDbNotRunningError",
            daemonDown: true,
            suggestion: expect.stringContaining("Docker Desktop"),
          });
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "propagates a failed shadow platform-baseline job and still removes the shadow (pgAdmin path)",
      () => {
        const s = setup(tmp.current, { failShadowSetupJob: true });
        return Effect.gen(function* () {
          const exit = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect("fails with DbDiffWriteError when writing the pgAdmin --file migration fails", () => {
      const s = setup(tmp.current, {
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
        failWriteMatching: (path) => path.includes("pgadmin_diff"),
      });
      return Effect.gen(function* () {
        const error = yield* dbDiff(
          flags({ usePgAdmin: Option.some(true), file: Option.some("pgadmin_diff") }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DbDiffWriteError" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "fails on engine-flag conflict (--use-pgadmin with --use-pg-delta), byte-exact message",
      () => {
        const s = setup(tmp.current, { usePgDelta: true });
        return Effect.gen(function* () {
          const error = yield* dbDiff(
            flags({ usePgAdmin: Option.some(true), usePgDelta: Option.some(true) }),
          ).pipe(Effect.flip);
          expect(error.message).toBe(
            "if any flags in the group [use-migra use-pgadmin use-pg-delta] are set none of the others can be; [use-pg-delta use-pgadmin] were all set",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "explicit --from/--to wins over --use-pgadmin (pgadmin is ignored, pg-delta runs)",
      () => {
        const s = setup(tmp.current, { isLocal: false, diffSql: "create table explicit ();\n" });
        return Effect.gen(function* () {
          yield* dbDiff(
            flags({
              usePgAdmin: Option.some(true),
              from: Option.some("local"),
              to: Option.some("remote"),
            }),
          );
          expect(s.differCalls).toEqual([]);
          expect(s.explicitDiffCalls).toHaveLength(1);
          expect(stdout(s.out)).toBe("create table explicit ();\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "removes the shadow container on interruption during the health wait for --use-pgadmin too",
      () => {
        const s = setup(tmp.current, { usePgDelta: true, neverHealthyShadow: true });
        return Effect.gen(function* () {
          const fiber = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.provide(s.layer),
            Effect.forkChild({ startImmediately: true }),
          );
          // Waits for the shadow's own health probe (its 64-hex id); the pgadmin path's
          // separate `supabase_db_test` probe fires first and would satisfy a looser
          // check immediately.
          yield* Deferred.await(s.shadowHealthProbed);
          yield* Fiber.interrupt(fiber);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
          expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
          expect(s.differCalls).toEqual([]);
        });
      },
    );
  });

  describe("shadow baseline cache", () => {
    /** The `.tar` files published under the per-test `SUPABASE_HOME` this block pins. */
    const publishedTars = () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(tmp.current, "_supabase_home", "cache", "shadow-baseline");
        return (yield* fs.exists(dir))
          ? (yield* fs.readDirectory(dir)).filter((entry) => entry.endsWith(".tar"))
          : [];
      });

    /**
     * Runs `db diff` with the shadow baseline cache on and artifacts under the workdir,
     * against the stateful Docker model the export/restore round trip needs.
     */
    const runCached = (engine: "migra" | "pg-delta") =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const s = setup(tmp.current, {
          usePgDelta: engine === "pg-delta",
          files: { "supabase/config.toml": "[experimental.pgdelta]\nenabled = true\n" },
          statefulDocker: true,
          diffSql: "create table t ();\n",
        });
        return yield* withEnvVar(
          "SUPABASE_HOME",
          path.join(tmp.current, "_supabase_home"),
          withConfigEnv(
            { SUPABASE_SHADOW_CACHE: "1" },
            dbDiff(
              flags(
                engine === "pg-delta"
                  ? { usePgDelta: Option.some(true) }
                  : { useMigra: Option.some(true) },
              ),
            ),
          ).pipe(Effect.provide(s.layer)),
        ).pipe(Effect.as(s));
      });

    // A migra baseline and a pg-delta baseline must not key to the same cache tar and
    // silently restore each other's cluster; `shadow-cache.integration.test.ts` covers
    // the cache's own half, this covers the call site.
    it.live("a migra-engine baseline is never restored into a pg-delta run", () => {
      return Effect.gen(function* () {
        // Migra's migrate path forces `pg_net` on regardless of config, and publishes
        // that baseline.
        const migraRun = yield* runCached("migra");
        expect(migraRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        const migraTars = yield* publishedTars();
        expect(migraTars).toHaveLength(1);

        // pg-delta follows the config (webhooks are off here), so it must cold-provision
        // and publish its own baseline rather than restore the forced-on one above.
        const pgDeltaRun = yield* runCached("pg-delta");
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-in")).toHaveLength(0);
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        expect(yield* publishedTars()).toHaveLength(2);
        expect(yield* publishedTars()).toEqual(expect.arrayContaining(migraTars));
      }).pipe(Effect.provide(BunServices.layer));
    });
  });
});

describe("db diff permissions through the real resolver and cache", () => {
  const asLines = (requests: ReadonlyArray<StubbedRequest>) =>
    requests.map(({ method, path }) => `${method} ${path}`);
  const poolerRequest = `GET /v1/projects/${VALID_REF}/config/database/pooler`;
  const loginRoleRequest = `POST /v1/projects/${VALID_REF}/cli/login-role`;
  const cacheRequest = `GET https://api.supabase.com/v1/projects/${VALID_REF}`;
  const cacheCalls = (calls: ReadonlyArray<{ readonly method: string; readonly url: string }>) =>
    calls.map(({ method, url }) => `${method} ${url}`);

  it.effect("mints a login role and fills the cache for --remote=<ref>", () => {
    const s = setup(tmp.current, { realLayers: true, diffSql: "alter table x;\n" });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbDiff(flags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const) })).pipe(
        Effect.provide(s.layer),
      );
      expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
      expect(cacheCalls(s.projectHttp.calls)).toEqual([cacheRequest]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "db diff",
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

  it.effect("makes no Management API request for the default local target", () => {
    const s = setup(tmp.current, { realLayers: true, diffSql: "alter table x;\n" });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, () => undefined);
      yield* dbDiff(flags()).pipe(Effect.provide(s.layer));
      expect(requests).toEqual([]);
      expect(s.projectHttp.calls).toEqual([]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(false);
      assertPermissionDrift({
        command: "db diff",
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  for (const side of ["from", "to"] as const) {
    it.effect(`resolves the project ref --${side} names`, () => {
      const s = setup(tmp.current, { realLayers: true, diffSql: "create table e ();\n" });
      const requests: Array<StubbedRequest> = [];
      const refs =
        side === "from"
          ? { from: VALID_REF, to: "migrations" }
          : { from: "migrations", to: VALID_REF };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
        yield* dbDiff(flags({ from: Option.some(refs.from), to: Option.some(refs.to) })).pipe(
          Effect.provide(s.layer),
        );
        expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
        expect(cacheCalls(s.projectHttp.calls)).toEqual([cacheRequest]);
        expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
        assertPermissionDrift({
          command: "db diff",
          activeFlags: { from: refs.from, to: refs.to },
          requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(BunServices.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    });
  }

  it.effect("resolves the project --project-ref names for a remote side", () => {
    const s = setup(tmp.current, { realLayers: true, diffSql: "create table e ();\n" });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbDiff(
        flags({
          from: Option.some("remote"),
          to: Option.some("migrations"),
          projectRef: Option.some(VALID_REF),
        }),
      ).pipe(Effect.provide(s.layer));
      expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
      expect(cacheCalls(s.projectHttp.calls)).toEqual([cacheRequest]);
      assertPermissionDrift({
        command: "db diff",
        activeFlags: { "project-ref": VALID_REF, from: "remote", to: "migrations" },
        requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for --from local --to migrations", () => {
    const s = setup(tmp.current, { realLayers: true, diffSql: "create table e ();\n" });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("migrations") })).pipe(
        Effect.provide(s.layer),
      );
      expect(requests).toEqual([]);
      expect(s.projectHttp.calls).toEqual([]);
      assertPermissionDrift({
        command: "db diff",
        activeFlags: { from: "local", to: "migrations" },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "mints one login role shared by both sides when --from and --to name one project",
    () => {
      const s = setup(tmp.current, { realLayers: true, diffSql: "create table e ();\n" });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
        yield* dbDiff(flags({ from: Option.some(VALID_REF), to: Option.some(VALID_REF) })).pipe(
          Effect.provide(s.layer),
        );
        expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
        assertPermissionDrift({
          command: "db diff",
          activeFlags: { from: VALID_REF, to: VALID_REF },
          requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(BunServices.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );
});
