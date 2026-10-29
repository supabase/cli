import { unusedStackServices } from "../../../../tests/helpers/unused-stack.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vitest";

const fixtureNet = vi.hoisted(() => ({ directHostReachable: false }));

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net, fixtureNet)),
);

const reachableDirectHost = withReachableDirectHost(fixtureNet);

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import { describeDbTargetSelection } from "../../../../tests/helpers/db-target-selection.ts";
import { branchListApi } from "../../../../tests/helpers/remote-selection.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { withReachableDirectHost } from "../../../../tests/helpers/refuse-invalid-db-hosts.ts";
import {
  assertBlockDrift,
  assertPermissionDrift,
} from "../../../../tests/helpers/permission-drift.ts";
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
  VALID_REF,
  VALID_TOKEN,
  withConfigEnv,
  withEmptyConfigEnv,
  withEnvVar,
  mockCommandSettings,
  mockDockerDaemonCliSpawner,
  mockLinkedProjectCacheTracked,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  shadowCacheDisabledLayer,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import { HostedMutationDeclinedError } from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { BundledPostgresClient } from "../../../command-internal/bundled-postgres-client.ts";
import { DockerRun, type DockerRunOpts } from "../../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScriptError } from "../../../command-internal/edge-runtime-script.errors.ts";
import {
  type EdgeRuntimeRunOpts,
  EdgeRuntimeScript,
} from "../../../command-internal/edge-runtime-script.service.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../shared/pgdelta-engine.service.ts";
import type { DbPullFlags } from "./pull.command.ts";
import { dbPull } from "./pull.handler.ts";
import { database15, selection } from "../../../../tests/helpers/pins.ts";
import { seedLock, unbundled } from "../../../../tests/helpers/stack-lock.ts";
import { projectStateModeLayer } from "../../../shared/config/project-state-mode.ts";

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

const EXPORT_JSON = JSON.stringify({
  version: 1,
  mode: "declarative",
  files: [{ path: "schemas/public/t.sql", order: 0, statements: 1, sql: "create table t ();" }],
});

// Builds the pg-delta diff envelope: one file per plan unit.
const pgDeltaDiffEnvelope = (
  units: ReadonlyArray<{ name: string; sql: string; transactionMode?: string }>,
): string =>
  JSON.stringify({
    version: 1,
    files: units.map((unit, index) => ({
      order: index + 1,
      name: unit.name,
      transactionMode: unit.transactionMode ?? "transactional",
      sql: unit.sql,
    })),
  });

const PulledSchemaFiles = Schema.Struct({
  schemaWritten: Schema.String,
  schemaFiles: Schema.Array(Schema.String),
});

const PgDeltaPlanEnvelope = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        sql: Schema.String,
        transactionMode: Schema.Literals(["transactional", "none"]),
      }),
    ),
  }),
);

interface SetupOpts {
  readonly env?: Readonly<Record<string, string>>;
  readonly nextDebugDirectory?: string;
  readonly format?: OutputFormat;
  readonly remoteVersions?: ReadonlyArray<string>;
  readonly edgeStdout?: string; // diff SQL or declarative export JSON
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly experimental?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly resolvedRef?: string;
  // Fails the first edge-runtime run with this message (the second succeeds with
  // `edgeStdout`), to exercise the pooler-fallback retry.
  readonly edgeFailFirstWith?: string;
  // `resolvePoolerFallback` returns `Some(pooler conn)` when true, `None` otherwise.
  readonly poolerAvailable?: boolean;
  // Initial-migra pull: the bytes the native pg_dump container streams to its sink, its
  // exit code/stderr, and (when set) an IPv6 stderr that fails the first dump attempt so
  // the pooler retry runs (the second attempt then streams `dumpStdout`).
  readonly dumpStdout?: string;
  readonly dumpExitCode?: number;
  readonly dumpStderr?: string;
  readonly dumpFailFirstWith?: string;
  // Bytes the first dump attempt streams before failing with `dumpFailFirstWith`.
  readonly dumpFailFirstPartialBytes?: string;
  // Raw argv seen by the handler (CliArgs); the explicit `--yes`/`--experimental` scanners read it.
  readonly args?: ReadonlyArray<string>;
  readonly networkId?: string;
  readonly platform?: NodeJS.Platform;
  // `CommandSettings.projectId`; defaults to `Option.some("test")`. Pass
  // `Option.none()` to exercise the config.toml/workdir-basename fallback.
  readonly projectId?: Option.Option<string>;
  // Simulates an unlinked workdir: the project-ref resolver fails with
  // `ProjectRefNotLinkedError` absent an explicit `--remote=<ref>`.
  readonly linkedFails?: boolean;
  // Swaps in the stateful Docker model (real `stop`/`cp`/`start`), required by the
  // shadow baseline cache tests.
  readonly statefulDocker?: boolean;
  readonly migrations?: ReadonlyArray<string>;
  readonly files?: Readonly<Record<string, string>>;
  // Fails the target session's own history upsert (the write `updateMigrationHistory`
  // issues after the migration file is already on disk); the shadow's own internal
  // migration replay is unaffected. Exercises `DbPullWriteError`'s `writtenSoFar`.
  readonly historyUpdateFailWith?: string;
  // Runs the real resolver and linked-project cache; `workdir` must be a real directory.
  readonly realLayers?: boolean;
  readonly remoteTls?: { readonly sslmode: string };
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  // A real docker-spawner fake backs container create/start/health-inspect/cleanup.
  const shadowSpawner = mockShadowContainerCliSpawner();
  // Cache tests need the stateful Docker model since `docker cp` needs real container state.
  const dockerDaemon = opts.statefulDocker === true ? mockDockerDaemonCliSpawner() : undefined;

  const engineCalls: Array<{
    operation: "diff" | "export";
    targetRef: string;
    projectRef?: string;
    projectId: string;
    strictCoverage: boolean;
    debug: boolean;
  }> = [];
  let engineDiffCount = 0;
  const pgDeltaEngine = Layer.succeed(
    PgDeltaEngine,
    PgDeltaEngine.of({
      diffExplicit: () => Effect.die("diffExplicit unused"),
      diffDatabase: (input) => {
        engineCalls.push({
          operation: "diff",
          targetRef: input.target.ref,
          projectRef: input.projectRef,
          projectId: input.context.projectId,
          strictCoverage: input.strictCoverage,
          debug: input.debug,
        });
        engineDiffCount += 1;
        if (opts.edgeFailFirstWith !== undefined && engineDiffCount === 1) {
          return Effect.fail(
            new PgDeltaEngineError({
              message: opts.edgeFailFirstWith,
              cause: opts.edgeFailFirstWith,
            }),
          );
        }
        const stdout = opts.edgeStdout ?? "";
        if (stdout.trim().length === 0) {
          return Effect.succeed({
            changes: false,
            sql: "",
            files: [],
            ...(input.debug
              ? {
                  debug:
                    opts.nextDebugDirectory !== undefined
                      ? { directory: opts.nextDebugDirectory }
                      : {},
                }
              : {}),
          });
        }
        return Schema.decodeEffect(PgDeltaPlanEnvelope)(stdout).pipe(
          Effect.map(({ files }) => ({
            changes: files.length > 0,
            sql: files.map((file) => file.sql).join("\n"),
            files: files.map((file, index) => ({
              sequence: index + 1,
              name: file.name,
              sql: file.sql,
              transactionMode: file.transactionMode,
            })),
          })),
          Effect.mapError(
            (cause) =>
              new PgDeltaEngineError({
                message: "failed to parse pg-delta diff output",
                cause,
              }),
          ),
        );
      },
      exportDeclarativeSchema: (input) => {
        engineCalls.push({
          operation: "export",
          targetRef: input.target.ref,
          projectRef: input.projectRef,
          projectId: input.context.projectId,
          strictCoverage: input.strictCoverage,
          debug: input.debug,
        });
        if (opts.edgeFailFirstWith !== undefined && engineCalls.length === 1) {
          return Effect.fail(
            new PgDeltaEngineError({
              message: opts.edgeFailFirstWith,
              cause: opts.edgeFailFirstWith,
            }),
          );
        }
        return Effect.succeed({
          files: [{ name: "public/t.sql", sql: "create table t ();" }],
          manifest: {
            redactSecrets: true,
            scope: "database",
            profile: "supabase",
          },
        });
      },
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema unused"),
    }),
  );

