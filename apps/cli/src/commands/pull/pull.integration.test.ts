import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

const fixtureNet = vi.hoisted(() => ({ directHostReachable: false }));

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net, fixtureNet)),
);

const reachableDirectHost = withReachableDirectHost(fixtureNet);

import { v2ProjectConfigResponse } from "../../../tests/helpers/config-fixtures.ts";
import { assertPermissionDrift } from "../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  projectResponse,
  provideEnv,
  realDbConfigResolver,
  realLinkedProjectCache,
  recordingProjectHttpClient,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../tests/helpers/permission-real-layers.ts";
import { withReachableDirectHost } from "../../../tests/helpers/refuse-invalid-db-hosts.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import { configValuesLayer } from "../../../tests/helpers/config-values-layer.ts";
import {
  buildTestRuntime,
  VALID_REF,
  type ApiHandler,
  VALID_TOKEN,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  transportFailure,
  withConfigEnv,
  shadowCacheDisabledLayer,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { unusedStackServices } from "../../../tests/helpers/unused-stack.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../shared/output/output.layer.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { DbConfigResolver } from "../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../command-internal/db-config.types.ts";
import { HostedMutationDeclinedError } from "../../command-internal/hosted-consent/hosted-consent.errors.ts";
import type { RemoteValue } from "../../command-internal/target/remote-value.ts";
import { TargetPolicy } from "../../command-internal/target/target-policy.ts";
import { DbConnection, type DbSession } from "../../command-internal/db-connection.service.ts";
import { DbExecError } from "../../command-internal/db-connection.errors.ts";
import { DbPullMigrationConflictError } from "../../command-internal/db-pull-run.errors.ts";
import { BundledPostgresClient } from "../../command-internal/bundled-postgres-client.ts";
import { DockerRun } from "../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScript } from "../../command-internal/edge-runtime-script.service.ts";
import { MigrationFetchWriteError } from "../migration/fetch/fetch.errors.ts";
import { PgDeltaSslProbe } from "../../command-internal/pgdelta-ssl-probe.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { describeHostedConsent } from "../../../tests/helpers/hosted-consent.ts";
import { pull } from "./pull.handler.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../db/shared/pgdelta-engine.service.ts";
import type { PullFlags } from "./pull.command.ts";
import { pullHandler } from "./pull.command.ts";
import { warningsOf } from "../../../tests/helpers/remote-selection.ts";

/**
 * Scenario-oriented integration coverage for `supabase pull` (ADR 0024), driving the real
 * exported `pullHandler` against a fully mocked db-pull/migration-fetch/functions-download
 * substrate. `PgDeltaEngine` is mocked directly to force the pg-delta diff engine; `DbConnection`
 * shares one fake Postgres session across the migration-history and db steps, since both read
 * `supabase_migrations.schema_migrations`.
 */

const tempRoot = useTempWorkdir("supabase-pull-int-");

/** The effective values of `pull`'s three switches when none is named. */
const STEP_SWITCHES = { "dry-run": false, force: false, "with-migration-history": false };

const BRANCH_REF = "cccccccccccccccccccc";

const CONSENT_ACTION = "Pull project state and update the remote migration history table";

const BRANCH_BY_NAME = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "staging",
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: true,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

const projectPath = (...segments: ReadonlyArray<string>) =>
  Effect.map(Path.Path, (path) => path.join(tempRoot.current, ...segments));

const configPath = projectPath("supabase", "config.toml");
const migrationsDir = projectPath("supabase", "migrations");

const readTextFile = (filePath: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(filePath));

const readConfigFile = Effect.flatMap(configPath, readTextFile);

const projectFileExists = (...segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(yield* projectPath(...segments));
  });

const listMigrations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(yield* migrationsDir);
});

/** Writes `supabase/config.toml` verbatim, without the pg-delta preamble `writeConfig` adds. */
const writeConfigFile = (toml: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(yield* projectPath("supabase"), { recursive: true });
    yield* fs.writeFileString(yield* configPath, toml);
  });

/** Writes a minimal, schema-valid `supabase/config.toml` with pg-delta forced on
 *  (so every db step exercises the fully-mocked `PgDeltaEngine`, never the
 *  migra/edge-runtime path or the pg_dump initial-pull seed). */
const writeConfig = (extraToml = "") =>
  writeConfigFile(
    `project_id = "${VALID_REF}"\n\n[experimental.pgdelta]\nenabled = true\n${extraToml}`,
  );

/** Seeds a local migration file whose basename `loadLocalVersions` parses
 *  back into `version` — content is irrelevant to every mocked collaborator here. */
const seedLocalMigration = (version: string, name = "local", sql = "create table local ();\n") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* migrationsDir;
    yield* fs.makeDirectory(dir, { recursive: true });
    const filePath = yield* projectPath("supabase", "migrations", `${version}_${name}.sql`);
    yield* fs.writeFileString(filePath, sql);
    return filePath;
  });

/** Writes `supabase/.env`, backing `env(VAR)` resolution. */
const writeProjectEnv = (dotenv: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(yield* projectPath("supabase"), { recursive: true });
    yield* fs.writeFileString(yield* projectPath("supabase", ".env"), dotenv);
  });

const jsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const jsonEnvelope = Schema.fromJsonString(jsonRecord);

const dbStepFailureEnvelope = Schema.fromJsonString(
  Schema.Struct({
    steps: Schema.Struct({
      db: Schema.Struct({
        status: Schema.String,
        failure: Schema.Struct({ code: Schema.String, suggestion: Schema.String }),
      }),
    }),
  }),
);

const dbStepWrittenEnvelope = Schema.fromJsonString(
  Schema.Struct({
    steps: Schema.Struct({
      db: Schema.Struct({ status: Schema.String, written: Schema.Array(Schema.String) }),
    }),
  }),
);

/** The rendered step row for `step` in `renderPullSummary`'s output, with
 *  internal padding collapsed to single spaces so assertions don't hardcode
 *  column widths. Empty string when the step has no row at all. */
function stepLine(text: string, step: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().startsWith(step));
  return line === undefined ? "" : line.trim().replace(/\s+/g, " ");
}

const branchRemote = (name: string) => Option.some<RemoteValue>({ _tag: "Branch", name });
const refRemote = (ref: string) => Option.some<RemoteValue>({ _tag: "Ref", ref });

function pullFlags(overrides: Partial<PullFlags> = {}): PullFlags {
  return {
    remote: overrides.remote ?? Option.none(),
    projectRef: overrides.projectRef ?? Option.none(),
    remoteLabel: overrides.remoteLabel ?? Option.none(),
    dryRun: overrides.dryRun ?? false,
    force: overrides.force ?? false,
    withMigrationHistory: overrides.withMigrationHistory ?? false,
  };
}

/** Drives the exact wiring `pull.command.ts`'s `Command.withHandler` uses, imported rather than
 *  reimplemented, so this suite can't drift from what actually ships. */
function runPull(flags: PullFlags) {
  return pullHandler(flags);
}

// Combines the shadow-container fake with a controllable "docker info" (Docker running?)
// answer and a controllable "git status" (dirty path?) answer.
function composeSpawner(
  opts: {
    /** Reports `supabase/config.toml` dirty. */
    readonly gitDirty?: boolean;
    /** Reports `supabase/migrations` dirty. */
    readonly gitDirtyMigrations?: boolean;
    /** Reports `supabase/functions` dirty. */
    readonly gitDirtyFunctions?: boolean;
    readonly gitSpawnFails?: boolean;
  } = {},
): {
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly shadowSpawned: ReadonlyArray<{ readonly args: ReadonlyArray<string> }>;
  readonly gitCalls: ReadonlyArray<ReadonlyArray<string>>;
} {
  const shadow = mockShadowContainerCliSpawner();
  const gitCalls: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();

  const layer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return inner.spawn(command);
        }
        if (command.command === "git") {
          gitCalls.push(command.args);
          if (opts.gitSpawnFails === true) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                description: "git not found",
              }),
            );
          }
          // Each of the three dirty checks (config, migrations, functions) uses its own
          // basename as the trailing pathspec, so each can be independently marked
          // dirty/clean in one test.
          const pathspec = command.args[command.args.length - 1];
          const dirty =
            pathspec === "migrations"
              ? opts.gitDirtyMigrations === true
              : pathspec === "functions"
                ? opts.gitDirtyFunctions === true
                : opts.gitDirty === true;
          const stdout = dirty ? ` M ${pathspec}\n` : "";
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(9000 + gitCalls.length),
              stdout: Stream.fromIterable([encoder.encode(stdout)]),
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              stdin: Sink.drain,
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }
        if (command.command === "docker" && command.args[0] === "info") {
          // Functions step's `isDockerRunning()` check; "not running" keeps it on the plain
          // multipart HTTP download path instead of Docker-unbundle.
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(9500),
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              isRunning: Effect.succeed(false),
              stdin: Sink.drain,
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }
        return inner.spawn(command);
      });
    }),
  ).pipe(Layer.provide(shadow.layer));

  return { layer, shadowSpawned: shadow.spawned, gitCalls };
}

