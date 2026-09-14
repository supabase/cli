import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, PlatformError, Sink, Stdio, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { v2ProjectConfigResponse } from "../../../tests/helpers/config-fixtures.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  VALID_REF,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  transportFailure,
  useShadowCacheDisabled,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../shared/output/output.layer.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { DbConfigResolver } from "../../command-internal/db-config.service.ts";
import { DbConnection, type DbSession } from "../../command-internal/db-connection.service.ts";
import { DbExecError } from "../../command-internal/db-connection.errors.ts";
import { DockerRun } from "../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScript } from "../../command-internal/edge-runtime-script.service.ts";
import { PgDeltaSslProbe } from "../../command-internal/pgdelta-ssl-probe.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../db/shared/pgdelta-engine.service.ts";
import type { PullFlags } from "./pull.command.ts";
import { pullHandler } from "./pull.command.ts";

/**
 * Scenario-oriented integration coverage for `supabase pull` (ADR 0024), driving the real
 * exported `pullHandler` against a fully mocked db-pull/migration-fetch/functions-download
 * substrate. `PgDeltaEngine` is mocked directly to force the pg-delta diff engine; `DbConnection`
 * shares one fake Postgres session across the migration-history and db steps, since both read
 * `supabase_migrations.schema_migrations`.
 */

const tempRoot = useTempWorkdir("supabase-pull-int-");
useShadowCacheDisabled();

const BRANCH_REF = "cccccccccccccccccccc";

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

function configPath(): string {
  return join(tempRoot.current, "supabase", "config.toml");
}

function migrationsDir(): string {
  return join(tempRoot.current, "supabase", "migrations");
}

/** Writes a minimal, schema-valid `supabase/config.toml` with pg-delta forced on
 *  (so every db step exercises the fully-mocked `PgDeltaEngine`, never the
 *  migra/edge-runtime path or the pg_dump initial-pull seed). */
function writeConfig(extraToml = ""): string {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  writeFileSync(
    path,
    `project_id = "${VALID_REF}"\n\n[experimental.pgdelta]\nenabled = true\n${extraToml}`,
  );
  return path;
}

/** Seeds a local migration file whose basename `loadLocalVersions` parses
 *  back into `version` — content is irrelevant to every mocked collaborator here. */
function seedLocalMigration(
  version: string,
  name = "local",
  sql = "create table local ();\n",
): string {
  mkdirSync(migrationsDir(), { recursive: true });
  const path = join(migrationsDir(), `${version}_${name}.sql`);
  writeFileSync(path, sql);
  return path;
}

/** Writes `supabase/.env`, backing `env(VAR)` resolution. */
function writeProjectEnv(dotenv: string): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), dotenv);
}

/** The rendered step row for `step` in `renderPullSummary`'s output, with
 *  internal padding collapsed to single spaces so assertions don't hardcode
 *  column widths. Empty string when the step has no row at all. */
function stepLine(text: string, step: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().startsWith(step));
  return line === undefined ? "" : line.trim().replace(/\s+/g, " ");
}