  let edgeRunCount = 0;
  const edgeCalls: EdgeRuntimeRunOpts[] = [];
  const spawnedBeforeEdgeRun: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
  const edge = Layer.succeed(EdgeRuntimeScript, {
    run: (runOpts: EdgeRuntimeRunOpts) => {
      edgeRunCount += 1;
      edgeCalls.push(runOpts);
      spawnedBeforeEdgeRun.push(shadowSpawner.spawned.map((call) => call.args));
      if (opts.edgeFailFirstWith !== undefined && edgeRunCount === 1) {
        return Effect.fail(new EdgeRuntimeScriptError({ message: opts.edgeFailFirstWith }));
      }
      return Effect.succeed({ stdout: opts.edgeStdout ?? "", stderr: "" });
    },
  });

  // The initial-migra pull seeds the migration via a native pg_dump `runStream`;
  // delivers configured bytes to `onStdout` then reports exit code + stderr.
  // `dumpFailFirstWith` fails the first attempt so the pooler retry runs.
  const dumpCalls: Array<{
    env: Readonly<Record<string, string>>;
    image: string;
    network: DockerRunOpts["network"];
  }> = [];
  let dumpRunCount = 0;
  const docker = Layer.succeed(DockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: (runOpts, streamOpts) =>
      Effect.gen(function* () {
        // The shadow's own PG15+ one-shot jobs share this `runStream` but always set
        // `skipImageResolve: true`; succeed them unconditionally so they're never
        // counted alongside the real `dumpCalls` this suite asserts on.
        if (runOpts.skipImageResolve === true) {
          return { exitCode: 0, stderr: "" };
        }
        dumpRunCount += 1;
        dumpCalls.push({ env: runOpts.env, image: runOpts.image, network: runOpts.network });
        if (opts.dumpFailFirstWith !== undefined && dumpRunCount === 1) {
          if (opts.dumpFailFirstPartialBytes !== undefined) {
            const partial = new TextEncoder().encode(opts.dumpFailFirstPartialBytes);
            if (partial.length > 0) yield* streamOpts.onStdout(partial);
          }
          return { exitCode: 1, stderr: opts.dumpFailFirstWith };
        }
        const bytes = new TextEncoder().encode(opts.dumpStdout ?? "");
        if (bytes.length > 0) yield* streamOpts.onStdout(bytes);
        return { exitCode: opts.dumpExitCode ?? 0, stderr: opts.dumpStderr ?? "" };
      }),
  });

  const execLog: string[] = [];
  const historyUpserts: ReadonlyArray<unknown>[] = [];
  const connectedDatabases: Array<string> = [];
  /** Same connects as {@link connectedDatabases}, keeping the port that tells target from shadow apart. */
  const connectTargets: Array<{ readonly database: string; readonly port: number }> = [];
  // The resolver mock's target connection always dials port 5432; the shadow always
  // dials the schema-default shadow port (54320) instead — a reliable way to tell the
  // target's own history upsert (what `historyUpserts` counts) apart from the shadow's
  // internal migration replay, which issues the same parameterized query into its own
  // separate history table.
  const TARGET_PORT = 5432;
  const makeSession = (isShadow: boolean): DbSession => {
    const exec = (sql: string) => Effect.sync(() => void execLog.push(sql));
    const query = (sql: string, params?: ReadonlyArray<unknown>) => {
      if (/SELECT version/u.test(sql)) {
        return Effect.succeed((opts.remoteVersions ?? []).map((v) => ({ version: v })));
      }
      if (!isShadow && params !== undefined) {
        if (opts.historyUpdateFailWith !== undefined) {
          return Effect.fail(new DbExecError({ message: opts.historyUpdateFailWith }));
        }
        historyUpserts.push(params);
      }
      return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
    };
    return {
      exec,
      query,
      // A migration batch carries exactly the statements (and the parameterized
      // history insert) the sequential path would run, so route each operation
      // through the same recording.
      execBatch: (statements) =>
        Effect.forEach(statements, ({ sql, params }) =>
          params === undefined ? exec(sql) : query(sql, params),
        ).pipe(Effect.asVoid),
      extensionExists: () => Effect.die("extensionExists unused"),
      copyToCsv: () => Effect.die("copyToCsv unused"),
      queryRaw: () => Effect.die("queryRaw unused"),
    };
  };
  const targetSession = makeSession(false);
  const shadowSession = makeSession(true);
  const dbConnection = Layer.succeed(DbConnection, {
    connect: (cfg: { readonly database: string; readonly port: number }) =>
      Effect.sync(() => {
        connectedDatabases.push(cfg.database);
        connectTargets.push({ database: cfg.database, port: cfg.port });
        return cfg.port === TARGET_PORT ? targetSession : shadowSession;
      }),
  });

  const poolerFallbackCalls: unknown[] = [];
  const resolveCalls: Array<DbConnectionInput> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      resolveCalls.push(input);
      const isLocal = input.target.kind === "local";
      return Effect.succeed({
        conn: {
          // A direct `db.<ref>.<projectHost>` host so the pooler-fallback gate
          // matches on the linked path.
          host: isLocal ? "127.0.0.1" : "db.abcdefghijklmnopqrst.supabase.co",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
          ...opts.remoteTls,
        },
        isLocal,
        ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: (resolveFlags) => {
      poolerFallbackCalls.push(resolveFlags);
      return Effect.succeed(
        opts.poolerAvailable === true
          ? Option.some({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 6543,
              user: "postgres",
              password: "x",
              database: "postgres",
            })
          : Option.none(),
      );
    },
  });

  const projectRefResolver = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(opts.resolvedRef ?? VALID_REF),
    resolveForLink: () => Effect.succeed(opts.resolvedRef ?? VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed({ ref: flagValue.value, source: "flag", matchesLinkedRef: false })
        : opts.linkedFails === true
          ? Effect.fail(new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
          : Effect.succeed({
              ref: opts.resolvedRef ?? VALID_REF,
              source: "file",
              matchesLinkedRef: true,
            }),
    resolveOptional: () => Effect.succeed(Option.some(opts.resolvedRef ?? VALID_REF)),
    promptProjectRef: () => Effect.succeed(opts.resolvedRef ?? VALID_REF),
  });

  const workdirFiles = Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const version of opts.migrations ?? []) {
        yield* seedMigration(workdir, version);
      }
      for (const [file, content] of Object.entries(opts.files ?? {})) {
        yield* fs.makeDirectory(path.dirname(path.join(workdir, file)), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, file), content);
      }
    }),
  ).pipe(Layer.provide(BunServices.layer));

  const projectHttp = recordingProjectHttpClient(VALID_REF);
  const engineLayer = Layer.mergeAll(
    unusedStackServices,
    // Listed first so the fake service layers below (`Layer.mergeAll` is last-wins)
    // override its real implementations, matching `start.integration.test.ts`.
    BunServices.layer,
    pgDeltaEngine,
    edge,
    docker,
    Layer.succeed(BundledPostgresClient, {
      run: () => Effect.die("bundled postgres client unused"),
    }),
    dbConnection,
    dockerDaemon?.layer ?? shadowSpawner.layer,
    alwaysReadyHttpClientLayer,
    resolver,
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(NetworkIdFlag, Option.fromUndefinedOr(opts.networkId)),
    Layer.succeed(PgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    mockRuntimeInfo(opts.platform === undefined ? {} : { platform: opts.platform }),
    workdirFiles,
    shadowCacheDisabledLayer,
  );
  const baseLayer = Layer.mergeAll(
    engineLayer,
    out.layer,
    configValuesLayer({
      output: out.layer,
      env: opts.env,
    }),
    telemetry.layer,
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: projectHttp.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : cache.layer,
    ...(opts.realLayers === true
      ? [
          realDbConfigResolver({
            workdir,
            dbConnection,
            env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
          }),
        ]
      : []),
    projectRefResolver,
    mockCommandSettings({
      workdir,
      projectId: opts.projectId ?? Option.some("test"),
      ...(opts.realLayers === true ? { projectHost: "invalid" } : {}),
    }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    mockStdin(opts.stdinIsTty ?? false),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "no" }),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
  );
  return {
    layer: baseLayer,
    engineLayer,
    out,
    historyUpserts,
    execLog,
    connectedDatabases,
    connectTargets,
    poolerFallbackCalls,
    resolveCalls,
    dumpCalls,
    engineCalls,
    shadowSpawned: shadowSpawner.spawned,
    dockerDaemon,
    get edgeRunCount() {
      return edgeRunCount;
    },
    edgeCalls,
    spawnedBeforeEdgeRun,
    cache,
    projectHttp,
  };
}