// Shared fake Postgres session for both the migration-history and db steps, since both read
// `supabase_migrations.schema_migrations`.
interface RemoteMigrationRow {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

function makeMigrationSession(
  remoteMigrations: ReadonlyArray<RemoteMigrationRow>,
  callOrder: Array<string>,
  tag: "target" | "shadow",
  /** Fails the remote-history UPSERT (the db step's "Update remote migration history table?"
   *  write), to prove `steps.db.written` still reports the migration file already on disk via
   *  `DbPullWriteError.writtenSoFar`. */
  historyUpdateFails = false,
): {
  readonly session: DbSession;
  readonly historyUpserts: ReadonlyArray<ReadonlyArray<unknown>>;
} {
  const historyUpserts: Array<ReadonlyArray<unknown>> = [];
  const exec = (_sql: string) => Effect.void;
  const query = (sql: string, params?: ReadonlyArray<unknown>) => {
    if (tag === "target" && sql.startsWith("SELECT version FROM")) {
      callOrder.push("db_list_remote");
      return Effect.succeed(remoteMigrations.map((m) => ({ version: m.version })));
    }
    if (tag === "target" && sql.includes("coalesce(name")) {
      callOrder.push("migration_history_read");
      return Effect.succeed(
        remoteMigrations.map((m) => ({
          version: m.version,
          name: m.name,
          statements: m.statements,
        })),
      );
    }
    if (params !== undefined) {
      if (historyUpdateFails) {
        return Effect.fail(
          new DbExecError({ message: "connection reset while updating migration history" }),
        );
      }
      historyUpserts.push(params);
    }
    return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
  };
  const session: DbSession = {
    exec,
    query,
    execBatch: (statements) =>
      Effect.forEach(statements, ({ sql, params }) =>
        params === undefined ? exec(sql) : query(sql, params),
      ).pipe(Effect.asVoid),
    extensionExists: () => Effect.die("extensionExists unused"),
    copyToCsv: () => Effect.die("copyToCsv unused"),
    queryRaw: () => Effect.die("queryRaw unused"),
  };
  return { session, historyUpserts };
}

const TARGET_PORT = 5432;
const AFTER_SEEDED_MIGRATIONS = Date.UTC(2026, 1, 1);

function makeDbConfigLayers(
  remoteMigrations: ReadonlyArray<RemoteMigrationRow>,
  callOrder: Array<string>,
  historyUpdateFails = false,
): {
  readonly layer: Layer.Layer<DbConfigResolver | DbConnection>;
  readonly dbConnection: Layer.Layer<DbConnection>;
  readonly historyUpserts: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly connectedPorts: ReadonlyArray<number>;
} {
  const target = makeMigrationSession(remoteMigrations, callOrder, "target", historyUpdateFails);
  const shadow = makeMigrationSession([], callOrder, "shadow");
  const connectedPorts: Array<number> = [];

  const dbConnection = Layer.succeed(DbConnection, {
    connect: (cfg: { readonly database: string; readonly port: number }) =>
      Effect.sync(() => {
        connectedPorts.push(cfg.port);
        return cfg.port === TARGET_PORT ? target.session : shadow.session;
      }),
  });

  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: ({ target }: DbConnectionInput) =>
      Effect.succeed({
        conn: {
          host: `db.${VALID_REF}.supabase.co`,
          port: TARGET_PORT,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
        ref: Option.some(VALID_REF),
        target,
      } satisfies ResolvedDbConnection),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  return {
    layer: Layer.mergeAll(dbConnection, resolver),
    dbConnection,
    historyUpserts: target.historyUpserts,
    connectedPorts,
  };
}

// Every db step forces the pg-delta engine via `[experimental.pgdelta] enabled = true` in
// `writeConfig`, so neither migra/edge-runtime nor the pg_dump initial-pull seed is reached.
interface DiffOutcome {
  readonly changes: boolean;
  readonly files?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  /** Fails the diff with a typed `PgDeltaEngineError` (an ordinary db-step failure). */
  readonly fail?: string;
  /** Dies the diff with a defect — proves `pullCaptureStep` re-raises a
   *  defect/interruption instead of ever capturing it as a per-step failure. */
  readonly die?: string;
}

function makePgDeltaEngine(diffOutcome: () => DiffOutcome): {
  readonly layer: Layer.Layer<PgDeltaEngine>;
  readonly diffCount: () => number;
} {
  let diffCount = 0;
  const layer = Layer.succeed(PgDeltaEngine, {
    diffExplicit: () => Effect.die("diffExplicit unused"),
    diffDatabase: () => {
      diffCount += 1;
      const outcome = diffOutcome();
      if (outcome.die !== undefined) {
        return Effect.die(new Error(outcome.die));
      }
      if (outcome.fail !== undefined) {
        return Effect.fail(new PgDeltaEngineError({ message: outcome.fail, cause: outcome.fail }));
      }
      const files = (outcome.files ?? []).map((file, index) => ({
        sequence: index + 1,
        name: file.name,
        suffix: null,
        sql: file.sql,
        transactionMode: "transactional" as const,
      }));
      return Effect.succeed({
        changes: outcome.changes,
        sql: files.map((file) => file.sql).join("\n"),
        files,
      });
    },
    exportDeclarativeSchema: () =>
      Effect.die("exportDeclarativeSchema unused (pull never declares --declarative)"),
    planDeclarativeSchema: () => Effect.die("planDeclarativeSchema unused"),
  });
  return { layer, diffCount: () => diffCount };
}

// Config GET, branch-by-name resolution, and the functions list/body endpoints, all routed
// through one URL-matched handler.
function multipartFixture(content: string): { readonly boundary: string; readonly body: string } {
  const boundary = "pull-test";
  return {
    boundary,
    body: [
      `--${boundary}`,
      'Content-Disposition: form-data; name="metadata"',
      "Content-Type: application/json",
      "",
      JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="source/index.ts"',
      "",
      content,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  };
}

interface ApiOpts {
  readonly configResponse?: unknown;
  readonly functionSlugs?: ReadonlyArray<string>;
  readonly functionsListStatus?: number;
  /** A transport (not status-code) failure resolving a branch-name `--remote`. */
  readonly branchNetworkFails?: boolean;
  /** Fails only this slug's `/body` download with a 500; every other slug still downloads
   *  normally, proving a partial functions-step download reports earlier slugs as written. */
  readonly functionBodyFailsForSlug?: string;
  /** Serves `GET /v1/projects`, which the project picker reads. */
  readonly projectList?: boolean;
}

function apiHandlerFor(opts: ApiOpts): ApiHandler {
  return (request) => {
    const url = request.url;
    if (opts.projectList === true && request.method === "GET" && url.endsWith("/v1/projects")) {
      return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
    }
    if (url.includes("/v2/projects/") && url.endsWith("/config")) {
      return Effect.succeed(
        jsonResponse(request, 200, opts.configResponse ?? v2ProjectConfigResponse()),
      );
    }
    if (url.includes("/v1/branches/")) {
      return Effect.succeed(jsonResponse(request, 200, {}));
    }
    if (url.includes("/branches/")) {
      if (opts.branchNetworkFails === true) {
        return Effect.fail(transportFailure(request));
      }
      return Effect.succeed(jsonResponse(request, 200, BRANCH_BY_NAME));
    }
    if (url.endsWith("/body")) {
      if (
        opts.functionBodyFailsForSlug !== undefined &&
        url.includes(`/functions/${opts.functionBodyFailsForSlug}/body`)
      ) {
        return Effect.succeed(jsonResponse(request, 500, "download failed"));
      }
      const { boundary, body } = multipartFixture("console.log('pull');\n");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: 200,
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          }),
        ),
      );
    }
    if (url.endsWith("/functions")) {
      if (opts.functionsListStatus !== undefined && opts.functionsListStatus !== 200) {
        return Effect.succeed(
          jsonResponse(request, opts.functionsListStatus, "list functions failed"),
        );
      }
      return Effect.succeed(
        jsonResponse(
          request,
          200,
          (opts.functionSlugs ?? []).map((slug) => ({ slug })),
        ),
      );
    }
    return Effect.succeed(jsonResponse(request, 200, {}));
  };
}

const makeApiMock = (opts: ApiOpts) => mockCommandPlatformApi({ handler: apiHandlerFor(opts) });

// A real captured `Stdio` layer — only json/stream-json envelope tests need it, since
// `MachineErrorContext` merging lives inside the real output layers' `fail`/`success`
// implementations, which `mockOutput` never replicates.
function mockCapturingStdio(args: ReadonlyArray<string>) {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const decode = (item: string | Uint8Array) =>
    typeof item === "string" ? item : new TextDecoder().decode(item);
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed(args),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) => Effect.sync(() => stdout.push(decode(item)))),
      stderr: () =>
        Sink.forEach((item: string | Uint8Array) => Effect.sync(() => stderr.push(decode(item)))),
    }),
  );
  return { layer, stdout, stderr };
}

