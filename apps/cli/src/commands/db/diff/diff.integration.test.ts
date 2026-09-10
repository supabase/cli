import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  FAKE_SHADOW_CONTAINER_ID,
  VALID_REF,
  failWriteStringMatchingFsLayer,
  failWriteStringOnNthCallFsLayer,
  withEnvVar,
  mockCommandSettings,
  mockDockerDaemonCliSpawner,
  mockLinkedProjectCacheTracked,
  mockLocalDockerEngineUnavailableLayer,
  mockShadowContainerCliSpawner,
  mockTelemetryStateTracked,
  useShadowCacheDisabled,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
} from "../../../command-internal/global-flags.ts";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
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
import type { DbDiffFlags } from "./diff.command.ts";
import { dbDiff } from "./diff.handler.ts";
import { stackBackendLayer } from "../../experimental/stack/stack-backend.ts";
import { StackNativeEngineError } from "../../../command-internal/stack-local-database.ts";
import { PGADMIN_DESKTOP_NOTE_PREFIX, PGADMIN_DIFF_HEADER } from "./pgadmin-diff.ts";

interface SetupOpts {
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
  readonly delegateStdout?: string; // stdout returned by a captured Go-delegate run
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
  // `Option.none()` to exercise the config.toml/workdir-basename fallback
  // (`resolveLocalProjectId`).
  readonly projectId?: Option.Option<string>;
  // Simulates an unlinked workdir: `loadProjectRef` fails with
  // `ProjectRefNotLinkedError` absent an explicit `--project-ref` flag.
  readonly linkedFails?: boolean;
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
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

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
  const layer = Layer.succeed(DbConnection, {
    connect: (cfg: PgConnInput) =>
      Effect.gen(function* () {
        connectedDatabases.push(cfg.database);
        if (opts.neverConnectableShadow === true && cfg.port === SHADOW_PORT) {
          return yield* Effect.fail(new DbConnectError({ message: "connection refused" }));
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
  return { layer, connectedDatabases, execCalls };
}

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
  const edge = Layer.succeed(EdgeRuntimeScript, {
    run: (runOpts: EdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
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
  const dockerCalls: unknown[] = [];
  // The pgAdmin differ's own `runCapture` calls, distinguished from `dockerCalls`
  // by `image` (both share the same `DockerRun.runCapture` seam).
  const differCalls: Array<DockerRunOpts> = [];
  // The `runCapture` options argument for every differ call, parallel to
  // `differCalls`; stays `undefined` since the differ's stderr is never teed to
  // the parent terminal.
  const differCaptureOpts: Array<{ readonly teeStderr?: boolean } | undefined> = [];
  // Snapshots `process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]` at each differ
  // `runCapture` call, standing in for the real image resolver's own read of it.
  const differRegistryEnvAtCall: Array<string | undefined> = [];
  const shadowSetupJobCalls: Array<{ readonly env: Readonly<Record<string, string>> }> = [];
  const docker = Layer.succeed(DockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: (dockerOpts, captureOpts) => {
      if (dockerOpts.image.includes("pgadmin-schema-diff")) {
        differCalls.push(dockerOpts);
        differCaptureOpts.push(captureOpts);
        differRegistryEnvAtCall.push(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]);
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

  const resolverCalls: unknown[] = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (resolveFlags) => {
      resolverCalls.push(resolveFlags);
      // A threaded `--project-ref` flag wins over the fixed `opts.linkedRef` fixture,
      // matching real resolver precedence.
      const flagRef = resolveFlags.linkedProjectRef ?? Option.none();
      const ref =
        Option.isSome(flagRef) && flagRef.value.length > 0 ? flagRef.value : opts.linkedRef;
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? true,
        ref: ref !== undefined ? Option.some(ref) : Option.none(),
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  // Mirrors the same ref `resolver`'s own mock embeds above, and gives an explicit
  // `--project-ref` flag top precedence over `opts.linkedRef` (mirrors
  // `reset.integration.test.ts`'s identical mock).
  const projectRefResolver = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
    resolveForLink: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(opts.linkedRef ?? VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
          : Effect.succeed(opts.linkedRef ?? VALID_REF),
    promptProjectRef: () => Effect.succeed(opts.linkedRef ?? VALID_REF),
  });

  const proxyCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const proxyCaptureCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> =
    [];
  const proxy = Layer.succeed(GoProxy, {
    exec: (args, execOpts) => Effect.sync(() => void proxyCalls.push({ args, env: execOpts?.env })),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        proxyCaptureCalls.push({ args, env: execOpts?.env });
        return opts.delegateStdout ?? "";
      }),
  });

  const baseLayer = Layer.mergeAll(
    // Listed first so the fake service layers below (`Layer.mergeAll` is last-wins)
    // override its real implementations, matching `start.integration.test.ts`.
    BunServices.layer,
    out.layer,
    telemetry.layer,
    cache.layer,
    pgDeltaEngine,
    edge,
    docker,
    shadowDbConnection.layer,
    dockerDaemon?.layer ?? shadowSpawner.layer,
    mockLocalDockerEngineUnavailableLayer,
    alwaysReadyHttpClientLayer,
    resolver,
    projectRefResolver,
    proxy,
    mockCommandSettings({ workdir, projectId: opts.projectId ?? Option.some("test") }),
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
    mockRuntimeInfo({ platform: opts.platform ?? "linux" }),
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
    resolverCalls,
    proxyCalls,
    proxyCaptureCalls,
    dockerCalls,
    differCalls,
    differCaptureOpts,
    differRegistryEnvAtCall,
    shadowSetupJobCalls,
    shadowSpawned: shadowSpawner.spawned,
    dockerDaemon,
    shadowConnectedDatabases: shadowDbConnection.connectedDatabases,
    shadowExecCalls: shadowDbConnection.execCalls,
  };
}

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
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
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

const tmp = useTempWorkdir();
useShadowCacheDisabled();

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
// shadow port 54320).
const PGADMIN_SOURCE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10";
const PGADMIN_TARGET_URL = "postgresql://postgres:postgres@127.0.0.1:54320/postgres";

describe("db diff", () => {
  it.effect("diffs local with the default migra engine and prints SQL to stdout", () => {
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(s.shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
      expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table players ();\n\n");
      expect(stderr(s.out)).toContain("Creating shadow database...");
      expect(stderr(s.out)).toContain("Diffing schemas...");
      expect(stderr(s.out)).toContain("Finished supabase db diff on branch");
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
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs local with pgdelta when --use-pg-delta is set", () => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
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

  it.effect("pg-delta local diff ignores schema_paths and declarative files", () => {
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["configured.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "configured.sql"), "create table configured ();\n");
    writeFileSync(
      join(tmp.current, "supabase", "schemas", "ignored.sql"),
      "create table ignored ();\n",
    );
    const s = setup(tmp.current, {
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
      expect(stdout(s.out)).toBe("create table result ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  // Migra still routes declarative files through the `contrib_regression` override,
  // so schema_paths still shapes its output — only pg-delta prints this warning.
  const writeSchemaPathsConfig = (pgDeltaEnabled: boolean) => {
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["configured.sql"]',
        "",
        "[experimental.pgdelta]",
        `enabled = ${pgDeltaEnabled}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "configured.sql"), "create table configured ();\n");
  };

  it.effect("migra local diff does not print the schema_paths transition warning", () => {
    writeSchemaPathsConfig(false);
    const s = setup(tmp.current, {
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stderr(s.out)).not.toContain("schema_paths no longer changes the migrations baseline");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("PG14: provisions a shadow via the SQL-exec init path (no PG15+ one-shot jobs)", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 14\n");
    const s = setup(tmp.current, { diffSql: "create table pg14 ();\n" });
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
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
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
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ linked: Option.some(true) }));
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
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
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
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "alter table x;\n",
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ linked: Option.some(true) }));
        const createArgs = s.shadowSpawned.find((c) => c.args[0] === "create")?.args ?? [];
        expect(createArgs).toContain("--tmpfs");
        expect(s.dockerCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("the base config (default local target) does not merge a remote block", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
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
    );
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(s.edgeCalls[0]?.script).not.toContain("renderPlanFiles");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs the linked project and writes the linked-project cache", () => {
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ linked: Option.some(true) }));
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs the project given via --project-ref without a linked workdir", () => {
    // `linkedFails: true` simulates an unlinked workdir; only the flag can resolve a ref.
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current, {
      isLocal: false,
      diffSql: "alter table x;\n",
      linkedFails: true,
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--project-ref overrides an already-linked workdir's project ref", () => {
    const FLAG_REF = "flagflagflagflagflag";
    // A distinct `linkedRef` proves the flag, not the workdir's own linked ref, wins.
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ linked: Option.some(true), projectRef: Option.some(FLAG_REF) }));
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
      expect(s.cache.cachedRef).not.toBe("abcdefghijklmnopqrst");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbDiff(flags({ local: Option.some(true), projectRef: Option.some(FLAG_REF) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      expect(s.resolverCalls).toEqual([]);
      expect(s.cache.cached).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "explicit --from linked --to migrations --project-ref proceeds and uses the flag ref",
    () => {
      // `[remotes.staging]`'s `project_id` matches the flag ref, not `opts.linkedRef`
      // (left unset), so the override only applies if the flag resolved it.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
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
      );
      const s = setup(tmp.current, { isLocal: false, diffSql: "create table m ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({
            from: Option.some("linked"),
            to: Option.some("migrations"),
            projectRef: Option.some("flagflagflagflagflag"),
          }),
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
    "explicit --from local --to migrations --linked --project-ref proceeds and applies the flag ref's remote override",
    () => {
      // Same `[remotes.staging]` fixture as the `--from linked` case above, but here a
      // changed `--linked` (not a literal "linked" ref) resolves the flag ref instead.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
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
      );
      const s = setup(tmp.current, { isLocal: false, diffSql: "create table m ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({
            from: Option.some("local"),
            to: Option.some("migrations"),
            linked: Option.some(true),
            projectRef: Option.some("flagflagflagflagflag"),
          }),
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
    "explicit --from local --to migrations --project-ref errors (neither side is linked)",
    () => {
      const FLAG_REF = "flagflagflagflagflag";
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          dbDiff(
            flags({
              from: Option.some("local"),
              to: Option.some("migrations"),
              projectRef: Option.some(FLAG_REF),
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked, or --from/--to linked, in explicit mode",
        );
        expect(s.resolverCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "caches the linked ref even when the merged config fails to load afterward (review: PRRT_kwDOErm0O86XLe6s)",
    () => {
      // `db.migrations.enabled = "notabool"` fails config-load after the ref is
      // already cached.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        ["[db.migrations]", 'enabled = "notabool"', ""].join("\n"),
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        diffSql: "alter table x;\n",
      });
      return Effect.gen(function* () {
        const exit = yield* dbDiff(flags({ linked: Option.some(true) })).pipe(Effect.exit);
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
      mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "schemas", "public.sql"), "select 1;\n");
      const s = setup(tmp.current, { diffSql: "create table o ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags());
        expect(stdout(s.out)).toBe("create table o ();\n\n");
        expect(s.shadowConnectedDatabases).toContain("contrib_regression");
        expect(s.shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "diffs with the native pgAdmin engine: shadow create/rm, one differ run, no Go proxy call",
    () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(s.proxyCalls).toEqual([]);
        expect(s.proxyCaptureCalls).toEqual([]);
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
    },
  );

  it.effect("rejects --project-ref combined with --use-pg-schema before delegating", () => {
    // The delegated Go binary doesn't support --project-ref, so this must fail before
    // forwarding rather than silently dropping the flag.
    const FLAG_REF = "flagflagflagflagflag";
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbDiff(flags({ usePgSchema: Option.some(true), projectRef: Option.some(FLAG_REF) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("--project-ref is not supported with --use-pg-schema");
      expect(s.proxyCalls).toEqual([]);
      expect(s.proxyCaptureCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pgadmin --linked honors --project-ref like the other native engines", () => {
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
          linked: Option.some(true),
          projectRef: Option.some(FLAG_REF),
        }),
      );
      expect(s.proxyCalls).toEqual([]);
      expect(s.differCalls).toHaveLength(1);
      expect(s.cache.cached).toBe(true);
      expect(s.cache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "--use-pgadmin --linked succeeds when only the [remotes.<ref>] override fixes an invalid base config",
    () => {
      // pgadmin shares the same target resolve as migra/pg-delta, so it validates the
      // remote-merged config and succeeds.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
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
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(true) }));
        expect(stderr(s.out)).toContain("Loading config override: [remotes.staging]");
        expect(s.proxyCalls).toEqual([]);
        expect(s.differCalls).toHaveLength(1);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "--use-pgadmin --linked's preflight probe targets the resolved LINKED project id, not the base config's",
    () => {
      // The preflight probe's project id comes from the config after the linked
      // remote merge, not the base config's own `project_id`.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        [
          'project_id = "test"',
          "",
          "[remotes.staging]",
          'project_id = "abcdefghijklmnopqrst"',
          "",
        ].join("\n"),
      );
      const s = setup(tmp.current, {
        isLocal: false,
        linkedRef: "abcdefghijklmnopqrst",
        pgadminStdout: [JSON.stringify([pgadminEntry()])],
      });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(true) }));
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
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        const exit = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.resolverCalls).toHaveLength(0);
        expect(s.differCalls).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("a native local diff still validates the base config", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
    const s = setup(tmp.current, { diffSql: "create table x ();\n" });
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
      const s = setup(tmp.current, { diffSql: "create table x ();\n" });
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

  it.effect("re-quotes a comma-containing schema when delegating --use-pg-schema", () => {
    // The parsed schema value `tenant,one` must be re-encoded as a quoted CSV field
    // so the delegated Go child's pflag StringSlice doesn't split it into two schemas.
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgSchema: Option.some(true), schema: ["tenant,one"] }));
      const args = s.proxyCalls[0]?.args ?? [];
      const idx = args.indexOf("--schema");
      expect(args[idx + 1]).toBe('"tenant,one"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "forwards a comma-containing --schema value to the differ raw, with no CSV re-quoting (native path)",
    () => {
      // Unlike the delegate above, the native differ argv isn't re-parsed by a pflag
      // StringSlice, so the value reaches the container unchanged.
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
    "delegates --use-pg-schema to the Go binary, printing a deprecation warning without duplicating Go's own warning",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgSchema: Option.some(true) }));
        // Asserts on a stable substring so wording tweaks don't require touching every test site.
        expect(stderr(s.out)).toContain('"--use-pg-schema" is deprecated');
        expect(stderr(s.out)).not.toContain("--use-pg-schema flag is experimental");
        expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pg-schema"]);
        // The child's own telemetry is disabled so the single `cli_command_executed`
        // event comes from this TS command's instrumentation, not the delegated child.
        expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("does not print the --use-pg-schema deprecation warning on other diff paths", () => {
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags());
      expect(stderr(s.out)).not.toContain('"--use-pg-schema" is deprecated');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "does not print the --use-pg-schema deprecation warning on the native --use-pgadmin path",
    () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(stderr(s.out)).not.toContain('"--use-pg-schema" is deprecated');
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
        expect(s.proxyCalls).toEqual([]);
        expect(s.proxyCaptureCalls).toEqual([]);
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
        const data = success?.data as { file: string; files: ReadonlyArray<string> };
        expect(data.file).toMatch(/\d{14}_pgadmin_diff\.sql$/);
        expect(data.files).toEqual([data.file]);
        expect(existsSync(data.file)).toBe(true);
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

  it.effect("--use-pg-schema in json mode wraps the captured SQL in a structured envelope", () => {
    const s = setup(tmp.current, { format: "json", delegateStdout: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgSchema: Option.some(true) }));
      expect(stdout(s.out)).toBe("");
      expect(s.proxyCaptureCalls).toHaveLength(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ diff: "create table e ();\n", engine: "pg-schema" });
      // Diagnostics like the deprecation notice still reach stderr in machine mode.
      expect(stderr(s.out)).toContain('"--use-pg-schema" is deprecated');
      // The child's own telemetry is disabled here too, same as the text-mode delegate.
      expect(s.proxyCaptureCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes live-only SQL with --file even when declarative targets are configured", () => {
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["schemas/*.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmp.current, "supabase", "schemas", "declarative.sql"),
      "create table declarative_only ();\n",
    );
    const s = setup(tmp.current, {
      diffSql: "create table live_only ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      expect(stdout(s.out)).toBe("");
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
      expect(stderr(s.out)).toContain("-f names the migration; it does not filter objects");
      expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_my_diff\.sql$/);
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("create table live_only ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("includes the ignored declarative baseline advisory in JSON output", () => {
    mkdirSync(join(tmp.current, "supabase", "schemas"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "schemas", "items.sql"),
      "create table items ();\n",
    );
    const s = setup(tmp.current, {
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
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "not-a-directory.sql"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "not-a-directory.sql"), "select 1;\n");
    const s = setup(tmp.current, {
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
      format: "json",
      diffFiles: [
        { name: "ignored", sql: "alter type mood add value 'ok';" },
        { name: "ignored", sql: "insert into t values ('ok');" },
      ],
      diffSuffixes: ["_1", "_2"],
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toBe("19700101000000_my_diff_1.sql");
      expect(files[1]).toBe("19700101000001_my_diff_2.sql");
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("alter type mood add value 'ok';\n");
      const success = s.out.messages.find((m) => m.type === "success");
      const data = success?.data as { file: string; files: ReadonlyArray<string> };
      expect(data.files).toHaveLength(2);
      expect(data.file).toBe(data.files[0]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested single-unit --file name", () => {
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ file: Option.some("snapshots/remote") }));
      const migrationsRoot = join(tmp.current, "supabase", "migrations");
      const dirs = readdirSync(migrationsRoot);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
      expect(readdirSync(join(migrationsRoot, dirs[0]!))).toEqual(["remote.sql"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to linked prints the diff to stdout", () => {
    const s = setup(tmp.current, { isLocal: false, diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("local"), to: Option.some("linked") }));
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
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "database",
        ref: "postgresql://desired.example/postgres",
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
      expect(existsSync(join(tmp.current, "out.sql"))).toBe(true);
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "forwards an explicit --linked=false target flag to the delegated pg-schema child",
    () => {
      // Target flags are selectors keyed on the delegated child's flag.Changed; dropping
      // `Some(false)` would default it to local instead of the linked target selected.
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* dbDiff(flags({ usePgSchema: Option.some(true), linked: Option.some(false) }));
        expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pg-schema", "--linked=false"]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "an empty --file value prints to stdout instead of writing a nameless migration",
    () => {
      // The file write is gated on non-empty; an empty --file falls through to stdout
      // instead of writing `<timestamp>_.sql`.
      const s = setup(tmp.current, { diffSql: "create table y ();\n" });
      return Effect.gen(function* () {
        yield* dbDiff(flags({ file: Option.some("") }));
        expect(stdout(s.out)).toContain("create table y ();");
        const migrationsDir = join(tmp.current, "supabase", "migrations");
        expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
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

  it.effect("explicit --from linked --to migrations passes the linked ref to the strategy", () => {
    // Linked resolves first, so the later migrations catalog uses the remote-merged config.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
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
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("linked"), to: Option.some("migrations") }));
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
      // Linked resolves first here (opposite of the sibling test below), so the
      // remote-merged config reaches the catalog.
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(14);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from migrations --to linked passes base config to the strategy", () => {
    // Migrations resolves before linked here, so the catalog must use base config
    // (no ref forwarded yet).
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
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
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(flags({ from: Option.some("migrations"), to: Option.some("linked") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
      expect(s.explicitDiffCalls[0]?.toml?.majorVersion).toBe(17);
      expect(s.explicitDiffCalls[0]?.toml?.webhooksEnabled).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked seeds the merged config", () => {
    // A changed --linked remote-merges the config before the explicit refs resolve,
    // even though neither explicit ref is itself `linked`.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
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
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* dbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("migrations"),
          linked: Option.some(true),
        }),
      );
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked validates the merged config", () => {
    // The base config read is deferred until after the linked preflight, so a base
    // config only valid after the remote merge doesn't fail early.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
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
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      const exit = yield* dbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("migrations"),
          linked: Option.some(true),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
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

  it.effect("explicit mode still runs the target-flag preflight on a changed --db-url", () => {
    // A changed target flag is still validated even when the explicit refs drive the
    // diff; the preflight resolves --db-url (connType db-url).
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* dbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("local"),
          dbUrl: Option.some("postgresql://x"),
        }),
      );
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ connType: "db-url" }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails when --from is set without --to", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ from: Option.some("local") })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on engine-flag conflict (--use-migra with --use-pg-delta)", () => {
    const s = setup(tmp.current);
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
    }).pipe(Effect.provide(Layer.mergeAll(s.layer, stackBackendLayer("stack"))));
  });

  it.effect("rejects --use-migra=false on the stack backend", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(flags({ useMigra: Option.some(false) })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(StackNativeEngineError);
    }).pipe(Effect.provide(Layer.mergeAll(s.layer, stackBackendLayer("stack"))));
  });

  it.effect("fails on target mutex (--linked with --local)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* dbDiff(
        flags({ linked: Option.some(true), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
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
        engine: "migra",
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
      const exit = yield* dbDiff(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stderr(s.out)).not.toContain("No schema changes found");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("falls back to the migra Docker image when edge-runtime OOMs", () => {
    const s = setup(tmp.current, { oom: true, diffSql: "create table fb ();\n", isLocal: true });
    return Effect.gen(function* () {
      // Pass --schema so the fallback does not need a live DB to list schemas.
      yield* dbDiff(flags({ schema: ["public"] }));
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
      yield* dbDiff(flags({ schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect((s.dockerCalls[0] as { network: unknown }).network).toEqual({
        _tag: "named",
        name: "my-net",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.live(
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
        while (s.shadowConnectedDatabases.length === 0) {
          yield* Effect.sleep("5 millis");
        }
        // `Fiber.interrupt` only resolves once finalizers complete; this would hang for
        // up to 30s if `acquire` still covered the readiness wait.
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
          const migrationsDir = join(tmp.current, "supabase", "migrations");
          expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
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
        const dir = join(tmp.current, "supabase", "migrations");
        const files = readdirSync(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{14}_pgadmin_diff\.sql$/);
        expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(PGADMIN_DIFF_SQL);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect("creates nested parent directories for a nested --use-pgadmin --file name", () => {
      const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
      return Effect.gen(function* () {
        yield* dbDiff(
          flags({ usePgAdmin: Option.some(true), file: Option.some("snapshots/remote") }),
        );
        const migrationsRoot = join(tmp.current, "supabase", "migrations");
        const dirs = readdirSync(migrationsRoot);
        expect(dirs).toHaveLength(1);
        expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
        expect(readdirSync(join(migrationsRoot, dirs[0]!))).toEqual(["remote.sql"]);
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "an empty --use-pgadmin --file value falls through to stdout instead of writing",
      () => {
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true), file: Option.some("") }));
          expect(stdout(s.out)).toContain("ALTER TABLE test;");
          const migrationsDir = join(tmp.current, "supabase", "migrations");
          expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
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
        // `CommandSettings.projectId` only feeds pg-delta's project id; the differ's
        // network/labels come from `loadLocalProjectContext`'s own resolution, falling
        // back to the workdir basename.
        const projectId = basename(tmp.current);
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(s.differCalls).toHaveLength(1);
          const call = s.differCalls[0] as DockerRunOpts;
          expect(call.image).toBe(dockerfileServiceImage("differ"));
          expect(call.image).toBe("supabase/pgadmin-schema-diff:cli-0.0.5");
          expect(call.cmd).toEqual(["--json-diff", PGADMIN_SOURCE_URL, PGADMIN_TARGET_URL]);
          expect(call.env).toEqual({});
          expect(call.binds).toEqual([]);
          expect(call.securityOpt).toEqual([]);
          expect(call.workingDir).toEqual(Option.none());
          expect(call.entrypoint).toBeUndefined();
          expect(call.network).toEqual({ _tag: "named", name: `supabase_network_${projectId}` });
          expect(call.labels).toEqual({
            "com.supabase.cli.project": projectId,
            "com.docker.compose.project": projectId,
          });
          expect(call.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
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
        const call = s.differCalls[0] as DockerRunOpts;
        expect(call.network).toEqual({ _tag: "named", name: "custom-net" });
      }).pipe(Effect.provide(s.layer));
    });

    it.effect(
      "omits --add-host on a non-Linux host (Go's docker_darwin.go/docker_windows.go)",
      () => {
        const s = setup(tmp.current, {
          pgadminStdout: [JSON.stringify([pgadminEntry()])],
          platform: "darwin",
        });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          const call = s.differCalls[0] as DockerRunOpts;
          expect(call.extraHosts).toEqual([]);
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "hardcodes the shadow target's postgres:postgres credentials, ignoring a configured [db] password (Go pgadmin.go quirk)",
      () => {
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(
          join(tmp.current, "supabase", "config.toml"),
          '[db]\npassword = "distinctive-pw"\n',
        );
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          const call = s.differCalls[0] as DockerRunOpts;
          expect(call.cmd.at(-1)).toBe(PGADMIN_TARGET_URL);
          expect(call.cmd.join(" ")).not.toContain("distinctive-pw");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "a supabase/.env-only SUPABASE_INTERNAL_IMAGE_REGISTRY reaches the differ's image resolver during the run, and reverts after",
      () => {
        // The image resolver reads `process.env` directly at call time (no
        // `projectEnvValues` in scope); this mock records that same read since it
        // replaces the resolver wholesale.
        const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        mkdirSync(join(tmp.current, "supabase"), { recursive: true });
        writeFileSync(
          join(tmp.current, "supabase", ".env"),
          "SUPABASE_INTERNAL_IMAGE_REGISTRY=registry.example.com\n",
        );
        const s = setup(tmp.current, { pgadminStdout: [JSON.stringify([pgadminEntry()])] });
        return Effect.gen(function* () {
          yield* dbDiff(flags({ usePgAdmin: Option.some(true) }));
          expect(s.differRegistryEnvAtCall).toEqual(["registry.example.com"]);
          expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (prev === undefined) delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
              else process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = prev;
            }),
          ),
          Effect.provide(s.layer),
        );
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
          expect((s.differCalls[0] as DockerRunOpts).cmd).toEqual([
            "--schema",
            "public",
            "--json-diff",
            PGADMIN_SOURCE_URL,
            PGADMIN_TARGET_URL,
          ]);
          expect((s.differCalls[1] as DockerRunOpts).cmd).toEqual([
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
        expect((error as { message: string }).message).toContain(
          "failed to parse schema diff output:",
        );
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
          expect((error as { message: string }).message).not.toContain("some differ crash text");
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
          expect(stripAnsi((error as { message: string }).message)).toBe(
            "supabase start is not running.",
          );
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
          expect(error).toMatchObject({ _tag: "DbDiffDbNotRunningError", daemonDown: true });
          expect((error as { suggestion?: string }).suggestion).toContain("Docker Desktop");
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
      "fails on engine-flag conflict (--use-pgadmin with --use-pg-delta), byte-exact cobra message",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const error = yield* dbDiff(
            flags({ usePgAdmin: Option.some(true), usePgDelta: Option.some(true) }),
          ).pipe(Effect.flip);
          expect((error as { message: string }).message).toBe(
            "if any flags in the group [use-migra use-pgadmin use-pg-schema use-pg-delta] are set none of the others can be; [use-pg-delta use-pgadmin] were all set",
          );
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.effect(
      "fails on target mutex when --use-pgadmin is combined with --linked and --local",
      () => {
        const s = setup(tmp.current);
        return Effect.gen(function* () {
          const exit = yield* dbDiff(
            flags({
              usePgAdmin: Option.some(true),
              linked: Option.some(true),
              local: Option.some(true),
            }),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
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
              to: Option.some("linked"),
            }),
          );
          expect(s.differCalls).toEqual([]);
          expect(s.explicitDiffCalls).toHaveLength(1);
          expect(stdout(s.out)).toBe("create table explicit ();\n");
        }).pipe(Effect.provide(s.layer));
      },
    );

    it.live(
      "removes the shadow container on interruption during the health wait for --use-pgadmin too",
      () => {
        const s = setup(tmp.current, { neverHealthyShadow: true });
        return Effect.gen(function* () {
          const fiber = yield* dbDiff(flags({ usePgAdmin: Option.some(true) })).pipe(
            Effect.provide(s.layer),
            Effect.forkChild({ startImmediately: true }),
          );
          // Waits for the shadow's own health probe (its 64-hex id); the pgadmin path's
          // separate `supabase_db_test` probe fires first and would satisfy a looser
          // check immediately.
          while (
            !s.shadowSpawned.some(
              (c) =>
                c.args[0] === "container" &&
                c.args[1] === "inspect" &&
                c.args[2] === FAKE_SHADOW_CONTAINER_ID,
            )
          ) {
            yield* Effect.sleep("5 millis");
          }
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
    const publishedTars = () => {
      const dir = join(tmp.current, "_supabase_home", "cache", "shadow-baseline");
      return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith(".tar")) : [];
    };

    /**
     * Runs `db diff` with the shadow baseline cache on and artifacts under the workdir,
     * against the stateful Docker model the export/restore round trip needs.
     */
    const runCached = (engine: "migra" | "pg-delta") => {
      const s = setup(tmp.current, {
        statefulDocker: true,
        diffSql: "create table t ();\n",
      });
      return withEnvVar(
        "SUPABASE_HOME",
        join(tmp.current, "_supabase_home"),
        withEnvVar(
          "SUPABASE_SHADOW_CACHE",
          "1",
          dbDiff(
            flags(
              engine === "pg-delta"
                ? { usePgDelta: Option.some(true) }
                : { useMigra: Option.some(true) },
            ),
          ).pipe(Effect.provide(s.layer)),
        ),
      ).pipe(Effect.as(s));
    };

    // A migra baseline and a pg-delta baseline must not key to the same cache tar and
    // silently restore each other's cluster; `shadow-cache.integration.test.ts` covers
    // the cache's own half, this covers the call site.
    it.live("a migra-engine baseline is never restored into a pg-delta run", () => {
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        "[experimental.pgdelta]\nenabled = true\n",
      );
      return Effect.gen(function* () {
        // Migra's migrate path forces `pg_net` on regardless of config, and publishes
        // that baseline.
        const migraRun = yield* runCached("migra");
        expect(migraRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        const migraTars = publishedTars();
        expect(migraTars).toHaveLength(1);

        // pg-delta follows the config (webhooks are off here), so it must cold-provision
        // and publish its own baseline rather than restore the forced-on one above.
        const pgDeltaRun = yield* runCached("pg-delta");
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-in")).toHaveLength(0);
        expect(pgDeltaRun.dockerDaemon?.stepCalls("cp-out")).toHaveLength(1);
        expect(publishedTars()).toHaveLength(2);
        expect(publishedTars()).toEqual(expect.arrayContaining(migraTars));
      });
    });
  });
});