const REMOTE_LINKED: DbPullFlags["remote"] = Option.some({ _tag: "Linked" });

const flags = (over: Partial<DbPullFlags> = {}): DbPullFlags => ({
  name: over.name ?? Option.none(),
  declarative: over.declarative ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  diffEngine: over.diffEngine ?? Option.none(),
  strictCoverage: over.strictCoverage ?? false,
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const streamText = (out: ReturnType<typeof mockOutput>, stream: "stdout" | "stderr") =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === stream)
      .map((c) => c.text)
      .join(""),
  );

const seedMigration = (workdir: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(workdir, "supabase", "migrations");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, `${version}_local.sql`), "create table local ();\n");
  });

const migrationFiles = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(workdir, "supabase", "migrations");
    return (yield* fs.exists(dir)) ? (yield* fs.readDirectory(dir)).sort() : [];
  });

const readFileText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(file));
  });

const tmp = useTempWorkdir();

describe("db pull", () => {
  it.effect("pulls a migration (pgdelta engine) and updates remote history under --yes", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([
        {
          name: "schema_changes",
          sql: "-- Migration unit 1: schema_changes\n\ncreate table remote ();",
        },
      ]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta"), strictCoverage: true }),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      expect(yield* fs.exists(path.join(dir, `${"20240101000000"}_local.sql`))).toBe(true);
      const written = (yield* fs.readDirectory(dir)).filter((f) =>
        f.endsWith("_remote_schema.sql"),
      );
      expect(written).toHaveLength(1);
      expect(yield* readFileText(path.join(dir, written[0] ?? ""))).toContain(
        "create table remote ();",
      );
      expect(streamText(s.out, "stderr")).toContain(
        `Schema written to ${path.join("supabase", "migrations", written[0] ?? "")}\n`,
      );
      expect(streamText(s.out, "stderr")).not.toContain(tmp.current);
      expect(s.historyUpserts.length).toBe(1);
      expect(s.engineCalls).toHaveLength(1);
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(s.engineCalls[0]?.strictCoverage).toBe(true);
      expect(s.edgeRunCount).toBe(0);
      expect(streamText(s.out, "stdout")).toContain("Finished supabase db pull.");
      // The linked ref is pre-loaded before `resolve()` runs, so the cache still gets
      // it, matching the `db reset`/`db push` pattern.
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --remote=<ref> on the declarative export", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(
        flags({
          declarative: Option.some(true),
          remote: Option.some({ _tag: "Ref", ref: FLAG_REF } as const),
        }),
      );
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.engineCalls[0]?.projectRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  describeDbTargetSelection("db pull", {
    dbUrl: true,
    workdir: () => tmp.current,
    activeFlags: { declarative: true },
    attempt: ({ workdir, target }) => {
      const s = setup(workdir, { edgeStdout: EXPORT_JSON, projectId: Option.some(VALID_REF) });
      const branchApi = branchListApi();
      return {
        layer: Layer.merge(s.layer, branchApi.layer),
        out: s.out,
        run: dbPull(flags({ declarative: Option.some(true), ...target })),
        target: () => s.resolveCalls[0]?.target,
        cachedRef: () => s.cache.cachedRef,
        branchLookups: () => branchApi.requests,
        apiRequests: () => branchApi.requests,
      };
    },
  });

  it.effect(
    "a pg-delta plan with transaction boundaries writes one ordered migration file per unit",
    () => {
      // e.g. ALTER TYPE ... ADD VALUE followed by a statement using the new value.
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        remoteVersions: ["20240101000000"],
        edgeStdout: pgDeltaDiffEnvelope([
          { name: "schema_changes", sql: "-- unit 1\n\nalter type mood add value 'ok';" },
          { name: "after_enum_values", sql: "-- unit 2\n\ninsert into t values ('ok');" },
          {
            name: "non_transactional",
            transactionMode: "none",
            sql: "-- pg-delta: transaction=false\n-- unit 3\n\ncreate index concurrently i on t (c);",
          },
        ]),
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(tmp.current, "supabase", "migrations");
        const written = (yield* fs.readDirectory(dir))
          .filter((f) => f !== "20240101000000_local.sql")
          .sort();
        expect(written).toHaveLength(3);
        expect(written[0]).toMatch(/^\d{14}_remote_schema_schema_changes\.sql$/u);
        expect(written[1]).toMatch(/^\d{14}_remote_schema_after_enum_values\.sql$/u);
        expect(written[2]).toMatch(/^\d{14}_remote_schema_non_transactional\.sql$/u);
        const versions = written.map((f) => f.slice(0, 14));
        expect((versions[0] ?? "") < (versions[1] ?? "")).toBe(true);
        expect((versions[1] ?? "") < (versions[2] ?? "")).toBe(true);
        const nonTransactional = yield* readFileText(path.join(dir, written[2] ?? ""));
        expect(nonTransactional.startsWith("-- pg-delta: transaction=false\n")).toBe(true);
        expect(nonTransactional).toContain("create index concurrently i on t (c);");
        const err = streamText(s.out, "stderr");
        expect(err.match(/Schema written to/gu)).toHaveLength(3);
        for (const file of written) {
          expect(err).toContain(`Schema written to ${path.join("supabase", "migrations", file)}\n`);
        }
        expect(s.historyUpserts.length).toBe(3);
        expect(streamText(s.out, "stderr")).toContain(
          `Repaired migration history: [${versions.join(" ")}] => applied`,
        );
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a multi-unit pg-delta pull reports every written migration path in the json payload",
    () => {
      // Lists every written path, not just the first (`schemaWritten`).
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        format: "json",
        remoteVersions: ["20240101000000"],
        edgeStdout: pgDeltaDiffEnvelope([
          { name: "schema_changes", sql: "-- unit 1\n\nalter type mood add value 'ok';" },
          { name: "after_enum_values", sql: "-- unit 2\n\ninsert into t values ('ok');" },
          {
            name: "non_transactional",
            transactionMode: "none",
            sql: "-- unit 3\n\ncreate index concurrently i on t (c);",
          },
        ]),
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }));
        const success = s.out.messages.find((m) => m.type === "success");
        const data = yield* Schema.decodeUnknownEffect(PulledSchemaFiles)(success?.data);
        expect(data.schemaFiles).toHaveLength(3);
        expect(data.schemaFiles[0]).toMatch(/_remote_schema_schema_changes\.sql$/u);
        expect(data.schemaFiles[1]).toMatch(/_remote_schema_after_enum_values\.sql$/u);
        expect(data.schemaFiles[2]).toMatch(/_remote_schema_non_transactional\.sql$/u);
        expect(data.schemaWritten).toBe(data.schemaFiles[0]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a malformed pg-delta diff envelope surfaces a parse error, not 'in sync'", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "not a valid envelope{",
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.flip);
      expect(error.message).toContain("failed to parse pg-delta diff output");
      expect(error.message).not.toContain("No schema changes found");
    }).pipe(Effect.provide(s.layer));
  });

  // Migra (and the legacy pg-delta opt-out) still substitute the declared-schema
  // `contrib_regression` target locally, so schema_paths still shapes their output —
  // only the next engine's pull prints this warning.
  it.effect("pulls with the next engine and warns that schema_paths no longer applies", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      files: {
        "supabase/config.toml": [
          "[db.migrations]",
          'schema_paths = ["database/*.sql"]',
          "",
          "[experimental.pgdelta]",
          "enabled = true",
          "",
        ].join("\n"),
      },
      remoteVersions: ["20240101000000"],
      // The next engine's mock parses `edgeStdout` as a rendered-file envelope.
      edgeStdout: JSON.stringify({
        files: [
          {
            name: "schema_changes",
            transactionMode: "transactional",
            sql: "create table remote ();\n",
          },
        ],
      }),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED }));
      expect(streamText(s.out, "stderr")).toContain(
        "schema_paths no longer changes the migrations baseline",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pulls with migra and does not warn about schema_paths", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      files: {
        "supabase/config.toml": [
          "[db.migrations]",
          'schema_paths = ["database/*.sql"]',
          "",
          "[experimental.pgdelta]",
          "enabled = false",
          "",
        ].join("\n"),
      },
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED }));
      // `enabled = false` selecting migra is proven by `edgeStdout` parsing as raw SQL
      // (a pg-delta selection would instead try — and fail — to `JSON.parse` it).
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).not.toContain("schema_paths no longer changes the migrations baseline");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      const file = (yield* fs.readDirectory(dir)).find((f) => f.endsWith("_remote_schema.sql"));
      expect(err).toContain(
        `Schema written to ${path.join("supabase", "migrations", file ?? "")}\n`,
      );
      expect(err).not.toContain(tmp.current);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false selects migra for a migration-style pull",
    () => {
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        env: { SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false" },
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED }));
        expect(s.engineCalls).toHaveLength(0);
        expect(s.edgeCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("creates the labeled Deno-cache volume before the migra run mounts it", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
      env: { SUPABASE_PROJECT_ID: "test" },
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      expect(s.edgeCalls).toHaveLength(1);
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
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
      files: { "supabase/.env": "BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n" },
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      expect(s.edgeCalls).toHaveLength(1);
      expect(
        s.shadowSpawned.filter(
          (call) => call.args[0] === "volume" && call.args.includes("supabase_edge_runtime_test"),
        ),
      ).toEqual([]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      const file = (yield* fs.readDirectory(dir)).find((f) => f.endsWith("_remote_schema.sql"));
      expect(yield* readFileText(path.join(dir, file ?? ""))).toContain("create table remote ();");
      expect(streamText(s.out, "stdout")).toContain("Finished supabase db pull.");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "validates the shadow's own local config (api.tls cert file) BEFORE resolving the connection",
    () => {
      // `api.tls`'s cert/key files are only validated by `buildLocalDbContainerInputs`,
      // which must run strictly before `resolver.resolve()` — `resolveCalls` staying
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
        remoteVersions: [],
        edgeStdout: "",
      });
      return Effect.gen(function* () {
        const error = yield* dbPull(flags({ remote: REMOTE_LINKED })).pipe(Effect.flip);
        expect(error.message).toContain("failed to read TLS cert");
        expect(s.resolveCalls).toHaveLength(0);
        expect(s.connectedDatabases).toHaveLength(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative exports declarative files (no migration)", () => {
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON });
    return Effect.gen(function* () {
      yield* dbPull(
        flags({ remote: REMOTE_LINKED, declarative: Option.some(true), strictCoverage: true }),
      );
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.engineCalls[0]?.strictCoverage).toBe(true);
      expect(s.edgeRunCount).toBe(0);
      const err = streamText(s.out, "stderr");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Prints the relative default, not the resolved absolute directory
      // (established output contract).
      expect(err).toContain(`Declarative schema written to ${path.join("supabase", "schemas")}\n`);
      expect(err).not.toContain(tmp.current);
      expect(
        yield* fs.exists(path.join(tmp.current, "supabase", "schemas", "public", "t.sql")),
      ).toBe(true);
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* readFileText(
            path.join(tmp.current, "supabase", "schemas", ".pgdelta-export.json"),
          ),
        ),
      ).toMatchObject({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["public/t.sql"],
      });
      // Declarative export reads only the live target; no shadow is provisioned.
      expect(s.connectTargets).toEqual([{ database: "postgres", port: 5432 }]);
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(0);
      expect(s.shadowSpawned.filter((call) => call.args[0] === "rm")).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("declarative export does not provision a baseline shadow", () => {
    const s = setup(tmp.current, {});
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect.each([
    { value: "1", debug: true },
    { value: "", debug: false },
  ])('declarative export passes PGDELTA_DEBUG="$value" to pg-delta', ({ value, debug }) => {
    const s = setup(tmp.current, {});
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      expect(s.engineCalls.map((call) => call.debug)).toEqual([debug]);
    }).pipe(Effect.provide(s.layer), (body) => withConfigEnv({ PGDELTA_DEBUG: value }, body));
  });

  it.effect(
    "pull --declarative writes [db.migrations] schema_paths when pg-delta is disabled",
    () => {
      // Points schema_paths at the declarative dir so later db reset/db diff read the
      // pulled files (pg-delta stays disabled).
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n",
        },
        edgeStdout: EXPORT_JSON,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
        const path = yield* Path.Path;
        const config = yield* readFileText(path.join(tmp.current, "supabase", "config.toml"));
        expect(config).toContain("[db.migrations]");
        expect(config).toContain('schema_paths = [\n  "schemas",\n]');
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("pull --declarative leaves schema_paths untouched when pg-delta is enabled", () => {
    // An enabled config already treats the declarative dir as source of truth, so the
    // rewrite is skipped.
    const original = "[experimental.pgdelta]\nenabled = true\n";
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml": original,
      },
      edgeStdout: EXPORT_JSON,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      const path = yield* Path.Path;
      const config = yield* readFileText(path.join(tmp.current, "supabase", "config.toml"));
      expect(config).toBe(original);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("pull --declarative replaces an existing schema_paths block in place", () => {
    // A regex replace-or-append rewrites a present schema_paths block rather than
    // appending a duplicate.
    const s = setup(tmp.current, {
      files: {
        "supabase/config.toml":
          '[experimental.pgdelta]\nenabled = false\n\n[db.migrations]\nschema_paths = [\n  "schemas/*.sql",\n]\n',
      },
      edgeStdout: EXPORT_JSON,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      const path = yield* Path.Path;
      const config = yield* readFileText(path.join(tmp.current, "supabase", "config.toml"));
      expect(config).toContain('schema_paths = [\n  "schemas",\n]');
      expect(config).not.toContain("schemas/*.sql");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("passes the config/workdir-resolved project id to the pg-delta engine", () => {
    // Absent env/config project_id, the workdir basename must reach the pg-delta
    // engine's project id, including on the declarative-export path (read before any
    // local shadow diff starts) — not an empty string from `CommandSettings.projectId`
    // alone.
    const s = setup(tmp.current, { edgeStdout: EXPORT_JSON, projectId: Option.none() });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const expectedProjectId = path.basename(tmp.current);
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.projectId).toBe(expectedProjectId);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a linked [remotes.<ref>]'s project_id outranks a conflicting SUPABASE_PROJECT_ID",
    () => {
      // An ambient `SUPABASE_PROJECT_ID` for an unrelated project must not replace the linked
      // remote's ref as the engine's project id.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": [
            "[remotes.staging]",
            'project_id = "abcdefghijklmnopqrst"',
            "",
          ].join("\n"),
        },
        edgeStdout: EXPORT_JSON,
        resolvedRef: "abcdefghijklmnopqrst",
        projectId: Option.some("unrelated-env-project"),
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ declarative: Option.some(true), remote: REMOTE_LINKED }));
        expect(s.engineCalls[0]?.projectId).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a migration-history conflict fails with the repair suggestion", () => {
    const s = setup(tmp.current, {
      migrations: ["20240102000000"],
      remoteVersions: ["20240101000000"],
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(flags({ remote: REMOTE_LINKED })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an initial pull (no local migrations, migra) dumps the schema natively then appends the diff",
    () => {
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "create table diffed ();\n", // the migra second pass
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
        // pg_dump ran with the schema-dump env (internal-schema exclude + comment strip).
        expect(s.dumpCalls).toHaveLength(1);
        expect(s.dumpCalls[0]?.env["EXTRA_SED"]).toBe("/^--/d");
        expect(s.dumpCalls[0]?.env["EXCLUDED_SCHEMAS"]).toContain("auth");
        expect(s.shadowSpawned.filter((call) => call.args[0] === "create")).toHaveLength(1);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The migration file holds the dump output followed by the appended diff.
        const dir = path.join(tmp.current, "supabase", "migrations");
        const file = (yield* fs.readDirectory(dir)).find((f) => f.endsWith("_remote_schema.sql"));
        expect(file).toBeDefined();
        const content = yield* readFileText(path.join(dir, file ?? ""));
        expect(content).toContain("create table dumped ();");
        expect(content).toContain("create table diffed ();");
        expect(content.indexOf("dumped")).toBeLessThan(content.indexOf("diffed"));
        // stderr order: dump → shadow → diff → written.
        const err = streamText(s.out, "stderr");
        expect(err).toContain("Dumping schema from remote database...");
        expect(err).toContain("Creating shadow database...");
        expect(err).toContain(
          `Schema written to ${path.join("supabase", "migrations", file ?? "")}\n`,
        );
        expect(err.indexOf("Dumping schema")).toBeLessThan(err.indexOf("Creating shadow"));
        expect(s.historyUpserts.length).toBe(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an initial pull hands the linked project's TLS settings to pg_dump", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
      yes: true,
      remoteTls: { sslmode: "verify-full" },
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      expect(s.dumpCalls[0]?.env).toMatchObject({ PGSSLMODE: "verify-full" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial pull in json mode emits a native structured envelope", () => {
    const s = setup(tmp.current, {
      format: "json",
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      const success = s.out.messages.find((m) => m.type === "success");
      // `schemaWritten` is the real native path (not null as when delegated).
      expect(success?.data).toMatchObject({
        declarative: false,
        remoteHistoryUpdated: true,
        engine: "migra",
      });
      const data = yield* Schema.decodeUnknownEffect(PulledSchemaFiles)(success?.data);
      expect(data.schemaWritten).toMatch(/_remote_schema\.sql$/u);
      // Single-unit case: exactly one path, matching `schemaWritten`.
      expect(data.schemaFiles).toHaveLength(1);
      expect(data.schemaFiles[0]).toBe(data.schemaWritten);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial pull swallows an empty migra diff once the dump wrote content", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "", // empty migra diff
      yes: true,
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      const file = (yield* fs.readDirectory(dir)).find((f) => f.endsWith("_remote_schema.sql"));
      expect(file).toBeDefined();
      expect(yield* readFileText(path.join(dir, file ?? ""))).toContain("create table dumped ();");
      expect(streamText(s.out, "stderr")).toContain(
        `Schema written to ${path.join("supabase", "migrations", file ?? "")}\n`,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an initial pull surfaces a crashed migra script instead of the dump-only migration",
    () => {
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        edgeFailFirstWith:
          "error diffing schema: error running script:\nTypeError: Cannot read properties of undefined (reading 'constraints')\nPGDELTA_SCRIPT_ERROR\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const error = yield* dbPull(
          flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
        ).pipe(Effect.flip);
        expect(error.message).toContain("Cannot read properties of undefined");
        expect(error.message).not.toContain("No schema changes found");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an initial pull with an empty schema reports 'No schema changes found'", () => {
    // A leftover zero-byte `<timestamp>_remote_schema.sql` seed file is a phantom local
    // migration with no remote counterpart; `--with-migration-history` can't clear it
    // since fetching empty remote history never deletes local files.
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "",
      edgeStdout: "",
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.flip);
      expect(error.message).toBe("No schema changes found");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(tmp.current, "supabase", "migrations");
      expect((yield* fs.exists(dir)) ? yield* fs.readDirectory(dir) : []).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "two consecutive initial pulls against an empty remote history both report 'No schema changes found' with no leftover seed file",
    () => {
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "",
        edgeStdout: "",
        yes: true,
      });
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const dir = path.join(tmp.current, "supabase", "migrations");
        const first = yield* dbPull(
          flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
        ).pipe(Effect.flip);
        expect(first.message).toBe("No schema changes found");
        const fs = yield* FileSystem.FileSystem;
        expect((yield* fs.exists(dir)) ? yield* fs.readDirectory(dir) : []).toEqual([]);

        // Without the cleanup, the leftover seed file would desync this second run's
        // reconciliation: an empty remote history plus a local-only version is a
        // `DbPullMigrationConflictError`, not a repeat "No schema changes found".
        const second = yield* dbPull(
          flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
        ).pipe(Effect.flip);
        expect(second).toMatchObject({
          _tag: "DbPullInSyncError",
          message: "No schema changes found",
        });
        expect((yield* fs.exists(dir)) ? yield* fs.readDirectory(dir) : []).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "an initial-pull direct write that IPv6-fails then an empty pooler retry reports 'No schema changes found'",
    () => {
      // The file is truncated before the pooler retry, and in-sync is decided from the
      // file on disk, so an empty retry + empty diff is in sync, not a schema write. The
      // sticky `seedWroteBytes` flag must reset per attempt.
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpFailFirstWith: "could not translate host name: network is unreachable",
        dumpFailFirstPartialBytes: "-- partial preamble\n",
        dumpStdout: "", // pooler retry streams nothing
        edgeStdout: "", // empty migra diff
        poolerAvailable: true,
        yes: true,
      });
      return Effect.gen(function* () {
        const error = yield* dbPull(
          flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
        ).pipe(Effect.flip);
        expect(error.message).toBe("No schema changes found");
        expect(s.dumpCalls).toHaveLength(2); // direct attempt + pooler retry
        expect(s.historyUpserts).toHaveLength(0); // no migration-history row written
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("an initial pull fails when the pg_dump container exits non-zero", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpExitCode: 1,
      dumpStderr: "connection refused",
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.flip);
      expect(error.message).toContain("error running container: exit 1");
      // The diff pass never ran — the dump failure aborts before provisioning a shadow.
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial-pull dump retries via the IPv4 pooler on an IPv6 failure", () => {
    // A `--remote` direct-host dump that fails over IPv6 retries once through the
    // transaction pooler.
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpFailFirstWith: "could not translate host name: network is unreachable",
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
      poolerAvailable: true,
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      expect(s.dumpCalls).toHaveLength(2); // direct attempt + pooler retry
      expect(s.poolerFallbackCalls).toHaveLength(1);
      const err = streamText(s.out, "stderr");
      expect(err).toContain("does not support IPv6");
      expect(err).toContain("Retrying via the IPv4 connection pooler");
      // Printed once, before the fallback, not re-printed on the pooler retry.
      expect(err.match(/Dumping schema from remote database/gu)).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial-pull IPv6 dump failure with no pooler surfaces the dump error", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpExitCode: 1,
      dumpStderr: "could not translate host name: network is unreachable",
      poolerAvailable: false,
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.flip);
      expect(error.message).toContain("error running container: exit 1");
      expect(s.poolerFallbackCalls).toHaveLength(1); // gate checked, no pooler resolved
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an in-sync pull (empty diff) fails with 'No schema changes found'", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "",
    });
    return Effect.gen(function* () {
      // The message and non-zero exit are the contract; the generic --debug footer is
      // replaced with this explanation instead.
      const error = yield* dbPull(flags({ remote: REMOTE_LINKED })).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DbPullInSyncError",
        message: "No schema changes found",
        suggestion:
          "The remote database is already in sync with your local migrations — nothing to pull.",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an empty pg-delta diff without PGDELTA_DEBUG writes no debug bundle", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "",
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.flip);
      expect(error.message).toBe("No schema changes found");
      expect(s.engineCalls.map((call) => call.debug)).toEqual([false]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const debugRoot = path.join(tmp.current, "supabase", ".temp", "pgdelta", "debug");
      expect((yield* fs.exists(debugRoot)) ? yield* fs.readDirectory(debugRoot) : []).toEqual([]);
    }).pipe(Effect.provide(s.layer), withEmptyConfigEnv);
  });

  it.effect("reports the next-generation debug directory for an empty pg-delta diff", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const debugDir = path.join(
        tmp.current,
        "supabase",
        ".temp",
        "pgdelta",
        "v2",
        "debug",
        "20240102-030405-678-diff",
      );
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        remoteVersions: ["20240101000000"],
        edgeStdout: "",
        nextDebugDirectory: debugDir,
      });
      const error = yield* withConfigEnv(
        { PGDELTA_DEBUG: "1" },
        dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") })).pipe(
          Effect.flip,
          Effect.provide(s.layer),
        ),
      );
      expect(error.message).toBe(`No schema changes found (debug bundle: ${debugDir})`);
      expect(streamText(s.out, "stderr")).toContain(`Debug information saved to`);
      expect(streamText(s.out, "stderr")).toContain(debugDir);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("asks once before writing and records the migration on yes (tty)", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
      promptConfirmResponses: [true],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      expect(s.out.promptConfirmCalls).toHaveLength(1);
      expect(s.out.promptConfirmCalls[0]?.message).toContain(
        "Update the remote migration history table",
      );
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an initial migra pull asks before the dump writes anything", () => {
    const s = setup(tmp.current, {
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "create table diffed ();\n",
      stdinIsTty: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(HostedMutationDeclinedError);
      expect(s.dumpCalls).toHaveLength(0);
      expect(yield* migrationFiles(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a pg-delta pull lists the planned file count and writes nothing when declined", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([
        { name: "schema_changes", sql: "alter type mood add value 'ok';" },
        { name: "after_enum_values", sql: "insert into t values ('ok');" },
      ]),
      stdinIsTty: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(HostedMutationDeclinedError);
      expect(streamText(s.out, "stderr")).toContain(
        "Write 2 migration files to supabase/migrations.",
      );
      expect(yield* migrationFiles(tmp.current)).toEqual(["20240101000000_local.sql"]);
      expect(s.historyUpserts.length).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an in-sync pull asks for no consent", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "",
      stdinIsTty: true,
    });
    return Effect.gen(function* () {
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DbPullInSyncError" });
      expect(s.out.promptConfirmCalls).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a local target records the migration without asking", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      stdinIsTty: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.out.promptConfirmCalls).toHaveLength(0);
      expect(s.historyUpserts.length).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "a remote-history update failure after a successful write reports the written migration path (CLI-1272)",
    () => {
      // The migration write succeeds; only the subsequent history-table write fails.
      // The resulting `DbPullWriteError` must still carry the already-written path via
      // `writtenSoFar`, not report the write as if nothing happened.
      const s = setup(tmp.current, {
        remoteVersions: [],
        dumpStdout: "",
        edgeStdout: "create table remote ();\n",
        yes: true,
        historyUpdateFailWith: "connection reset by peer",
      });
      return Effect.gen(function* () {
        const error = yield* dbPull(
          flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DbPullWriteError" });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(tmp.current, "supabase", "migrations");
        const file = (yield* fs.readDirectory(dir)).find((f) => f.endsWith("_remote_schema.sql"));
        expect(file).toBeDefined();
        const writtenPath = path.join(dir, file ?? "");
        // Confirms the failure happened after the write, not instead of it.
        expect(yield* fs.exists(writtenPath)).toBe(true);
        expect(error).toMatchObject({ writtenSoFar: [writtenPath] });
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("emits a json envelope and suppresses 'Finished' in machine mode", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      format: "json",
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
      expect(streamText(s.out, "stdout")).not.toContain("Finished supabase db pull.");
      // Diagnostics still go to stderr in machine mode; stdout stays payload-only.
      expect(streamText(s.out, "stderr")).toContain("Schema written to");
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ declarative: false, remoteHistoryUpdated: true });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "resolves the pg_dump image via SUPABASE_INTERNAL_IMAGE_REGISTRY from supabase/.env",
    () => {
      // Passed explicitly to the native pg_dump seed, so a mirror set only in
      // supabase/.env is used without mutating process.env.
      const s = setup(tmp.current, {
        files: {
          "supabase/.env": "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\n",
        },
        remoteVersions: [], // no remote history → initial-migra pg_dump path
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
        expect(s.dumpCalls.length).toBeGreaterThanOrEqual(1);
        // The pg_dump container image is rewritten to the configured mirror.
        expect(s.dumpCalls[0]?.image).toMatch(/^my-mirror\.example\.com\/supabase\//u);
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            { SUPABASE_SHADOW_CACHE: "0" },
            { preserveEmptyStrings: true },
          ),
        ),
        Effect.provide(s.layer),
      );
    },
  );

  describe("in stack state mode", () => {
    const remoteMajorConfig = [
      "[db]",
      "major_version = 15",
      "[remotes.staging]",
      `project_id = "${VALID_REF}"`,
      "[remotes.staging.db]",
      "major_version = 17",
      "",
    ].join("\n");

    it.effect(
      "dumps the initial remote pull with the image of the matching [remotes.<ref>] major",
      () => {
        const s = setup(tmp.current, {
          files: { "supabase/config.toml": remoteMajorConfig },
          remoteVersions: [],
          dumpStdout: "create table dumped ();\n",
          yes: true,
        });
        return Effect.gen(function* () {
          yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
          expect(s.dumpCalls[0]?.image).toBe(selection.database.image);
          expect(s.dumpCalls[0]?.image).not.toBe(database15.image);
        }).pipe(Effect.provide(Layer.merge(s.layer, projectStateModeLayer("stack"))));
      },
    );

    it.effect(
      "dumps with the remote major's bundled image when the project lock records the local major",
      () => {
        const s = setup(tmp.current, {
          files: { "supabase/config.toml": remoteMajorConfig },
          remoteVersions: [],
          dumpStdout: "create table dumped ();\n",
          yes: true,
        });
        return Effect.gen(function* () {
          yield* seedLock(tmp.current, (services) => ({
            ...services,
            database: { ...services.database, resolved: unbundled(database15) },
          }));
          yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
          expect(s.dumpCalls[0]?.image).toBe(selection.database.image);
        }).pipe(Effect.provide(Layer.merge(s.layer, projectStateModeLayer("stack"))));
      },
    );

    it.effect("dumps with the locked image when no remote block applies", () => {
      const s = setup(tmp.current, {
        files: { "supabase/config.toml": "[db]\nmajor_version = 15\n" },
        remoteVersions: [],
        dumpStdout: "create table dumped ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* seedLock(tmp.current, (services) => ({
          ...services,
          database: { ...services.database, resolved: unbundled(database15) },
        }));
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
        expect(s.dumpCalls[0]?.image).toBe(unbundled(database15).image);
      }).pipe(Effect.provide(Layer.merge(s.layer, projectStateModeLayer("stack"))));
    });
  });

  it.effect(
    "resolves the pg_dump network via SUPABASE_NETWORK_ID from supabase/.env when neither the flag nor the ambient env is set",
    () => {
      // A `SUPABASE_NETWORK_ID` sourced only from `supabase/.env` still overrides host
      // networking.
      const s = setup(tmp.current, {
        files: {
          "supabase/.env": "SUPABASE_NETWORK_ID=dotenv-net\n",
        },
        remoteVersions: [], // no remote history → initial-migra pg_dump path
        dumpStdout: "create table dumped ();\n",
        edgeStdout: "",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
        expect(s.dumpCalls.length).toBeGreaterThanOrEqual(1);
        expect(s.dumpCalls[0]?.network).toEqual({ _tag: "named", name: "dotenv-net" });
      }).pipe(Effect.provide(s.layer), withEmptyConfigEnv);
    },
  );

  it.effect("points a named-network pg_dump container at the host for a loopback target", () => {
    const s = setup(tmp.current, {
      files: {
        "supabase/.env": "SUPABASE_NETWORK_ID=dotenv-net\n",
      },
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.dumpCalls[0]?.network).toEqual({ _tag: "named", name: "dotenv-net" });
      expect(s.dumpCalls[0]?.env["PGHOST"]).toBe("host.docker.internal");
    }).pipe(Effect.provide(s.layer), withEmptyConfigEnv);
  });

  it.effect("keeps a loopback target for a Linux pg_dump container on --network-id host", () => {
    const s = setup(tmp.current, {
      networkId: "host",
      platform: "linux",
      remoteVersions: [],
      dumpStdout: "create table dumped ();\n",
      edgeStdout: "",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ diffEngine: Option.some("migra") }));
      expect(s.dumpCalls[0]?.env["PGHOST"]).toBe("127.0.0.1");
    }).pipe(Effect.provide(s.layer), withEmptyConfigEnv);
  });

  it.effect("--experimental --declarative runs the declarative export without an error", () => {
    const s = setup(tmp.current, {
      experimental: true,
      edgeStdout: EXPORT_JSON,
      args: ["db", "pull", "--experimental", "--declarative"],
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      expect(s.engineCalls[0]?.operation).toBe("export");
      expect(streamText(s.out, "stderr")).toContain(
        "Preparing declarative schema export using pg-delta...",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an explicit --experimental=false wins over SUPABASE_EXPERIMENTAL=true and pulls normally",
    () => {
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
        args: ["db", "pull", "--experimental=false"],
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
        expect(s.historyUpserts.length).toBe(1);
      }).pipe(Effect.provide(s.layer), (body) =>
        withConfigEnv({ SUPABASE_EXPERIMENTAL: "true" }, body),
      );
    },
  );

  it.effect(
    "a stale SUPABASE_EXPERIMENTAL_PG_DELTA in supabase/.env does not defeat enabled = false",
    () => {
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        files: {
          "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n",
          "supabase/.env": "SUPABASE_EXPERIMENTAL_PG_DELTA=true\n",
        },
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED }));
        expect(s.engineCalls).toHaveLength(0);
        expect(s.edgeCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("with no pg-delta config and no --diff-engine, the pull uses pg-delta", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED }));
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(s.edgeCalls).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false in supabase/.env selects migra for a migration-style pull",
    () => {
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        files: { "supabase/.env": "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false\n" },
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED }));
        expect(s.engineCalls).toHaveLength(0);
        expect(s.edgeCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--diff-engine pg-delta overrides enabled = false", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      files: { "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n" },
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }));
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(s.edgeCalls).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("db pull with pg-delta-next diffs against the live local database by default", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      files: {
        "supabase/schemas/public.sql": "select 1;\n",
      },
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ diffEngine: Option.some("pg-delta") }));
      expect(s.connectedDatabases).not.toContain("contrib_regression");
      expect(s.engineCalls[0]?.targetRef).toContain("@127.0.0.1:5432/postgres");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "db pull with migra uses the declarative target override on the default local target",
    () => {
      // A real declarative schema file makes the native `loadDeclaredSchemas` branch
      // non-empty, so `prepareShadowSource` redirects the diff target to the shadow's
      // own `contrib_regression` override database.
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        files: {
          "supabase/schemas/public.sql": "select 1;\n",
        },
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ diffEngine: Option.some("migra") }));
        expect(s.connectedDatabases).toContain("contrib_regression");
        expect(s.resolveCalls[0]?.target).toEqual({ kind: "local" });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "db pull on the default local target suggests repair commands without a target flag",
    () => {
      const s = setup(tmp.current, {
        migrations: ["20240102000000"],
        remoteVersions: ["20240101000000"],
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(flags()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        expect(failure).toMatchObject({
          suggestion: expect.stringContaining(
            "migration repair --status reverted 20240101000000\n",
          ),
        });
        expect(failure).toMatchObject({
          suggestion: expect.stringContaining("migration repair --status applied 20240102000000\n"),
        });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a migration name with a path separator fails instead of an empty-version repair",
    () => {
      // The repair globs `<timestamp>_*.sql`, which fails when the name has a path
      // separator, so the native path must not silently upsert an empty-version row.
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(
          flags({
            remote: REMOTE_LINKED,
            name: Option.some("foo/bar"),
            diffEngine: Option.some("migra"),
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a migration name whose nested basename is itself a valid migration filename still fails",
    () => {
      // The basename (`20250101000000_backfill.sql`) matches the migration regex, but the
      // repair glob `<generated>_*.sql` never crosses the `/`, so it misses — anchoring
      // on the generated timestamp must reject this rather than upserting the nested one.
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
        remoteVersions: ["20240101000000"],
        edgeStdout: "create table remote ();\n",
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(
          flags({
            remote: REMOTE_LINKED,
            name: Option.some("dir/20250101000000_backfill"),
            diffEngine: Option.some("migra"),
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.historyUpserts.length).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a linked [remotes.<ref>] block enabling pg-delta selects the pg-delta engine", () => {
    // The linked path merges the matching [remotes.<ref>] block before
    // experimental.pgdelta.enabled is read. Base config disables pg-delta; the
    // remote override enables it, so the migration-style pull must pick the
    // pg-delta engine.
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
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
      remoteVersions: ["20240101000000"],
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      resolvedRef: "abcdefghijklmnopqrst",
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED }));
      expect(s.engineCalls[0]?.operation).toBe("diff");
      expect(streamText(s.out, "stderr")).toMatch(
        /Schema written to supabase[/\\]migrations[/\\]\d{14}_remote_schema\.sql\n/u,
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // `db.migrations.enabled = "notabool"` fails config-load after the ref is
      // already cached.
      const s = setup(tmp.current, {
        files: {
          "supabase/config.toml": ["[db.migrations]", 'enabled = "notabool"', ""].join("\n"),
        },
        remoteVersions: ["20240101000000"],
        yes: true,
        resolvedRef: "abcdefghijklmnopqrst",
      });
      return Effect.gen(function* () {
        const exit = yield* dbPull(flags({ remote: REMOTE_LINKED })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.cache.cached).toBe(true);
        expect(s.cache.cachedRef).toBe("abcdefghijklmnopqrst");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "a linked [remotes.<ref>] db.major_version override reaches the shadow's OWN container spec, not just toml",
    () => {
      // The remote's own container spec must reflect the `[remotes.<ref>]` override too,
      // not just the config read for pg-delta/schema_paths; `major_version` is used as a
      // probe since PG <= 14 is the only branch that emits `--tmpfs` on `docker create`.
      const s = setup(tmp.current, {
        migrations: ["20240101000000"],
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
        remoteVersions: ["20240101000000"],
        edgeStdout: "alter table x;\n",
        yes: true,
        resolvedRef: "abcdefghijklmnopqrst",
      });
      return Effect.gen(function* () {
        yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }));
        const createArgs = s.shadowSpawned.find((c) => c.args[0] === "create")?.args ?? [];
        expect(createArgs).toContain("--tmpfs");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("retries the migration-style diff through the IPv4 pooler on an IPv6 error", () => {
    // Retries the whole shadow-provisioning + diff operation, not just the diff engine —
    // the pooler retry re-provisions and tears down a fresh shadow and re-prints both
    // banners, rather than reusing the first attempt's shadow.
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: "error diffing schema:\nfailed to connect: network is unreachable",
      edgeStdout: pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table remote ();" }]),
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }));
      const err = streamText(s.out, "stderr");
      expect(err).toContain("does not support IPv6");
      expect(err).toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(2);
      expect(err).toMatch(
        /Schema written to supabase[/\\]migrations[/\\]\d{14}_remote_schema\.sql\n/u,
      );
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(2);
      expect(
        s.shadowSpawned.filter((c) => c.args[0] === "rm" && c.args.includes("-f")),
      ).toHaveLength(2);
      expect(err.split("Creating shadow database...")).toHaveLength(3);
      expect(err.split("Diffing schemas...")).toHaveLength(3);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("retries the declarative export through the IPv4 pooler on an IPv6 error", () => {
    // The export reads only the live target, so no shadow is ever provisioned on this path.
    const s = setup(tmp.current, {
      edgeFailFirstWith: "error exporting declarative schema:\nnetwork is unreachable",
      edgeStdout: EXPORT_JSON,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      yield* dbPull(flags({ remote: REMOTE_LINKED, declarative: Option.some(true) }));
      expect(streamText(s.out, "stderr")).toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "export")).toHaveLength(2);
      const path = yield* Path.Path;
      expect(streamText(s.out, "stderr")).toContain(
        `Declarative schema written to ${path.join("supabase", "schemas")}\n`,
      );
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an IPv6 diff error with no pooler available surfaces the original error", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: "error diffing schema:\nnetwork is unreachable",
      yes: true,
      poolerAvailable: false,
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(streamText(s.out, "stderr")).not.toContain("Retrying via the IPv4 connection pooler");
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a non-IPv6 diff error is not retried through the pooler", () => {
    const s = setup(tmp.current, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeFailFirstWith: 'error diffing schema:\nsyntax error at or near "foo"',
      yes: true,
      poolerAvailable: true,
    });
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("pg-delta") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(s.poolerFallbackCalls).toHaveLength(0);
      expect(s.engineCalls.filter((call) => call.operation === "diff")).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on --declarative with --diff-engine (mutual exclusion)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbPull(
        flags({
          remote: REMOTE_LINKED,
          declarative: Option.some(true),
          diffEngine: Option.some("migra"),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
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
     * Runs `db pull` with the shadow baseline cache on and artifacts under the temp root,
     * against the stateful Docker model the export/restore round trip needs.
     *
     * Each run gets its own workdir so the migration file the previous pull wrote cannot
     * shift the second run's behavior — the cache key is global and workdir-independent,
     * so two worktrees with identical settings still collide on the same tar.
     */
    const runCached = (engine: "migra" | "pg-delta") =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workdir = path.join(tmp.current, `${engine}-worktree`);
        const s = setup(workdir, {
          migrations: ["20240101000000"],
          files: { "supabase/config.toml": "[experimental.pgdelta]\nenabled = true\n" },
          statefulDocker: true,
          remoteVersions: ["20240101000000"],
          edgeStdout:
            engine === "pg-delta"
              ? pgDeltaDiffEnvelope([{ name: "schema_changes", sql: "create table t ();" }])
              : "create table t ();\n",
          yes: true,
        });
        return yield* withEnvVar(
          "SUPABASE_HOME",
          path.join(tmp.current, "_supabase_home"),
          withConfigEnv(
            { SUPABASE_SHADOW_CACHE: "1" },
            dbPull(
              flags(
                engine === "migra"
                  ? { remote: REMOTE_LINKED, diffEngine: Option.some("migra") }
                  : { remote: REMOTE_LINKED },
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

describe("db pull permissions through the real resolver and cache", () => {
  const asLines = (requests: ReadonlyArray<StubbedRequest>) =>
    requests.map(({ method, path }) => `${method} ${path}`);
  const poolerRequest = `GET /v1/projects/${VALID_REF}/config/database/pooler`;
  const loginRoleRequest = `POST /v1/projects/${VALID_REF}/cli/login-role`;
  const cacheRequest = `GET https://api.supabase.com/v1/projects/${VALID_REF}`;
  const savedRef = { "supabase/.temp/project-ref": VALID_REF };

  it.effect("mints a login role and fills the cache for --remote=<ref>", () => {
    const s = setup(tmp.current, { realLayers: true });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbPull(
        flags({
          declarative: Option.some(true),
          remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const),
        }),
      ).pipe(Effect.provide(s.layer));
      expect(s.engineCalls.map((call) => call.operation)).toEqual(["export"]);
      expect(asLines(requests)).toEqual([poolerRequest, loginRoleRequest]);
      expect(s.projectHttp.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        cacheRequest,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "db pull",
        activeFlags: { declarative: true, remote: VALID_REF },
        requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
        exact: true,
      });
      // The resolve-phase calls belong to the database config block itself, not to the
      // fallback block, which declares the same operations.
      assertBlockDrift(dbConfig, {
        activeFlags: { remote: VALID_REF },
        requests: asRecordedRequests(requests),
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("does not mint a login role when --password is given", () => {
    const s = setup(tmp.current, { realLayers: true });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbPull(
        flags({
          declarative: Option.some(true),
          remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const),
          password: Option.some("secret"),
        }),
      ).pipe(Effect.provide(s.layer));
      expect(asLines(requests)).toEqual([poolerRequest]);
      assertPermissionDrift({
        command: "db pull",
        activeFlags: { declarative: true, remote: VALID_REF, password: true },
        requests: [...asRecordedRequests(requests), ...s.projectHttp.calls],
        exact: true,
      });
      // The resolve-phase calls belong to the database config block itself, not to the
      // fallback block, which declares the same operations.
      assertBlockDrift(dbConfig, {
        activeFlags: { remote: VALID_REF, password: true },
        requests: asRecordedRequests(requests),
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "makes no Management API request for the default local target and caches nothing",
    () => {
      const s = setup(tmp.current, { realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(requests, () => undefined);
        yield* dbPull(flags({ declarative: Option.some(true) })).pipe(Effect.provide(s.layer));
        expect(s.engineCalls.map((call) => call.operation)).toEqual(["export"]);
        expect(requests).toEqual([]);
        expect(s.projectHttp.calls).toEqual([]);
        expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(false);
        assertPermissionDrift({
          command: "db pull",
          activeFlags: { declarative: true },
          requests: [],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(BunServices.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect("retries the initial dump through the pooler after a container IPv6 failure", () => {
    // No --remote=<ref>: the ref comes from the saved file, so only the fallback block accounts
    // for the pooler config request.
    const s = setup(tmp.current, {
      realLayers: true,
      files: savedRef,
      remoteVersions: [],
      dumpFailFirstWith: "could not translate host name: network is unreachable",
      dumpStdout: "",
      edgeStdout: "",
      yes: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* reachableDirectHost;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      // The initial pg_dump seed only runs on the migra engine; pg-delta is the default.
      const error = yield* dbPull(
        flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") }),
      ).pipe(Effect.provide(s.layer), Effect.flip);
      expect(error.message).toBe("No schema changes found");
      expect(s.dumpCalls).toHaveLength(2);
      expect(s.dumpCalls[1]?.env["PGHOST"]).toBe("aws-0-us-east-1.pooler.supabase.com");
      expect(asLines(requests)).toEqual([loginRoleRequest, poolerRequest, loginRoleRequest]);
      assertPermissionDrift({
        command: "db pull",
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
});

describeHostedConsent("db pull", {
  setup: (workdir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${workdir}/supabase/.temp`, { recursive: true });
      yield* fs.writeFileString(`${workdir}/supabase/.temp/project-ref`, VALID_REF);
    }),
  invoke: ({ workdir, out }) => {
    const s = setup(workdir, {
      migrations: ["20240101000000"],
      remoteVersions: ["20240101000000"],
      edgeStdout: "create table remote ();\n",
    });
    let migrationsAfterRun: ReadonlyArray<string> = [];
    return {
      run: dbPull(flags({ remote: REMOTE_LINKED, diffEngine: Option.some("migra") })).pipe(
        Effect.ensuring(
          migrationFiles(workdir).pipe(
            Effect.tap((files) => Effect.sync(() => void (migrationsAfterRun = files))),
            Effect.orDie,
          ),
        ),
        Effect.provide(Layer.mergeAll(s.engineLayer, configValuesLayer({ output: out.layer }))),
      ),
      mutations: () =>
        s.historyUpserts.length +
        migrationsAfterRun.filter((file) => file !== "20240101000000_local.sql").length,
    };
  },
});