function pullFlags(overrides: Partial<PullFlags> = {}): PullFlags {
  return {
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
        if (command._tag !== "StandardCommand") {
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
    return Effect.succeed([] as ReadonlyArray<Record<string, unknown>>);
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

function makeDbConfigLayers(
  remoteMigrations: ReadonlyArray<RemoteMigrationRow>,
  callOrder: Array<string>,
  historyUpdateFails = false,
): {
  readonly layer: Layer.Layer<DbConfigResolver | DbConnection>;
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
    resolve: (resolveFlags) => {
      const { connType } = resolveFlags;
      return Effect.succeed({
        conn: {
          host: connType === "local" ? "127.0.0.1" : `db.${VALID_REF}.supabase.co`,
          port: TARGET_PORT,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: connType === "local",
        ref: Option.some(VALID_REF),
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  return {
    layer: Layer.mergeAll(dbConnection, resolver),
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
  /** A transport (not status-code) failure resolving a branch-name `--project-ref`. */
  readonly branchNetworkFails?: boolean;
  /** Fails only this slug's `/body` download with a 500; every other slug still downloads
   *  normally, proving a partial functions-step download reports earlier slugs as written. */
  readonly functionBodyFailsForSlug?: string;
}

function makeApiMock(opts: ApiOpts) {
  return mockCommandPlatformApi({
    handler: (request) => {
      const url = request.url;
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
    },
  });
}

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
  onConfirm: () => void,
): Layer.Layer<Output> {
  return Layer.effect(
    Output,
    Effect.gen(function* () {
      const inner = yield* Output;
      return {
        ...inner,
        promptConfirm: (message: string, promptOpts?: { defaultValue?: boolean }) =>
          Effect.sync(onConfirm).pipe(Effect.andThen(inner.promptConfirm(message, promptOpts))),
      };
    }),
  ).pipe(Layer.provide(base));
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
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
  /** Runs as a side effect of the orchestrator's "Proceed with pull?" confirmation, before it
   *  resolves — simulates a concurrent edit to `supabase/config.toml` while that prompt is on
   *  screen (text-mode, interactive TTY only). */
  readonly confirmSideEffect?: () => void;
  /** Overrides `cliSettings.workdir` — defaults to the temp project root. */
  readonly workdir?: string;
  /** Overrides the ambient `--experimental`/`SUPABASE_EXPERIMENTAL` gate — defaults to `false`. */
  readonly experimental?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const format = opts.format ?? "text";
  const isMachine = format !== "text";
  const capturingStdio = isMachine ? mockCapturingStdio(["pull"]) : undefined;
  const out =
    capturingStdio === undefined
      ? mockOutput({ format, promptConfirmResponses: opts.confirm })
      : undefined;

  const finalOutputLayer =
    capturingStdio !== undefined
      ? (format === "json" ? jsonOutputLayer : streamJsonOutputLayer).pipe(
          Layer.provide(capturingStdio.layer),
        )
      : opts.confirmSideEffect === undefined
        ? out!.layer
        : withConfirmSideEffect(out!.layer, opts.confirmSideEffect);

  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const processControl = mockProcessControl();
  const analytics = mockContextualAnalytics();

  const api = makeApiMock(opts.api ?? {});
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

  const cliSettings = mockCommandSettings({
    workdir: opts.workdir ?? tempRoot.current,
    projectId: Option.some(VALID_REF),
  });

  const layer = Layer.mergeAll(
    buildTestRuntime({
      out: { layer: finalOutputLayer },
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      stdin: mockStdin(opts.stdinIsTty ?? false),
      runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      processControl: { layer: processControl.layer },
      analytics: { layer: analytics.layer },
      goOutput: opts.goOutput ?? Option.none(),
    }),
    machineErrorContextLayer,
    commandRuntimeLayer(["pull"]),
    capturingStdio?.layer ?? Stdio.layerTest({ args: Effect.succeed(["pull"]) }),
    dbConfig.layer,
    pgDelta.layer,
    Layer.succeed(EdgeRuntimeScript, {
      run: () => Effect.die("migra edge runtime unused — every db step forces pg-delta"),
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
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(CliArgs, { args: [] }),
    // Listed after `buildTestRuntime` so it overrides the real spawner `BunServices.layer`
    // provides (last-wins).
    spawner.layer,
  );

  return {
    layer,
    out,
    capturingStdio,
    api,
    telemetry,
    linkedProjectCache,
    processControl,
    analytics,
    spawner,
    dbConfig,
    pgDelta,
    callOrder,
  };
}

describe("pull integration", () => {
  it.live(
    "bootstraps a fresh checkout: migration history auto-runs, config/functions/db all report changed",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
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
        yield* runPull(pullFlags());

        expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
        expect(existsSync(join(migrationsDir(), "20260101000000_init.sql"))).toBe(true);
        expect(readdirSync(migrationsDir()).length).toBeGreaterThan(1);
        expect(
          existsSync(join(tempRoot.current, "supabase", "functions", "hello", "index.ts")),
        ).toBe(true);

        expect(stepLine(out!.stdoutText, "config")).toContain("changed");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("changed");
        expect(stepLine(out!.stdoutText, "db")).toContain("changed");
        expect(stepLine(out!.stdoutText, "functions")).toContain("changed");

        expect(telemetry.flushed).toBe(true);
        const executed = analytics.captured.filter((c) => c.event === "cli_command_executed");
        expect(executed).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "bootstraps a fresh checkout with --output-format json: exactly one JSON object with all four step keys",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const { layer, capturingStdio, dbConfig, linkedProjectCache } = setup({
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
        yield* runPull(pullFlags());

        expect(capturingStdio!.stdout).toHaveLength(1);
        const payload = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        const steps = payload["steps"] as Record<string, unknown>;
        expect(Object.keys(steps).sort()).toEqual([
          "config",
          "db",
          "functions",
          "migration_history",
        ]);
        expect((steps["config"] as Record<string, unknown>)["status"]).toBe("changed");
        expect((steps["migration_history"] as Record<string, unknown>)["status"]).toBe("changed");
        expect((steps["db"] as Record<string, unknown>)["status"]).toBe("changed");
        expect((steps["functions"] as Record<string, unknown>)["status"]).toBe("changed");
        expect(payload["wrote"]).toBe(true);

        expect(dbConfig.historyUpserts.length).toBeGreaterThan(0);
        const dbDetail = (steps["db"] as Record<string, unknown>)["detail"] as Record<
          string,
          unknown
        >;
        expect(dbDetail["remote_history_updated"]).toBe(true);

        expect(linkedProjectCache.cached).toBe(true);
        expect(linkedProjectCache.cachedRef).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "renders the config diff body (not 'No config differences found.') when the only diff is skipped as an env() reference",
    () => {
      // Every other managed field sits at its schema default, so `auth.site_url` is the only
      // change in the changeset — and, being declared as `env(SITE_URL)`, it's skipped rather
      // than written, leaving `runPlan.hasWork` false even though a real (unwritable) diff exists.
      writeConfig('[auth]\nsite_url = "env(SITE_URL)"\n');
      writeProjectEnv("SITE_URL=https://local.example.com\n");
      const { layer, out } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());

        expect(out!.stdoutText).not.toContain("No config differences found.");
        expect(out!.stdoutText).toContain("auth.site_url [update, skip: env() reference]");
        expect(stepLine(out!.stdoutText, "config")).toContain("unchanged");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a branch-name --project-ref resolves exactly once: one branch lookup, one config GET, no picker prompt",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, out, api } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags({ projectRef: Option.some("staging") }));

        const branchLookups = api.requests.filter((request) => request.url.includes("/branches/"));
        expect(branchLookups).toHaveLength(1);
        const configLookups = api.requests.filter((request) => request.url.endsWith("/config"));
        expect(configLookups).toHaveLength(1);
        expect(out!.promptSelectCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "on an interactive TTY with real diffs, the confirmation prompt appears exactly once",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      seedLocalMigration("20260101000000");
      const { layer, out } = setup({
        stdinIsTty: true,
        confirm: [true],
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());

        expect(out!.promptConfirmCalls).toHaveLength(1);
        expect(out!.promptConfirmCalls[0]?.message).toBe("Proceed with pull?");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "the single confirmation suppresses BOTH sub-step prompts, and both underlying writes still complete: db updates remote history, migration fetch overwrites the pre-existing file",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      // Shares the remote row's exact version+name: `migration fetch`'s overwrite prompt only
      // fires when `supabase/migrations` is non-empty, and this file is what gets clobbered.
      const preExisting = seedLocalMigration(
        "20260101000000",
        "init",
        "create table local_only ();\n",
      );
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
        // `--with-migration-history` over an already-populated directory is the other
        // condition (besides real db drift) that would make both sub-prompts reachable if
        // `assumeYes` didn't suppress them.
        yield* runPull(pullFlags({ withMigrationHistory: true }));

        expect(out!.promptConfirmCalls).toHaveLength(1);
        expect(out!.promptConfirmCalls[0]?.message).toBe("Proceed with pull?");

        const rewritten = readFileSync(preExisting, "utf8");
        expect(rewritten).toContain("create table remote_only");
        expect(rewritten).not.toContain("create table local_only");

        expect(dbConfig.historyUpserts.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--dry-run writes nothing and reports every step planned/skipped", () => {
    const before =
      'project_id = "test"\n\n[experimental.pgdelta]\nenabled = true\n[api]\nmax_rows = 500\n';
    mkdirSync(join(tempRoot.current, "supabase"), { recursive: true });
    writeFileSync(configPath(), before);
    const { layer, out, api } = setup({ yes: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runPull(pullFlags({ dryRun: true })));
      expect(Exit.isSuccess(exit)).toBe(true);

      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(existsSync(migrationsDir())).toBe(false);
      expect(api.requests.some((request) => request.method !== "GET")).toBe(false);

      expect(stepLine(out!.stdoutText, "config")).toContain("planned");
      expect(stepLine(out!.stdoutText, "migration_history")).toContain("planned");
      expect(stepLine(out!.stdoutText, "db")).toContain("planned");
      expect(stepLine(out!.stdoutText, "functions")).toContain("planned");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a --dry-run --output-format json payload surfaces dirty_paths, even though the dry-run itself never runs the abort logic that would otherwise trip on them",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const { layer, capturingStdio } = setup({ format: "json", yes: true, gitDirty: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags({ dryRun: true })));
        expect(Exit.isSuccess(exit)).toBe(true);

        const payload = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        expect(payload["dirty_paths"]).toEqual(["supabase/config.toml"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a clean-tree run reports an empty dirty_paths array in the JSON payload, present on every disposition",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, capturingStdio } = setup({
        format: "json",
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());
        const payload = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        expect(payload["dirty_paths"]).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "declining the confirmation writes nothing; migration history reports declined, db/functions report planned",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const before = readFileSync(configPath(), "utf8");
      const { layer, out } = setup({ stdinIsTty: true, confirm: [false] });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isSuccess(exit)).toBe(true);

        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(existsSync(migrationsDir())).toBe(false);

        expect(stepLine(out!.stdoutText, "config")).toContain("planned");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("skipped");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("declined");
        expect(stepLine(out!.stdoutText, "db")).toContain("planned");
        expect(stepLine(out!.stdoutText, "functions")).toContain("planned");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a functions-step failure still reports every other step, exits non-zero, with exactly one JSON envelope",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, capturingStdio, processControl, telemetry, linkedProjectCache } = setup({
        format: "json",
        yes: true,
        api: { functionsListStatus: 500 },
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());

        expect(capturingStdio!.stdout).toHaveLength(1);
        const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        expect(envelope["_tag"]).toBe("Error");
        const steps = envelope["steps"] as Record<string, unknown>;
        expect((steps["config"] as Record<string, unknown>)["status"]).not.toBe("failed");
        expect((steps["migration_history"] as Record<string, unknown>)["status"]).not.toBe(
          "failed",
        );
        expect((steps["db"] as Record<string, unknown>)["status"]).not.toBe("failed");
        expect((steps["functions"] as Record<string, unknown>)["status"]).toBe("failed");
        const failure = (steps["functions"] as Record<string, unknown>)["failure"] as Record<
          string,
          unknown
        >;
        expect(String(failure["message"])).toContain("500");
        expect(processControl.exitCode).toBe(1);

        expect(linkedProjectCache.cached).toBe(true);
        expect(linkedProjectCache.cachedRef).toBe(VALID_REF);
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a steady-state pull (no config drift, no schema drift, no functions) exits 0 with every step non-failed",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, out } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isSuccess(exit)).toBe(true);

        expect(stepLine(out!.stdoutText, "config")).toContain("unchanged");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("skipped");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
        expect(stepLine(out!.stdoutText, "db")).toContain("unchanged");
        expect(stepLine(out!.stdoutText, "functions")).toContain("unchanged");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--remote-label creates the named [remotes.*] block even on an otherwise zero-drift config",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags({ remoteLabel: Option.some("customname") }));
        expect(readFileSync(configPath(), "utf8")).toContain("[remotes.customname]");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "an empty-string --remote-label is treated as not provided: no forced [remotes.*] block on an otherwise zero-drift config",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, out } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags({ remoteLabel: Option.some("") }));
        expect(stepLine(out!.stdoutText, "config")).toContain("unchanged");
        expect(readFileSync(configPath(), "utf8")).not.toContain("[remotes.");
      }).pipe(Effect.provide(layer));
    },
  );

  describe("dirty supabase/config.toml", () => {
    it.live("interactive TTY: the prompt defaults to decline", () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const before = readFileSync(configPath(), "utf8");
      const { layer, out } = setup({ stdinIsTty: true, confirm: [false], gitDirty: true });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());
        expect(out!.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "--yes on a dirty tree aborts with the uncommitted-changes error, no prompt shown",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        const before = readFileSync(configPath(), "utf8");
        const { layer, out } = setup({ yes: true, gitDirty: true });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          const rendered = JSON.stringify(exit);
          expect(rendered).toContain("PullUncommittedChangesError");
          expect(out!.promptConfirmCalls).toHaveLength(0);
          expect(readFileSync(configPath(), "utf8")).toBe(before);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("--output-format json on a dirty tree aborts without --yes and without a TTY", () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const { layer, capturingStdio, processControl } = setup({
        format: "json",
        gitDirty: true,
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());
        expect(capturingStdio!.stdout).toHaveLength(1);
        const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        expect((envelope["error"] as Record<string, unknown>)["code"]).toBe(
          "PullUncommittedChangesError",
        );
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "a non-interactive text terminal (piped stdin) on a dirty tree aborts without prompting",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        const { layer, out } = setup({ stdinIsTty: false, gitDirty: true });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain("PullUncommittedChangesError");
          expect(out!.promptConfirmCalls).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "--force proceeds and writes despite all three locations being dirty, never even checking git",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        const { layer, spawner } = setup({
          yes: true,
          gitDirty: true,
          gitDirtyMigrations: true,
          gitDirtyFunctions: true,
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags({ force: true }));
          expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
          expect(spawner.gitCalls).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("a git spawn failure degrades to 'not dirty' rather than blocking the pull", () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const { layer } = setup({ yes: true, gitSpawnFails: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
      }).pipe(Effect.provide(layer));
    });
  });

  // Checked unconditionally (skipped only by --force): the db step always runs with no preview
  // machinery, so this fires regardless of whether migration-history itself runs.
  describe("dirty supabase/migrations", () => {
    it.live(
      "already-populated, no --with-migration-history pending: still aborts without --force (the db step might still write there)",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer } = setup({
          yes: true,
          gitDirtyMigrations: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain("PullUncommittedChangesError");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a fresh checkout with migration-history bootstrap pending: also aborts without --force",
      () => {
        writeConfig();
        const { layer } = setup({
          yes: true,
          gitDirtyMigrations: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain("PullUncommittedChangesError");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "interactive TTY: the prompt defaults to decline and the confirmation body names supabase/migrations",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
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
          yield* runPull(pullFlags());
          expect(out!.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
          expect(out!.stdoutText).toContain(
            "supabase/migrations has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  // Checked unconditionally (skipped only by --force), same as migrations, since the functions
  // step always runs with no "does it have work" signal without calling the API first.
  describe("dirty supabase/functions", () => {
    it.live("aborts without --force, even with zero config/db drift", () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer } = setup({
        yes: true,
        gitDirtyFunctions: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("PullUncommittedChangesError");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "interactive TTY: the prompt defaults to decline and the confirmation body names supabase/functions",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
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
          yield* runPull(pullFlags());
          expect(out!.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
          expect(out!.stdoutText).toContain(
            "supabase/functions has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("multiple dirty locations at once", () => {
    it.live(
      "config AND functions dirty together: the confirmation body names both, config before functions",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        seedLocalMigration("20260101000000");
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
          yield* runPull(pullFlags());
          expect(out!.stdoutText).toContain(
            "supabase/config.toml and supabase/functions have uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "all three dirty at once: the abort error names all three, in config, migrations, functions order",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        seedLocalMigration("20260101000000");
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
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain(
            "supabase/config.toml, supabase/migrations, and supabase/functions have uncommitted or untracked changes",
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  it.live(
    "the db step's shadow setup observes the config step's own db.major_version write, not the stale pre-pull value",
    () => {
      writeConfig("[db]\nmajor_version = 14\n");
      seedLocalMigration("20260101000000");
      const { layer, spawner } = setup({
        yes: true,
        api: {
          configResponse: v2ProjectConfigResponse({
            attributes: (attributes) => ({
              ...attributes,
              database: {
                ...(attributes["database"] as Record<string, unknown>),
                major_version: 15,
              },
            }),
          }),
        },
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());

        expect(readFileSync(configPath(), "utf8")).toContain("major_version = 15");
        const createCalls = spawner.shadowSpawned.filter((call) => call.args[0] === "create");
        expect(createCalls.length).toBeGreaterThan(0);
        const createArgs = createCalls.flatMap((call) => call.args);
        expect(createArgs.some((arg) => /supabase\/postgres:15\./.test(arg))).toBe(true);
        expect(createArgs.some((arg) => /supabase\/postgres:14\./.test(arg))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "the db step stays in migration mode with the ambient --experimental gate on, never taking the declarative export path",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, out } = setup({
        yes: true,
        experimental: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        // A real diff, so the db step actually writes. If `pullDbStep` didn't forward
        // `forceMigrationMode: true`, the ambient `--experimental` gate would route this to
        // the declarative path instead, which the mocked `PgDeltaEngine.exportDeclarativeSchema`
        // dies on.
        diffOutcome: () => ({
          changes: true,
          files: [{ name: "pull", sql: "alter table foo add column bar text;" }],
        }),
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isSuccess(exit)).toBe(true);

        expect(readdirSync(migrationsDir()).length).toBeGreaterThan(1);
        expect(existsSync(join(tempRoot.current, "supabase", "schemas"))).toBe(false);
        expect(stepLine(out!.stdoutText, "db")).toContain("changed");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "the migration-history step's remote read happens before the db step's own remote read",
    () => {
      writeConfig();
      const { layer, callOrder } = setup({
        yes: true,
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());

        expect(existsSync(join(migrationsDir(), "20260101000000_init.sql"))).toBe(true);
        expect(callOrder).toContain("migration_history_read");
        expect(callOrder).toContain("db_list_remote");
        expect(callOrder.indexOf("migration_history_read")).toBeLessThan(
          callOrder.indexOf("db_list_remote"),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "supabase pull -o json fails with a message pointing at --output-format, not a machine payload",
    () => {
      writeConfig();
      const { layer, api } = setup({ goOutput: Option.some("json") });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("PullOutputFlagUnsupportedError");
        expect(rendered).toContain("--output-format");
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a --workdir naming a directory that does not exist fails before any target resolution",
    () => {
      const missing = join(tempRoot.current, "does-not-exist");
      const { layer, api, telemetry, linkedProjectCache } = setup({ workdir: missing });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("PullWorkdirError");
        expect(api.requests).toHaveLength(0);

        expect(telemetry.flushed).toBe(true);
        expect(linkedProjectCache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a network failure resolving a branch-name --project-ref fails with a network error, not a status error",
    () => {
      writeConfig();
      const { layer } = setup({ api: { branchNetworkFails: true } });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags({ projectRef: Option.some("staging") })));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("PullBranchResolveNetworkError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a supabase/migrations read failure that is NOT 'missing' (a plain file colliding with the directory) fails with a read error, instead of silently treating it as empty",
    () => {
      writeConfig();
      // `fs.readDirectory` against a plain file fails with ENOTDIR, not "NotFound" — the
      // bootstrap-detection read must propagate this instead of treating it as "no migrations
      // yet".
      writeFileSync(migrationsDir(), "not a directory");
      const { layer } = setup({ yes: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runPull(pullFlags()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("MigrationsReadError");
      }).pipe(Effect.provide(layer));
    },
  );

  describe("migration-history auto-run vs --with-migration-history", () => {
    it.live(
      "supabase/migrations already has files and the flag is not set: skipped as not_needed",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer, out } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags());
          expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "supabase/migrations already has files but --with-migration-history is set: the step actually runs",
      () => {
        writeConfig();
        // Named "init" to match the remote row below, so the fetch rewrites this file instead
        // of leaving a stale differently-named duplicate under the same version.
        seedLocalMigration("20260101000000", "init");
        const { layer, out } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
            { version: "20260102000000", name: "second", statements: ["select 2;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags({ withMigrationHistory: true }));
          expect(existsSync(join(migrationsDir(), "20260102000000_second.sql"))).toBe(true);
          expect(stepLine(out!.stdoutText, "migration_history")).toContain("changed");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "supabase/migrations is missing entirely: the step auto-runs (bootstrap reason)",
      () => {
        writeConfig();
        const { layer, out } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags());
          expect(out!.stdoutText).toContain("supabase/migrations has no migration files");
          expect(existsSync(join(migrationsDir(), "20260101000000_init.sql"))).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("per-step failure isolation", () => {
    it.live(
      "a config-step failure (a concurrent edit during the confirmation prompt) still runs migration_history/db/functions, in text mode",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        seedLocalMigration("20260101000000");
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [true],
          // Keeps `[experimental.pgdelta] enabled = true` intact, so this exercises the config
          // step's TOCTOU guard rather than routing the db step onto the unmocked migra path.
          confirmSideEffect: () =>
            writeFileSync(
              configPath(),
              'project_id = "changed-mid-flight"\n\n[experimental.pgdelta]\nenabled = true\n',
            ),
          api: { functionSlugs: ["hello"] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain("ConfigPullFileChangedError");

          expect(stepLine(out!.stdoutText, "config")).toContain("failed");
          expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
          expect(stepLine(out!.stdoutText, "db")).toContain("unchanged");
          expect(stepLine(out!.stdoutText, "functions")).toContain("changed");

          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase config pull --project-ref ${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a config-step failure carries --remote-label through to its own retry hint when one was passed",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        seedLocalMigration("20260101000000");
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [true],
          confirmSideEffect: () =>
            writeFileSync(
              configPath(),
              'project_id = "changed-mid-flight"\n\n[experimental.pgdelta]\nenabled = true\n',
            ),
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            runPull(pullFlags({ remoteLabel: Option.some("staging-remote") })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(stepLine(out!.stdoutText, "config")).toContain("failed");

          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase config pull --project-ref ${VALID_REF} --remote-label 'staging-remote'`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a branch-derived implicit remote-block target: the config step's retry hint names that SAME derived label, even though --remote-label was never passed",
      () => {
        writeConfig("[api]\nmax_rows = 500\n");
        seedLocalMigration("20260101000000");
        const { layer, out } = setup({
          stdinIsTty: true,
          confirm: [true],
          // Concurrent edit during the confirmation prompt trips the config step's TOCTOU
          // guard before the planned `[remotes.staging]` block (implicit target;
          // --remote-label was never passed) is ever written.
          confirmSideEffect: () =>
            writeFileSync(
              configPath(),
              'project_id = "changed-mid-flight"\n\n[experimental.pgdelta]\nenabled = true\n',
            ),
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            runPull(pullFlags({ projectRef: Option.some("staging") })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(stepLine(out!.stdoutText, "config")).toContain("failed");
          expect(readFileSync(configPath(), "utf8")).not.toContain("[remotes.staging]");

          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase config pull --project-ref ${BRANCH_REF} --remote-label 'staging'`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a migration-history-step failure (a hostile remote history row) still runs config/functions, and re-fails with its OWN (first) cause even though db also fails downstream",
      () => {
        writeConfig();
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
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain("MigrationFetchWriteError");
          expect(JSON.stringify(exit)).not.toContain("DbPullMigrationConflictError");

          expect(stepLine(out!.stdoutText, "config")).toContain("unchanged");
          expect(stepLine(out!.stdoutText, "migration_history")).toContain("failed");
          expect(stepLine(out!.stdoutText, "db")).toContain("failed");
          expect(stepLine(out!.stdoutText, "functions")).toContain("unchanged");

          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase migration fetch --project-ref ${VALID_REF}`,
          );
          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase db pull --project-ref ${VALID_REF} --experimental=false`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a migration-history-step failure AFTER an earlier row already wrote reports that file as written, not written: [] (a real partial-write case)",
      () => {
        writeConfig();
        const { layer, capturingStdio } = setup({
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
          yield* runPull(pullFlags());

          expect(existsSync(join(migrationsDir(), "20260101000000_good.sql"))).toBe(true);

          const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
          const steps = envelope["steps"] as Record<string, unknown>;
          const migrationHistory = steps["migration_history"] as Record<string, unknown>;
          expect(migrationHistory["status"]).toBe("failed");
          expect(migrationHistory["written"]).toEqual([
            "supabase/migrations/20260101000000_good.sql",
          ]);

          expect(envelope["wrote"]).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a db-step failure (a pg-delta engine error) still runs config/migration_history/functions",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer, out } = setup({
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false, fail: "boom: pg-delta blew up" }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(JSON.stringify(exit)).toContain("PgDeltaEngineError");

          expect(stepLine(out!.stdoutText, "config")).toContain("unchanged");
          expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
          expect(stepLine(out!.stdoutText, "db")).toContain("failed");
          expect(stepLine(out!.stdoutText, "functions")).toContain("unchanged");

          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase db pull --project-ref ${VALID_REF} --experimental=false`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a db-step migration-conflict failure carries BOTH the --with-migration-history hint AND the generic retry hint, in that order",
      () => {
        writeConfig();
        // A local file that doesn't match the remote history row trips `db pull`'s own
        // `DbPullMigrationConflictError`, since `reconcileMigrations` treats any non-matching
        // version as a conflict.
        seedLocalMigration("20260101000000");
        const { layer, capturingStdio } = setup({
          format: "json",
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260103000000", name: "remote-only", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags());

          const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
          const steps = envelope["steps"] as Record<string, unknown>;
          expect((steps["db"] as Record<string, unknown>)["status"]).toBe("failed");
          const failure = (steps["db"] as Record<string, unknown>)["failure"] as Record<
            string,
            unknown
          >;
          expect(String(failure["code"])).toBe("DbPullMigrationConflictError");

          const suggestion = String(failure["suggestion"]);
          const migrationHistoryHintIndex = suggestion.indexOf(
            `Alternatively, rerun \`supabase pull --with-migration-history --project-ref ${VALID_REF}\``,
          );
          const retryHintIndex = suggestion.indexOf(
            `To retry just this step, run: supabase db pull --project-ref ${VALID_REF}`,
          );
          expect(migrationHistoryHintIndex).toBeGreaterThan(-1);
          expect(retryHintIndex).toBeGreaterThan(migrationHistoryHintIndex);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a db-step migration-conflict failure's --with-migration-history remedy also carries a shell-quoted --remote-label when one was passed",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer, capturingStdio } = setup({
          format: "json",
          yes: true,
          api: { functionSlugs: [] },
          remoteMigrations: [
            { version: "20260103000000", name: "remote-only", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags({ remoteLabel: Option.some("staging remote") }));

          const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
          const steps = envelope["steps"] as Record<string, unknown>;
          const failure = (steps["db"] as Record<string, unknown>)["failure"] as Record<
            string,
            unknown
          >;
          expect(String(failure["suggestion"])).toContain(
            `Alternatively, rerun \`supabase pull --with-migration-history --project-ref ${VALID_REF} --remote-label 'staging remote'\``,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a db-step failure AFTER the migration file already wrote, but the remote-history update failed, reports that file as written (a real partial-write case)",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer, capturingStdio } = setup({
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
          yield* runPull(pullFlags());

          const migrationFiles = readdirSync(migrationsDir());
          expect(migrationFiles.some((file) => file.includes("_remote_schema.sql"))).toBe(true);

          const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
          const steps = envelope["steps"] as Record<string, unknown>;
          const db = steps["db"] as Record<string, unknown>;
          expect(db["status"]).toBe("failed");
          expect((db["written"] as ReadonlyArray<string>).length).toBeGreaterThan(0);
          expect((db["written"] as ReadonlyArray<string>)[0]).toContain("supabase/migrations/");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a functions-step failure AFTER an earlier slug already downloaded reports that slug's directory as written (a real partial-download case)",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer, capturingStdio } = setup({
          format: "json",
          yes: true,
          api: { functionSlugs: ["hello", "world"], functionBodyFailsForSlug: "world" },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          yield* runPull(pullFlags());

          expect(
            existsSync(join(tempRoot.current, "supabase", "functions", "hello", "index.ts")),
          ).toBe(true);

          const envelope = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
          const steps = envelope["steps"] as Record<string, unknown>;
          const functions = steps["functions"] as Record<string, unknown>;
          expect(functions["status"]).toBe("failed");
          expect(functions["written"]).toEqual(["supabase/functions/hello"]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a functions-step failure reported in TEXT mode inlines the failure message in the summary block",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer, out } = setup({
          yes: true,
          api: { functionsListStatus: 500 },
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false }),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(runPull(pullFlags()));
          expect(Exit.isFailure(exit)).toBe(true);

          expect(stepLine(out!.stdoutText, "config")).toContain("unchanged");
          expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
          expect(stepLine(out!.stdoutText, "db")).toContain("unchanged");
          expect(stepLine(out!.stdoutText, "functions")).toContain("failed");
          expect(out!.stdoutText).toContain("500");
          expect(out!.stdoutText).toContain(
            `To retry just this step, run: supabase functions download --project-ref ${VALID_REF}`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a defect inside a step (not a typed failure) propagates as a defect instead of a captured step failure",
      () => {
        writeConfig();
        seedLocalMigration("20260101000000");
        const { layer } = setup({
          yes: true,
          remoteMigrations: [
            { version: "20260101000000", name: "init", statements: ["select 1;"] },
          ],
          diffOutcome: () => ({ changes: false, die: "pg-delta engine defect" }),
        });
        return Effect.gen(function* () {
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
  // bootstrap ("declined"/"planned" via an empty directory) cases above.
  it.live(
    "--dry-run over an already-populated supabase/migrations reports migration_history as not_needed",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      seedLocalMigration("20260101000000");
      const { layer, out } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* runPull(pullFlags({ dryRun: true }));
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("skipped");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "declining over an already-populated supabase/migrations reports migration_history as not_needed",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      seedLocalMigration("20260101000000");
      const { layer, out } = setup({ stdinIsTty: true, confirm: [false] });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("skipped");
        expect(stepLine(out!.stdoutText, "migration_history")).toContain("not_needed");
      }).pipe(Effect.provide(layer));
    },
  );
});

// The raw `--project-ref` value in `cli_command_executed`'s `flags` map is read from the
// literal argv (`Stdio.args`), a separate source from the `PullFlags` object the handler runs
// on, so each case below overrides `Stdio.args` on top of `setup()`'s default.
describe("pull telemetry wiring", () => {
  const withProjectRefArgs = (base: ReturnType<typeof setup>["layer"], projectRef: string) =>
    Layer.mergeAll(
      base,
      Stdio.layerTest({ args: Effect.succeed(["pull", "--project-ref", projectRef]) }),
    );

  it.live("logs a ref-shaped --project-ref verbatim in cli_command_executed", () => {
    writeConfig();
    const { layer, analytics } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* runPull(pullFlags({ projectRef: Option.some(VALID_REF), dryRun: true }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": VALID_REF });
    }).pipe(Effect.provide(withProjectRefArgs(layer, VALID_REF)));
  });

  it.live("redacts a branch-name-shaped --project-ref in cli_command_executed", () => {
    // `--project-ref` accepts branch names too; a user-created branch name must never reach
    // PostHog verbatim.
    writeConfig();
    const { layer, analytics } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* runPull(pullFlags({ projectRef: Option.some("staging"), dryRun: true }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": "<redacted>" });
    }).pipe(Effect.provide(withProjectRefArgs(layer, "staging")));
  });
});

// `streamJsonOutputLayer` nests the success payload under `data`, but its `fail`
// implementation spreads `MachineErrorContext`'s payload at the top level alongside
// `type`/`error`/`timestamp` — an asymmetry within the same layer.
describe("pull stream-json output", () => {
  it.live(
    "a successful run emits exactly one NDJSON result event with the payload nested under data",
    () => {
      writeConfig("[api]\nmax_rows = 500\n");
      const { layer, capturingStdio } = setup({
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
        yield* runPull(pullFlags());

        expect(capturingStdio!.stdout).toHaveLength(1);
        const event = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        expect(event["type"]).toBe("result");
        expect(event["steps"]).toBeUndefined();
        const data = event["data"] as Record<string, unknown>;
        expect(data["message"]).toContain("Pull complete");
        const steps = data["steps"] as Record<string, unknown>;
        expect((steps["config"] as Record<string, unknown>)["status"]).toBe("changed");
        expect((steps["db"] as Record<string, unknown>)["status"]).toBe("changed");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a partial step failure emits exactly one NDJSON error event with the payload spread at the top level, NOT nested under data",
    () => {
      writeConfig();
      seedLocalMigration("20260101000000");
      const { layer, capturingStdio } = setup({
        format: "stream-json",
        yes: true,
        api: { functionsListStatus: 500 },
        remoteMigrations: [{ version: "20260101000000", name: "init", statements: ["select 1;"] }],
        diffOutcome: () => ({ changes: false }),
      });
      return Effect.gen(function* () {
        yield* runPull(pullFlags());

        expect(capturingStdio!.stdout).toHaveLength(1);
        const event = JSON.parse(capturingStdio!.stdout[0]!) as Record<string, unknown>;
        expect(event["type"]).toBe("error");
        expect(event["data"]).toBeUndefined();
        const error = event["error"] as Record<string, unknown>;
        expect(String(error["message"])).toContain("500");
        const steps = event["steps"] as Record<string, unknown>;
        expect((steps["functions"] as Record<string, unknown>)["status"]).toBe("failed");
        const failure = (steps["functions"] as Record<string, unknown>)["failure"] as Record<
          string,
          unknown
        >;
        expect(String(failure["message"])).toContain("500");
      }).pipe(Effect.provide(layer));
    },
  );
});