/**
 * Wraps `base` so every `promptConfirm` call first runs `onConfirm` before delegating to the
 * real mock — simulates a concurrent edit landing on `supabase/config.toml` while the
 * orchestrator's confirmation prompt is on screen (the config step's TOCTOU guard).
 */
function withConfirmSideEffect(
  base: Layer.Layer<Output>,
  onConfirm: Effect.Effect<void, PlatformError.PlatformError>,
): Layer.Layer<Output> {
  return Layer.effect(
    Output,
    Effect.gen(function* () {
      const inner = yield* Output;
      return {
        ...inner,
        // `promptConfirm` has no error channel to carry a fixture write failure, and a
        // fixture that cannot write is a broken test rather than a pull disposition.
        promptConfirm: (message: string, promptOpts?: { defaultValue?: boolean }) =>
          onConfirm.pipe(Effect.orDie, Effect.andThen(inner.promptConfirm(message, promptOpts))),
      };
    }),
  ).pipe(Layer.provide(base));
}

interface SetupOpts {
  readonly outputFlag?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
  readonly yes?: boolean;
  readonly stdinIsTty?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly gitDirty?: boolean;
  readonly gitDirtyMigrations?: boolean;
  readonly gitDirtyFunctions?: boolean;
  readonly gitSpawnFails?: boolean;
  readonly api?: ApiOpts;
  readonly remoteMigrations?: ReadonlyArray<RemoteMigrationRow>;
  readonly diffOutcome?: () => DiffOutcome;
  /** Fails the db step's own remote-history UPSERT after the migration file has already been
   *  written to disk. */
  readonly dbHistoryUpdateFails?: boolean;
  /** Runs as a side effect of the orchestrator's consent prompt, before it
   *  resolves — simulates a concurrent edit to `supabase/config.toml` while that prompt is on
   *  screen (text-mode, interactive TTY only). */
  readonly confirmSideEffect?: Effect.Effect<void, PlatformError.PlatformError>;
  /** Overrides `cliSettings.workdir` — defaults to the temp project root. */
  readonly workdir?: string;
  /** Overrides the global `--experimental` flag — defaults to `false`. */
  readonly experimental?: boolean;
  /** Runs the real database config resolver and linked-project cache, so their Management API
   *  calls are recorded. The direct database host is unreachable unless a test opts in. */
  readonly realLayers?: boolean;
  /** Overrides the linked project ref in settings — defaults to `Some(VALID_REF)`. */
  readonly projectId?: Option.Option<string>;
  /** Serves `GET /v1/projects` and answers the project picker with `VALID_REF`. */
  readonly picksProject?: boolean;
  /** The argv the deprecation warnings render their replacement command from. */
  readonly cliArgs?: ReadonlyArray<string>;
}

interface MachineSetupOpts extends SetupOpts {
  readonly format: "json" | "stream-json";
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: "text",
    promptConfirmResponses: opts.confirm,
    ...(opts.picksProject === true ? { promptSelectResponses: [VALID_REF] } : {}),
  });
  const outputLayer =
    opts.confirmSideEffect === undefined
      ? out.layer
      : withConfirmSideEffect(out.layer, opts.confirmSideEffect);
  return {
    ...setupRuntime(opts, outputLayer, Stdio.layerTest({ args: Effect.succeed(["pull"]) })),
    out,
  };
}

function setupMachine(opts: MachineSetupOpts) {
  const capturingStdio = mockCapturingStdio(["pull"]);
  const outputLayer = (opts.format === "json" ? jsonOutputLayer : streamJsonOutputLayer).pipe(
    Layer.provide(capturingStdio.layer),
  );
  return { ...setupRuntime(opts, outputLayer, capturingStdio.layer), capturingStdio };
}

function setupSubstrate(
  opts: SetupOpts,
  outputLayer: Layer.Layer<Output>,
  stdioLayer: Layer.Layer<Stdio.Stdio>,
) {
  const spawner = composeSpawner({
    gitDirty: opts.gitDirty,
    gitDirtyMigrations: opts.gitDirtyMigrations,
    gitDirtyFunctions: opts.gitDirtyFunctions,
    gitSpawnFails: opts.gitSpawnFails,
  });
  const callOrder: Array<string> = [];
  const dbConfig = makeDbConfigLayers(
    opts.remoteMigrations ?? [],
    callOrder,
    opts.dbHistoryUpdateFails ?? false,
  );
  const pgDelta = makePgDeltaEngine(opts.diffOutcome ?? (() => ({ changes: false })));

  const workdir = opts.workdir ?? tempRoot.current;

  const layer = Layer.mergeAll(
    configValuesLayer({ output: outputLayer }),
    machineErrorContextLayer,
    commandRuntimeLayer(["pull"]).pipe(Layer.provide(BunServices.layer)),
    stdioLayer,
    opts.realLayers === true
      ? Layer.mergeAll(
          dbConfig.dbConnection,
          realDbConfigResolver({
            workdir,
            dbConnection: dbConfig.dbConnection,
            env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
          }),
        )
      : dbConfig.layer,
    pgDelta.layer,
    Layer.succeed(EdgeRuntimeScript, {
      run: () => Effect.die("migra edge runtime unused — every db step forces pg-delta"),
    }),
    Layer.succeed(BundledPostgresClient, {
      run: () => Effect.die("bundled postgres client unused"),
    }),
    Layer.succeed(DockerRun, {
      run: () => Effect.die("run unused"),
      runCapture: () => Effect.die("runCapture unused"),
      runStream: (runOpts) =>
        runOpts.skipImageResolve === true
          ? Effect.succeed({ exitCode: 0, stderr: "" })
          : Effect.die("runStream unused — pg-delta initial pulls skip the pg_dump seed"),
    }),
    Layer.succeed(PgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(NetworkIdFlag, Option.none()),
    unusedStackServices,
    spawner.layer,
    shadowCacheDisabledLayer,
  );

  return { layer, spawner, dbConfig, pgDelta, callOrder };
}

function setupRuntime(
  opts: SetupOpts,
  outputLayer: Layer.Layer<Output>,
  stdioLayer: Layer.Layer<Stdio.Stdio>,
) {
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const processControl = mockProcessControl();
  const analytics = mockContextualAnalytics();

  const api = makeApiMock({
    ...opts.api,
    ...(opts.picksProject === true ? { projectList: true } : {}),
  });
  const projectHttp = recordingProjectHttpClient(VALID_REF);
  const substrate = setupSubstrate(opts, outputLayer, stdioLayer);

  const workdir = opts.workdir ?? tempRoot.current;
  const cliSettings = mockCommandSettings({
    workdir,
    projectId: opts.projectId ?? Option.some(VALID_REF),
    ...(opts.realLayers === true ? { projectHost: "invalid" } : {}),
  });

  const layer = Layer.mergeAll(
    buildTestRuntime({
      out: { layer: outputLayer },
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      stdin: mockStdin(opts.stdinIsTty ?? false),
      runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache:
        opts.realLayers === true
          ? realLinkedProjectCache({
              httpClient: projectHttp.layer,
              cliSettings: mockCommandSettings({ workdir }),
            })
          : linkedProjectCache.layer,
      processControl: { layer: processControl.layer },
      analytics: { layer: analytics.layer },
      outputFlag: opts.outputFlag ?? Option.none(),
    }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    // Listed after `buildTestRuntime` so its spawner overrides the real one `BunServices.layer`
    // provides (last-wins).
    substrate.layer,
  );

  return {
    layer,
    api,
    telemetry,
    linkedProjectCache,
    processControl,
    analytics,
    spawner: substrate.spawner,
    dbConfig: substrate.dbConfig,
    pgDelta: substrate.pgDelta,
    callOrder: substrate.callOrder,
    projectHttp,
  };
}

describe("pull integration", () => {
  it.effect(
    "bootstraps a fresh checkout: migration history auto-runs, config/functions/db all report changed",
    () => {
      const { layer, out, telemetry, analytics } = setup({
        yes: true,
        api: { functionSlugs: ["hello"] },
        remoteMigrations: [
          { version: "20260101000000", name: "init", statements: ["create table foo ();"] },
        ],
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
        }),
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
        yield* writeConfig("[api]\nmax_rows = 500\n");
        yield* runPull(pullFlags());

        expect(yield* readConfigFile).toContain("max_rows = 1000");
        expect(yield* projectFileExists("supabase", "migrations", "20260101000000_init.sql")).toBe(
          true,
        );
        expect((yield* listMigrations).length).toBeGreaterThan(1);
        expect(yield* projectFileExists("supabase", "functions", "hello", "index.ts")).toBe(true);

        expect(stepLine(out.stdoutText, "config")).toContain("changed");
        expect(stepLine(out.stdoutText, "migration_history")).toContain("changed");
        expect(stepLine(out.stdoutText, "db")).toContain("changed");
        expect(stepLine(out.stdoutText, "functions")).toContain("changed");

        expect(telemetry.flushed).toBe(true);
        const executed = analytics.captured.filter((c) => c.event === "cli_command_executed");
        expect(executed).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "bootstraps a fresh checkout with --output-format json: exactly one JSON object with all four step keys",
    () => {
      const { layer, capturingStdio, dbConfig, linkedProjectCache } = setupMachine({
        format: "json",
        yes: true,
        api: { functionSlugs: ["hello"] },
        remoteMigrations: [
          { version: "20260101000000", name: "init", statements: ["create table foo ();"] },
        ],
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
        }),
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
        yield* writeConfig("[api]\nmax_rows = 500\n");
        yield* runPull(pullFlags());

        expect(capturingStdio.stdout).toHaveLength(1);
        const payload = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(payload["steps"]).toEqual({
          config: expect.objectContaining({ status: "changed" }),
          migration_history: expect.objectContaining({ status: "changed" }),
          db: expect.objectContaining({
            status: "changed",
            detail: expect.objectContaining({ remote_history_updated: true }),
          }),
          functions: expect.objectContaining({ status: "changed" }),
        });
        expect(payload["wrote"]).toBe(true);

        expect(dbConfig.historyUpserts.length).toBeGreaterThan(0);

        expect(linkedProjectCache.cached).toBe(true);
        expect(linkedProjectCache.cachedRef).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the json payload's target keeps project_ref and adds kind, project_name and environment",
    () => {
      const { layer, capturingStdio } = setupMachine({
        format: "json",
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(yield* projectPath("supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(
          yield* projectPath("supabase", ".temp", "linked-project.json"),
          `{"ref":"${VALID_REF}","name":"Acme"}`,
        );
        yield* runPull(pullFlags());

        const payload = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(payload["target"]).toEqual({
          kind: "linked",
          project_ref: VALID_REF,
          project_name: "Acme",
          environment: "production",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a branch-name --remote reports the branch and its parent in the json target", () => {
    const { layer, capturingStdio } = setupMachine({
      format: "json",
      yes: true,
      remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
    });
    return Effect.gen(function* () {
      yield* writeConfig();
      yield* seedLocalMigration("20260101000000");
      yield* runPull(pullFlags({ remote: branchRemote("staging") }));

      const payload = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
      expect(payload["target"]).toEqual({
        kind: "linked",
        project_ref: BRANCH_REF,
        environment: "branch",
        parent_project_ref: VALID_REF,
        branch: "staging",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "renders the config diff body (not 'No config differences found.') when the only diff is skipped as an env() reference",
    () => {
      // Every other managed field sits at its schema default, so `auth.site_url` is the only
      // change in the changeset — and, being declared as `env(SITE_URL)`, it's skipped rather
      // than written, leaving `runPlan.hasWork` false even though a real (unwritable) diff exists.
      const { layer, out } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* writeConfig('[auth]\nsite_url = "env(SITE_URL)"\n');
        yield* writeProjectEnv("SITE_URL=https://local.example.com\n");
        yield* runPull(pullFlags());

        expect(out.stdoutText).not.toContain("No config differences found.");
        expect(out.stdoutText).toContain("auth.site_url [update, skip: env() reference]");
        expect(stepLine(out.stdoutText, "config")).toContain("unchanged");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("--project-ref still resolves a branch name and warns to use --remote", () => {
    const { layer, out } = setup({
      yes: true,
      cliArgs: ["pull", "--project-ref", "staging"],
    });
    return Effect.gen(function* () {
      yield* writeConfig();
      yield* runPull(pullFlags({ projectRef: Option.some("staging"), dryRun: true }));
      expect(warningsOf(out)).toEqual([
        "--project-ref is deprecated and will be removed in v4. Use --remote instead: supabase pull --remote=staging",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--remote=<url> is rejected before any request", () => {
    const { layer, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* writeConfig();
      const error = yield* runPull(
        pullFlags({
          remote: Option.some<RemoteValue>({
            _tag: "DbUrl",
            url: "postgresql://postgres:pw@db.example.com:5432/postgres",
          }),
          dryRun: true,
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TargetNeedsProjectError",
        message: "`supabase pull` needs a project, not a database URL.",
      });
      expect(api.requests).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layer, commandRuntimeLayer(["pull"]).pipe(Layer.provide(BunServices.layer))),
      ),
    );
  });

  it.effect(
    "a branch-name --remote resolves exactly once: one branch lookup, one config GET, no picker prompt",
    () => {
      const { layer, out, api } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags({ remote: branchRemote("staging") }));

        const branchLookups = api.requests.filter((request) => request.url.includes("/branches/"));
        expect(branchLookups).toHaveLength(1);
        const configLookups = api.requests.filter((request) => request.url.endsWith("/config"));
        expect(configLookups).toHaveLength(1);
        expect(out.promptSelectCalls).toHaveLength(0);
        assertPermissionDrift({
          command: "pull",
          activeFlags: { ...STEP_SWITCHES, remote: "staging" },
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "on an interactive TTY with real diffs, the confirmation prompt appears exactly once",
    () => {
      const { layer, out } = setup({
        stdinIsTty: true,
        confirm: [true],
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig("[api]\nmax_rows = 500\n");
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags());

        expect(out.promptConfirmCalls).toHaveLength(1);
        expect(out.promptConfirmCalls[0]?.message).toContain(CONSENT_ACTION);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the single confirmation suppresses BOTH sub-step prompts, and both underlying writes still complete: db updates remote history, migration fetch overwrites the pre-existing file",
    () => {
      const { layer, out, dbConfig } = setup({
        stdinIsTty: true,
        confirm: [true],
        remoteMigrations: [
          {
            version: "20260101000000",
            name: "init",
            statements: ["create table remote_only ();"],
          },
        ],
        // Real schema drift: `db pull`'s remote-history-update prompt only fires when the
        // diff actually writes a migration file.
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table remote_only add column bar text;" }],
        }),
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
        yield* writeConfig("[api]\nmax_rows = 500\n");
        // Shares the remote row's exact version+name: `migration fetch`'s overwrite prompt only
        // fires when `supabase/migrations` is non-empty, and this file is what gets clobbered.
        const preExisting = yield* seedLocalMigration(
          "20260101000000",
          "init",
          "create table local_only ();\n",
        );
        // `--with-migration-history` over an already-populated directory is the other
        // condition (besides real db drift) that would make both sub-prompts reachable if
        // `assumeYes` didn't suppress them.
        yield* runPull(pullFlags({ withMigrationHistory: true }));

        expect(out.promptConfirmCalls).toHaveLength(1);
        expect(out.promptConfirmCalls[0]?.message).toContain(CONSENT_ACTION);

        const rewritten = yield* readTextFile(preExisting);
        expect(rewritten).toContain("create table remote_only");
        expect(rewritten).not.toContain("create table local_only");

        expect(dbConfig.historyUpserts.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("--dry-run writes nothing and reports every step planned/skipped", () => {
    const before =
      'project_id = "test"\n\n[experimental.pgdelta]\nenabled = true\n[api]\nmax_rows = 500\n';
    const { layer, out, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* writeConfigFile(before);
      const exit = yield* Effect.exit(runPull(pullFlags({ dryRun: true })));
      expect(Exit.isSuccess(exit)).toBe(true);

      expect(yield* readConfigFile).toBe(before);
      expect(yield* projectFileExists("supabase", "migrations")).toBe(false);
      expect(api.requests.some((request) => request.method !== "GET")).toBe(false);
      assertPermissionDrift({
        command: "pull",
        activeFlags: { ...STEP_SWITCHES, "dry-run": true },
        requests: api.requests,
      });

      expect(stepLine(out.stdoutText, "config")).toContain("planned");
      expect(stepLine(out.stdoutText, "migration_history")).toContain("planned");
      expect(stepLine(out.stdoutText, "db")).toContain("planned");
      expect(stepLine(out.stdoutText, "functions")).toContain("planned");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a --dry-run --output-format json payload surfaces dirty_paths, even though the dry-run itself never runs the abort logic that would otherwise trip on them",
    () => {
      const { layer, capturingStdio } = setupMachine({ format: "json", yes: true, gitDirty: true });
      return Effect.gen(function* () {
        yield* writeConfig("[api]\nmax_rows = 500\n");
        const exit = yield* Effect.exit(runPull(pullFlags({ dryRun: true })));
        expect(Exit.isSuccess(exit)).toBe(true);

        const payload = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(payload["dirty_paths"]).toEqual(["supabase/config.toml"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a clean-tree run reports an empty dirty_paths array in the JSON payload, present on every disposition",
    () => {
      const { layer, capturingStdio } = setupMachine({
        format: "json",
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags());
        const payload = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(payload["dirty_paths"]).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("declining the consent prompt aborts before any step writes", () => {
    const { layer, out, api, dbConfig } = setup({
      stdinIsTty: true,
      confirm: [false],
      remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
      diffOutcome: () => ({
        changes: true,
        files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
      }),
    });
    return Effect.gen(function* () {
      yield* writeConfig("[api]\nmax_rows = 500\n");
      const before = yield* readConfigFile;
      const error = yield* Effect.flip(runPull(pullFlags()));
      expect(error).toBeInstanceOf(HostedMutationDeclinedError);

      expect(yield* readConfigFile).toBe(before);
      expect(yield* projectFileExists("supabase", "migrations")).toBe(false);
      expect(yield* projectFileExists("supabase", "functions")).toBe(false);
      expect(dbConfig.historyUpserts).toHaveLength(0);
      expect(api.requests.some((request) => request.method !== "GET")).toBe(false);
      expect(out.stdoutText).not.toContain("Pull summary");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a functions-step failure still reports every other step, exits non-zero, with exactly one JSON envelope",
    () => {
      const { layer, capturingStdio, processControl, telemetry, linkedProjectCache } = setupMachine(
        {
          format: "json",
          yes: true,
          api: { functionsListStatus: 500 },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        },
      );
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags());

        expect(capturingStdio.stdout).toHaveLength(1);
        const envelope = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(envelope["_tag"]).toBe("Error");
        expect(envelope["steps"]).toMatchObject({
          config: { status: expect.not.stringMatching(/^failed$/) },
          migration_history: { status: expect.not.stringMatching(/^failed$/) },
          db: { status: expect.not.stringMatching(/^failed$/) },
          functions: { status: "failed", failure: { message: expect.stringContaining("500") } },
        });
        expect(processControl.exitCode).toBe(1);

        expect(linkedProjectCache.cached).toBe(true);
        expect(linkedProjectCache.cachedRef).toBe(VALID_REF);
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a steady-state pull (no config drift, no schema drift, no functions) exits 0 with every step non-failed",
    () => {
      const { layer, out } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isSuccess(exit)).toBe(true);

        expect(stepLine(out.stdoutText, "config")).toContain("unchanged");
        expect(stepLine(out.stdoutText, "migration_history")).toContain("skipped");
        expect(stepLine(out.stdoutText, "migration_history")).toContain("not_needed");
        expect(stepLine(out.stdoutText, "db")).toContain("unchanged");
        expect(stepLine(out.stdoutText, "functions")).toContain("unchanged");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "--remote-label creates the named [remotes.*] block even on an otherwise zero-drift config",
    () => {
      const { layer } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags({ remoteLabel: Option.some("customname") }));
        expect(yield* readConfigFile).toContain("[remotes.customname]");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an empty-string --remote-label is treated as not provided: no forced [remotes.*] block on an otherwise zero-drift config",
    () => {
      const { layer, out } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags({ remoteLabel: Option.some("") }));
        expect(stepLine(out.stdoutText, "config")).toContain("unchanged");
        expect(yield* readConfigFile).not.toContain("[remotes.");
      }).pipe(Effect.provide(layer));
    },
  );

  describe("dirty supabase/config.toml", () => {
    it.effect("interactive TTY: the prompt defaults to decline", () => {
      const { layer, out } = setup({ stdinIsTty: true, confirm: [false], gitDirty: true });
      return Effect.gen(function* () {
        yield* writeConfig("[api]\nmax_rows = 500\n");
        const before = yield* readConfigFile;
        expect(yield* Effect.flip(runPull(pullFlags()))).toBeInstanceOf(
          HostedMutationDeclinedError,
        );
        expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
        expect(yield* readConfigFile).toBe(before);
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "--yes on a dirty tree aborts with the uncommitted-changes error, no prompt shown",
      () => {
        const { layer, out } = setup({ yes: true, gitDirty: true });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          const before = yield* readConfigFile;
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("PullUncommittedChangesError");
          }
          expect(out.promptConfirmCalls).toHaveLength(0);
          expect(yield* readConfigFile).toBe(before);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("--output-format json on a dirty tree aborts without --yes and without a TTY", () => {
      const { layer, capturingStdio, processControl } = setupMachine({
        format: "json",
        gitDirty: true,
      });
      return Effect.gen(function* () {
        yield* writeConfig("[api]\nmax_rows = 500\n");
        yield* runPull(pullFlags());
        expect(capturingStdio.stdout).toHaveLength(1);
        const envelope = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(envelope["error"]).toMatchObject({ code: "PullUncommittedChangesError" });
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "a non-interactive text terminal (piped stdin) on a dirty tree aborts without prompting",
      () => {
        const { layer, out } = setup({ stdinIsTty: false, gitDirty: true });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("PullUncommittedChangesError");
          }
          expect(out.promptConfirmCalls).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "--force proceeds and writes despite all three locations being dirty, never even checking git",
      () => {
        const { layer, spawner } = setup({
          yes: true,
          gitDirty: true,
          gitDirtyMigrations: true,
          gitDirtyFunctions: true,
        });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* runPull(pullFlags({ force: true }));
          expect(yield* readConfigFile).toContain("max_rows = 1000");
          expect(spawner.gitCalls).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("a git spawn failure degrades to 'not dirty' rather than blocking the pull", () => {
      const { layer } = setup({ yes: true, gitSpawnFails: true });
      return Effect.gen(function* () {
        yield* writeConfig("[api]\nmax_rows = 500\n");
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* readConfigFile).toContain("max_rows = 1000");
      }).pipe(Effect.provide(layer));
    });
  });

  // Checked unconditionally (skipped only by --force): the db step always runs with no preview
  // machinery, so this fires regardless of whether migration-history itself runs.
  describe("dirty supabase/migrations", () => {
    it.effect(
      "already-populated, no --with-migration-history pending: still aborts without --force (the db step might still write there)",
      () => {
        const { layer } = setup({
          yes: true,
          gitDirtyMigrations: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("PullUncommittedChangesError");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a fresh checkout with migration-history bootstrap pending: also aborts without --force",
      () => {
        const { layer } = setup({
          yes: true,
          gitDirtyMigrations: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("PullUncommittedChangesError");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "interactive TTY: the prompt defaults to decline and the confirmation body names supabase/migrations",
      () => {
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [false],
          gitDirtyMigrations: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          expect(yield* Effect.flip(runPull(pullFlags()))).toBeInstanceOf(
            HostedMutationDeclinedError,
          );
          expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
          expect(out.stdoutText).toContain(
            "supabase/migrations has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  // Checked unconditionally (skipped only by --force), same as migrations, since the functions
  // step always runs with no "does it have work" signal without calling the API first.
  describe("dirty supabase/functions", () => {
    it.effect("aborts without --force, even with zero config/db drift", () => {
      const { layer } = setup({
        yes: true,
        gitDirtyFunctions: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("PullUncommittedChangesError");
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "interactive TTY: the prompt defaults to decline and the confirmation body names supabase/functions",
      () => {
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [false],
          gitDirtyFunctions: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          expect(yield* Effect.flip(runPull(pullFlags()))).toBeInstanceOf(
            HostedMutationDeclinedError,
          );
          expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
          expect(out.stdoutText).toContain(
            "supabase/functions has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("multiple dirty locations at once", () => {
    it.effect(
      "config AND functions dirty together: the confirmation body names both, config before functions",
      () => {
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [false],
          gitDirty: true,
          gitDirtyFunctions: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* seedLocalMigration("20260101000000");
          expect(yield* Effect.flip(runPull(pullFlags()))).toBeInstanceOf(
            HostedMutationDeclinedError,
          );
          expect(out.stdoutText).toContain(
            "supabase/config.toml and supabase/functions have uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "all three dirty at once: the abort error names all three, in config, migrations, functions order",
      () => {
        const { layer } = setup({
          yes: true,
          gitDirty: true,
          gitDirtyMigrations: true,
          gitDirtyFunctions: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "supabase/config.toml, supabase/migrations, and supabase/functions have uncommitted or untracked changes",
            );
          }
        }).pipe(Effect.provide(layer));
      },
    );
  });

  it.effect(
    "the db step's shadow setup observes the config step's own db.major_version write, not the stale pre-pull value",
    () => {
      const { layer, spawner } = setup({
        yes: true,
        api: {
          configResponse: v2ProjectConfigResponse({
            attributes: (attributes) => ({
              ...attributes,
              database: {
                ...Schema.decodeUnknownSync(jsonRecord)(attributes["database"]),
                major_version: 15,
              },
            }),
          }),
        },
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig("[db]\nmajor_version = 14\n");
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags());

        expect(yield* readConfigFile).toContain("major_version = 15");
        const createCalls = spawner.shadowSpawned.filter((call) => call.args[0] === "create");
        expect(createCalls.length).toBeGreaterThan(0);
        const createArgs = createCalls.flatMap((call) => call.args);
        expect(createArgs.some((arg) => /supabase\/postgres:15\./.test(arg))).toBe(true);
        expect(createArgs.some((arg) => /supabase\/postgres:14\./.test(arg))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the db step pulls migrations when --experimental or SUPABASE_EXPERIMENTAL is set",
    () => {
      const { layer, out } = setup({
        yes: true,
        experimental: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
        }),
      });
      return withConfigEnv(
        { SUPABASE_EXPERIMENTAL: "true" },
        Effect.gen(function* () {
          yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isSuccess(exit)).toBe(true);

          expect((yield* listMigrations).length).toBeGreaterThan(1);
          expect(yield* projectFileExists("supabase", "schemas")).toBe(false);
          expect(stepLine(out.stdoutText, "db")).toContain("changed");
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect(
    "the migration-history step's remote read happens before the db step's own remote read",
    () => {
      const { layer, callOrder } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* runPull(pullFlags());

        expect(yield* projectFileExists("supabase", "migrations", "20260101000000_init.sql")).toBe(
          true,
        );
        expect(callOrder).toContain("migration_history_read");
        expect(callOrder).toContain("db_list_remote");
        expect(callOrder.indexOf("migration_history_read")).toBeLessThan(
          callOrder.indexOf("db_list_remote"),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "supabase pull -o json fails with a message pointing at --output-format, not a machine payload",
    () => {
      const { layer, api } = setup({ outputFlag: Option.some("json") });
      return Effect.gen(function* () {
        yield* writeConfig();
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("PullOutputFlagUnsupportedError");
          expect(causeText).toContain("--output-format");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a --workdir naming a directory that does not exist fails before any target resolution",
    () =>
      Effect.gen(function* () {
        const missing = yield* projectPath("does-not-exist");
        const { layer, api, telemetry, linkedProjectCache } = setup({ workdir: missing });
        const exit = yield* Effect.exit(runPull(pullFlags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("PullWorkdirError");
        }
        expect(api.requests).toHaveLength(0);

        expect(telemetry.flushed).toBe(true);
        expect(linkedProjectCache.cached).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a network failure resolving a branch-name --remote fails with a network error, not a status error",
    () => {
      const { layer } = setup({ api: { branchNetworkFails: true } });
      return Effect.gen(function* () {
        yield* writeConfig();
        const exit = yield* Effect.exit(runPull(pullFlags({ remote: branchRemote("staging") })));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("PullBranchResolveNetworkError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a supabase/migrations read failure that is NOT 'missing' (a plain file colliding with the directory) fails with a read error, instead of silently treating it as empty",
    () => {
      const { layer } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* writeConfig();
        // `fs.readDirectory` against a plain file fails with ENOTDIR, not "NotFound" — the
        // bootstrap-detection read must propagate this instead of treating it as "no migrations
        // yet".
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(yield* migrationsDir, "not a directory");
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("MigrationsReadError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  describe("migration-history auto-run vs --with-migration-history", () => {
    it.effect(
      "supabase/migrations already has files and the flag is not set: skipped as not_needed",
      () => {
        const { layer, out } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          yield* runPull(pullFlags());
          expect(stepLine(out.stdoutText, "migration_history")).toContain("not_needed");
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "supabase/migrations already has files but --with-migration-history is set: the step actually runs",
      () => {
        const { layer, out } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
            { version: "20260102000000", name: "second", statements: ["select 2;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          // Named "init" to match the remote row below, so the fetch rewrites this file instead
          // of leaving a stale differently-named duplicate under the same version.
          yield* seedLocalMigration("20260101000000", "init");
          yield* runPull(pullFlags({ withMigrationHistory: true }));
          expect(
            yield* projectFileExists("supabase", "migrations", "20260102000000_second.sql"),
          ).toBe(true);
          expect(stepLine(out.stdoutText, "migration_history")).toContain("changed");
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "supabase/migrations is missing entirely: the step auto-runs (bootstrap reason)",
      () => {
        const { layer, out } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* runPull(pullFlags());
          expect(out.stdoutText).toContain("supabase/migrations has no migration files");
          expect(
            yield* projectFileExists("supabase", "migrations", "20260101000000_init.sql"),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("per-step failure isolation", () => {
    it.effect(
      "a config-step failure (a concurrent edit during the confirmation prompt) still runs migration_history/db/functions, in text mode",
      () => {
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [true],
          // Keeps `[experimental.pgdelta] enabled = true` intact, so this exercises the config
          // step's TOCTOU guard rather than routing the db step onto the unmocked migra path.
          confirmSideEffect: writeConfigFile(
            'project_id = "changed-mid-flight"\n\n[experimental.pgdelta]\nenabled = true\n',
          ).pipe(Effect.provide(BunServices.layer)),
          api: { functionSlugs: ["hello"] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("ConfigPullFileChangedError");
          }

          expect(stepLine(out.stdoutText, "config")).toContain("failed");
          expect(stepLine(out.stdoutText, "migration_history")).toContain("not_needed");
          expect(stepLine(out.stdoutText, "db")).toContain("unchanged");
          expect(stepLine(out.stdoutText, "functions")).toContain("changed");

          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase config pull --remote=${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a config-step failure carries --remote-label through to its own retry hint when one was passed",
      () => {
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [true],
          confirmSideEffect: writeConfigFile(
            'project_id = "changed-mid-flight"\n\n[experimental.pgdelta]\nenabled = true\n',
          ).pipe(Effect.provide(BunServices.layer)),
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(
            runPull(pullFlags({ remoteLabel: Option.some("staging-remote") })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(stepLine(out.stdoutText, "config")).toContain("failed");

          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase config pull --remote-label 'staging-remote' --remote=${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a branch-derived implicit remote-block target: the config step's retry hint names that SAME derived label, even though --remote-label was never passed",
      () => {
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [true],
          // Concurrent edit during the confirmation prompt trips the config step's TOCTOU
          // guard before the planned `[remotes.staging]` block (implicit target;
          // --remote-label was never passed) is ever written.
          confirmSideEffect: writeConfigFile(
            'project_id = "changed-mid-flight"\n\n[experimental.pgdelta]\nenabled = true\n',
          ).pipe(Effect.provide(BunServices.layer)),
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags({ remote: branchRemote("staging") })));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(stepLine(out.stdoutText, "config")).toContain("failed");
          expect(yield* readConfigFile).not.toContain("[remotes.staging]");

          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase config pull --remote-label 'staging' --remote=${BRANCH_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a migration-history-step failure (a hostile remote history row) still runs config/functions, and re-fails with its OWN (first) cause even though db also fails downstream",
      () => {
        const { layer, out } = setup({
          yes: true,
          api: { functionSlugs: [] },
          // A path-traversal `name` trips `runMigrationFetch`'s injection guard (CWE-22): a
          // real, reachable write failure that also cascades into a db-step reconciliation
          // conflict.
          remoteMigrations: [
            { version: "20260101000000", name: "../evil", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons.every(Cause.isFailReason)).toBe(true);
            const failures = exit.cause.reasons
              .filter(Cause.isFailReason)
              .map((reason) => reason.error);
            expect(failures.some((error) => error instanceof MigrationFetchWriteError)).toBe(true);
            expect(failures.some((error) => error instanceof DbPullMigrationConflictError)).toBe(
              false,
            );
          }

          expect(stepLine(out.stdoutText, "config")).toContain("unchanged");
          expect(stepLine(out.stdoutText, "migration_history")).toContain("failed");
          expect(stepLine(out.stdoutText, "db")).toContain("failed");
          expect(stepLine(out.stdoutText, "functions")).toContain("unchanged");

          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase migration fetch --remote=${VALID_REF}`,
          );
          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase db pull --experimental=false --remote=${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a migration-history-step failure AFTER an earlier row already wrote reports that file as written, not written: [] (a real partial-write case)",
      () => {
        const { layer, capturingStdio } = setupMachine({
          format: "json",
          yes: true,
          api: { functionSlugs: [] },
          // The first row writes successfully; the second row's path-traversal `name` trips
          // the write loop's injection guard (CWE-22) only once the first row is already on
          // disk.
          remoteMigrations: [
            { version: "20260101000000", name: "good", statements: ["select 1;"] },
            { version: "20260102000000", name: "../evil", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* runPull(pullFlags());

          expect(
            yield* projectFileExists("supabase", "migrations", "20260101000000_good.sql"),
          ).toBe(true);

          const envelope = yield* Schema.decodeUnknownEffect(jsonEnvelope)(
            capturingStdio.stdout[0],
          );
          expect(envelope["steps"]).toMatchObject({
            migration_history: {
              status: "failed",
              written: ["supabase/migrations/20260101000000_good.sql"],
            },
          });

          expect(envelope["wrote"]).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a db-step failure (a pg-delta engine error) still runs config/migration_history/functions",
      () => {
        const { layer, out } = setup({
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false, fail: "boom: pg-delta blew up" }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("PgDeltaEngineError");
          }

          expect(stepLine(out.stdoutText, "config")).toContain("unchanged");
          expect(stepLine(out.stdoutText, "migration_history")).toContain("not_needed");
          expect(stepLine(out.stdoutText, "db")).toContain("failed");
          expect(stepLine(out.stdoutText, "functions")).toContain("unchanged");

          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase db pull --experimental=false --remote=${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a db-step migration-conflict failure carries BOTH the --with-migration-history hint AND the generic retry hint, in that order",
      () => {
        const { layer, capturingStdio } = setupMachine({
          format: "json",
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260103000000", name: "remote-only", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          // A local file that doesn't match the remote history row trips `db pull`'s own
          // `DbPullMigrationConflictError`, since `reconcileMigrations` treats any non-matching
          // version as a conflict.
          yield* seedLocalMigration("20260101000000");
          yield* runPull(pullFlags());

          const envelope = yield* Schema.decodeUnknownEffect(dbStepFailureEnvelope)(
            capturingStdio.stdout[0],
          );
          expect(envelope.steps.db.status).toBe("failed");
          expect(envelope.steps.db.failure.code).toBe("DbPullMigrationConflictError");

          const suggestion = envelope.steps.db.failure.suggestion;
          const migrationHistoryHintIndex = suggestion.indexOf(
            `Alternatively, rerun \`supabase pull --with-migration-history --remote=${VALID_REF}\``,
          );
          const retryHintIndex = suggestion.indexOf(
            `To retry just this step, run: supabase db pull --experimental=false --remote=${VALID_REF}`,
          );
          expect(migrationHistoryHintIndex).toBeGreaterThan(-1);
          expect(retryHintIndex).toBeGreaterThan(migrationHistoryHintIndex);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a db-step migration-conflict failure's --with-migration-history remedy also carries a shell-quoted --remote-label when one was passed",
      () => {
        const { layer, capturingStdio } = setupMachine({
          format: "json",
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260103000000", name: "remote-only", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          yield* runPull(pullFlags({ remoteLabel: Option.some("staging remote") }));

          const envelope = yield* Schema.decodeUnknownEffect(dbStepFailureEnvelope)(
            capturingStdio.stdout[0],
          );
          expect(envelope.steps.db.failure.suggestion).toContain(
            `Alternatively, rerun \`supabase pull --with-migration-history --remote-label 'staging remote' --remote=${VALID_REF}\``,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a db-step failure AFTER the migration file already wrote, but the remote-history update failed, reports that file as written (a real partial-write case)",
      () => {
        const { layer, capturingStdio } = setupMachine({
          format: "json",
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          // Real schema drift, so the db step actually writes a migration file
          // before the remote-history UPSERT (mocked to fail below) ever runs.
          diffOutcome: () => ({
            changes: true,
            files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
          }),
          dbHistoryUpdateFails: true,
        });
        return Effect.gen(function* () {
          yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          yield* runPull(pullFlags());

          const migrationFiles = yield* listMigrations;
          expect(migrationFiles.some((file) => file.includes("_remote_schema.sql"))).toBe(true);

          const envelope = yield* Schema.decodeUnknownEffect(dbStepWrittenEnvelope)(
            capturingStdio.stdout[0],
          );
          expect(envelope.steps.db.status).toBe("failed");
          expect(envelope.steps.db.written.length).toBeGreaterThan(0);
          expect(envelope.steps.db.written[0]).toContain("supabase/migrations/");
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a functions-step failure AFTER an earlier slug already downloaded reports that slug's directory as written (a real partial-download case)",
      () => {
        const { layer, capturingStdio } = setupMachine({
          format: "json",
          yes: true,
          api: { functionSlugs: ["hello", "world"], functionBodyFailsForSlug: "world" },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          yield* runPull(pullFlags());

          expect(yield* projectFileExists("supabase", "functions", "hello", "index.ts")).toBe(true);

          const envelope = yield* Schema.decodeUnknownEffect(jsonEnvelope)(
            capturingStdio.stdout[0],
          );
          expect(envelope["steps"]).toMatchObject({
            functions: { status: "failed", written: ["supabase/functions/hello"] },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a functions-step failure reported in TEXT mode inlines the failure message in the summary block",
      () => {
        const { layer, out } = setup({
          yes: true,
          api: { functionsListStatus: 500 },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);

          expect(stepLine(out.stdoutText, "config")).toContain("unchanged");
          expect(stepLine(out.stdoutText, "migration_history")).toContain("not_needed");
          expect(stepLine(out.stdoutText, "db")).toContain("unchanged");
          expect(stepLine(out.stdoutText, "functions")).toContain("failed");
          expect(out.stdoutText).toContain("500");
          expect(out.stdoutText).toContain(
            `To retry just this step, run: supabase functions download --remote=${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "a defect inside a step (not a typed failure) propagates as a defect instead of a captured step failure",
      () => {
        const { layer } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false, die: "pg-delta engine defect" }),
        });
        return Effect.gen(function* () {
          yield* writeConfig();
          yield* seedLocalMigration("20260101000000");
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(true);
            expect(Cause.hasFails(exit.cause)).toBe(false);
          }
        }).pipe(Effect.provide(layer));
      },
    );
  });

  // Exercises the "not_needed" reason branch (migrations already populated), distinct from the
  // bootstrap ("planned" via an empty directory) cases above.
  it.effect(
    "--dry-run over an already-populated supabase/migrations reports migration_history as not_needed",
    () => {
      const { layer, out } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* writeConfig("[api]\nmax_rows = 500\n");
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags({ dryRun: true }));
        expect(stepLine(out.stdoutText, "migration_history")).toContain("skipped");
        expect(stepLine(out.stdoutText, "migration_history")).toContain("not_needed");
      }).pipe(Effect.provide(layer));
    },
  );
});

// The raw `--remote`/`--project-ref` value in `cli_command_executed`'s `flags` map is read from the
// literal argv (`Stdio.args`), a separate source from the `PullFlags` object the handler runs
// on, so each case below overrides `Stdio.args` on top of `setup()`'s default.
describe("pull telemetry wiring", () => {
  const withArgs = (base: ReturnType<typeof setup>["layer"], args: ReadonlyArray<string>) =>
    Layer.mergeAll(base, Stdio.layerTest({ args: Effect.succeed(["pull", ...args]) }));

  it.effect("logs a ref-shaped --remote verbatim in cli_command_executed", () => {
    const { layer, analytics } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* writeConfig();
      yield* runPull(pullFlags({ remote: refRemote(VALID_REF), dryRun: true }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ remote: VALID_REF });
    }).pipe(Effect.provide(withArgs(layer, [`--remote=${VALID_REF}`])));
  });

  it.effect("redacts a branch-name --remote in cli_command_executed", () => {
    // A user-created branch name must never reach PostHog verbatim.
    const { layer, analytics } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* writeConfig();
      yield* runPull(pullFlags({ remote: branchRemote("staging"), dryRun: true }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ remote: "<redacted>" });
    }).pipe(Effect.provide(withArgs(layer, ["--remote=staging"])));
  });

  it.effect("logs a ref-shaped --project-ref verbatim in cli_command_executed", () => {
    const { layer, analytics } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* writeConfig();
      yield* runPull(pullFlags({ projectRef: Option.some(VALID_REF), dryRun: true }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": VALID_REF });
    }).pipe(Effect.provide(withArgs(layer, ["--project-ref", VALID_REF])));
  });

  it.effect("redacts a branch-name-shaped --project-ref in cli_command_executed", () => {
    const { layer, analytics } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* writeConfig();
      yield* runPull(pullFlags({ projectRef: Option.some("staging"), dryRun: true }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": "<redacted>" });
    }).pipe(Effect.provide(withArgs(layer, ["--project-ref", "staging"])));
  });
});

// `streamJsonOutputLayer` nests the success payload under `data`, but its `fail`
// implementation spreads `MachineErrorContext`'s payload at the top level alongside
// `type`/`error`/`timestamp` — an asymmetry within the same layer.
describe("pull stream-json output", () => {
  it.effect(
    "a successful run emits exactly one NDJSON result event with the payload nested under data",
    () => {
      const { layer, capturingStdio } = setupMachine({
        format: "stream-json",
        yes: true,
        api: { functionSlugs: ["hello"] },
        remoteMigrations: [
          { version: "20260101000000", name: "init", statements: ["create table foo ();"] },
        ],
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
        }),
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
        yield* writeConfig("[api]\nmax_rows = 500\n");
        yield* runPull(pullFlags());

        expect(capturingStdio.stdout).toHaveLength(1);
        const event = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(event["type"]).toBe("result");
        expect(event["steps"]).toBeUndefined();
        expect(event["data"]).toMatchObject({
          message: expect.stringContaining("Pull complete"),
          steps: { config: { status: "changed" }, db: { status: "changed" } },
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a partial step failure emits exactly one NDJSON error event with the payload spread at the top level, NOT nested under data",
    () => {
      const { layer, capturingStdio } = setupMachine({
        format: "stream-json",
        yes: true,
        api: { functionsListStatus: 500 },
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* writeConfig();
        yield* seedLocalMigration("20260101000000");
        yield* runPull(pullFlags());

        expect(capturingStdio.stdout).toHaveLength(1);
        const event = yield* Schema.decodeUnknownEffect(jsonEnvelope)(capturingStdio.stdout[0]);
        expect(event["type"]).toBe("error");
        expect(event["data"]).toBeUndefined();
        expect(event["error"]).toMatchObject({ message: expect.stringContaining("500") });
        expect(event["steps"]).toMatchObject({
          functions: { status: "failed", failure: { message: expect.stringContaining("500") } },
        });
      }).pipe(Effect.provide(layer));
    },
  );
});

describeHostedConsent("pull", {
  api: { handler: apiHandlerFor({}) },
  setup: (workdir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${workdir}/supabase/.temp`, { recursive: true });
      yield* fs.writeFileString(`${workdir}/supabase/.temp/project-ref`, VALID_REF);
      yield* fs.writeFileString(
        `${workdir}/supabase/config.toml`,
        `project_id = "${VALID_REF}"\n\n[experimental.pgdelta]\nenabled = true\n[api]\nmax_rows = 500\n`,
      );
    }),
  invoke: ({ out }) => {
    const substrate = setupSubstrate(
      {
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
        }),
      },
      out.layer,
      Stdio.layerTest({ args: Effect.succeed(["pull"]) }),
    );
    return {
      run: Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
        return yield* pull(pullFlags());
      }).pipe(
        // `pull` rejects `-o`; machine output only comes from `--output-format`.
        Effect.provide(Layer.mergeAll(substrate.layer, Layer.succeed(OutputFlag, Option.none()))),
      ),
      mutations: () => substrate.dbConfig.historyUpserts.length,
    };
  },
});

describe("pull permissions through the real layers", () => {
  const asLines = (requests: ReadonlyArray<StubbedRequest>) =>
    requests.map(({ method, path }) => `${method} ${path}`);
  const poolerRequest = `GET /v1/projects/${VALID_REF}/config/database/pooler`;
  const loginRoleRequest = `POST /v1/projects/${VALID_REF}/cli/login-role`;
  const cacheRequest = `GET https://api.supabase.com/v1/projects/${VALID_REF}`;
  const configRequest = `GET https://api.supabase.com/v2/projects/${VALID_REF}/config`;
  const asApiLines = (requests: ReadonlyArray<{ readonly method: string; readonly url: string }>) =>
    requests.map(({ method, url }) => `${method} ${url}`);

  const bootstrapSetup = () =>
    setup({
      yes: true,
      realLayers: true,
      api: { functionSlugs: ["hello"] },
      remoteMigrations: [
        { version: "20260101000000", name: "init", statements: ["create table foo ();"] },
      ],
      diffOutcome: () => ({
        changes: true,
        files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
      }),
    });

  // No `.temp/pooler-url` is saved between steps, so each database step resolves it again.
  const FULL_RUN_SEQUENCE: ReadonlyArray<string> = [
    poolerRequest,
    loginRoleRequest,
    poolerRequest,
    loginRoleRequest,
  ];

  const REF_SCENARIOS: ReadonlyArray<{
    readonly name: string;
    readonly remote: Option.Option<RemoteValue>;
    readonly projectRef: Option.Option<string>;
    readonly flag: Readonly<Record<string, string | boolean>>;
  }> = [
    { name: "no selector", remote: Option.none(), projectRef: Option.none(), flag: {} },
    {
      name: "--remote=<ref>",
      remote: refRemote(VALID_REF),
      projectRef: Option.none(),
      flag: { remote: VALID_REF },
    },
    {
      name: "a bare --remote, which resolves from settings",
      remote: Option.some<RemoteValue>({ _tag: "Linked" }),
      projectRef: Option.none(),
      flag: { remote: true },
    },
    {
      name: "the deprecated --project-ref with the ref",
      remote: Option.none(),
      projectRef: Option.some(VALID_REF),
      flag: { "project-ref": VALID_REF },
    },
  ];

  for (const scenario of REF_SCENARIOS) {
    it.effect(
      `reads the config, fetches the history, pulls the schema and downloads functions for ${scenario.name}`,
      () => {
        const { layer, api, projectHttp } = bootstrapSetup();
        const stubbed: Array<StubbedRequest> = [];
        return Effect.gen(function* () {
          yield* TestClock.setTime(AFTER_SEEDED_MIGRATIONS);
          yield* stubManagementApi(stubbed, serveLinkedDatabase(VALID_REF));
          yield* writeConfig("[api]\nmax_rows = 500\n");
          yield* runPull(pullFlags({ remote: scenario.remote, projectRef: scenario.projectRef }));

          expect(asLines(stubbed)).toEqual(FULL_RUN_SEQUENCE);
          expect(asApiLines(api.requests)).toEqual([
            configRequest,
            `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
            `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions/hello/body`,
          ]);
          expect(asApiLines(projectHttp.calls)).toEqual([cacheRequest]);
          expect(yield* projectFileExists("supabase", ".temp", "linked-project.json")).toBe(true);
          assertPermissionDrift({
            command: "pull",
            activeFlags: { ...STEP_SWITCHES, ...scenario.flag },
            requests: [...api.requests, ...asRecordedRequests(stubbed), ...projectHttp.calls],
            exact: true,
          });
        }).pipe(
          Effect.scoped,
          Effect.provide(layer),
          provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
        );
      },
    );
  }

  it.effect("--dry-run reads the config and fills the cache, and makes no other request", () => {
    const { layer, api, projectHttp } = setup({
      realLayers: true,
      api: { functionSlugs: ["hello"] },
    });
    const stubbed: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(stubbed, serveLinkedDatabase(VALID_REF));
      yield* writeConfig();
      yield* runPull(pullFlags({ dryRun: true }));

      expect(asLines(stubbed)).toEqual([]);
      expect(asApiLines(api.requests)).toEqual([configRequest]);
      expect(asApiLines(projectHttp.calls)).toEqual([cacheRequest]);
      const flags = { ...STEP_SWITCHES, "dry-run": true };
      assertPermissionDrift({
        command: "pull",
        activeFlags: flags,
        requests: [...api.requests, ...asRecordedRequests(stubbed), ...projectHttp.calls],
        exact: true,
      });
      expect(() =>
        assertPermissionDrift({
          command: "pull",
          activeFlags: flags,
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
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("the project picker lists projects and the run still fills the real cache", () => {
    const { layer, api, projectHttp, out } = setup({
      realLayers: true,
      picksProject: true,
      projectId: Option.none(),
      stdinIsTty: true,
    });
    const stubbed: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(stubbed, serveLinkedDatabase(VALID_REF));
      yield* writeConfig();
      yield* runPull(pullFlags({ dryRun: true }));

      expect(out.promptSelectCalls).toHaveLength(1);
      expect(asApiLines(api.requests)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        configRequest,
      ]);
      expect(asApiLines(projectHttp.calls)).toEqual([cacheRequest]);
      assertPermissionDrift({
        command: "pull",
        activeFlags: { ...STEP_SWITCHES, "dry-run": true },
        requests: [...api.requests, ...asRecordedRequests(stubbed), ...projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("--with-migration-history on a populated directory resolves the database again", () => {
    const { layer, api, projectHttp } = setup({
      yes: true,
      realLayers: true,
      api: { functionSlugs: ["hello"] },
      remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
    });
    const stubbed: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(stubbed, serveLinkedDatabase(VALID_REF));
      yield* writeConfig();
      yield* seedLocalMigration("20260101000000", "init");
      yield* runPull(pullFlags({ withMigrationHistory: true }));

      expect(asLines(stubbed)).toEqual(FULL_RUN_SEQUENCE);
      assertPermissionDrift({
        command: "pull",
        activeFlags: { ...STEP_SWITCHES, "with-migration-history": true },
        requests: [...api.requests, ...asRecordedRequests(stubbed), ...projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("retries the schema diff through the pooler after an IPv6 failure", () => {
    let diffs = 0;
    const { layer, api, projectHttp } = setup({
      yes: true,
      realLayers: true,
      api: { functionSlugs: ["hello"] },
      remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
      diffOutcome: () => {
        diffs += 1;
        return diffs === 1
          ? { changes: false, fail: "could not translate host name: network is unreachable" }
          : { changes: false };
      },
    });
    const stubbed: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* reachableDirectHost;
      yield* stubManagementApi(stubbed, serveLinkedDatabase(VALID_REF));
      yield* writeConfig();
      yield* seedLocalMigration("20260101000000");
      yield* runPull(pullFlags());

      expect(diffs).toBe(2);
      expect(asLines(stubbed)).toEqual([loginRoleRequest, poolerRequest, loginRoleRequest]);
      assertPermissionDrift({
        command: "pull",
        activeFlags: STEP_SWITCHES,
        requests: [...api.requests, ...asRecordedRequests(stubbed), ...projectHttp.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});
