import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  mockOutput,
  mockProcessControl,
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
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import {
  LegacyEdgeRuntimeScript,
  type LegacyEdgeRuntimeRunOpts,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
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
import { legacyDbReset } from "./reset.handler.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";
const COUNT_REPLICATION_SLOTS =
  "SELECT COUNT(*) FROM pg_replication_slots WHERE database IN ('postgres', '_supabase')";

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
 * connection was resolved exactly once per reset — `resolve()` mints/verifies a
 * temporary Postgres login role over the Management API for a `--linked` target.
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

/**
 * A single `LegacyDbConnection` mock shared by BOTH the remote path (tracks
 * `execs`/`queries` for the drop-schema/migrate/seed assertions) and the native
 * local recreate path (the PG14 branch's `session.exec`/`.query` calls) —
 * `legacyDbReset` composes exactly one `LegacyDbConnection` layer, so tests must
 * not register two competing ones (the second would silently shadow the first
 * in `Layer.mergeAll`).
 */
function mockConnection(
  opts: {
    remoteSeeds?: Readonly<Record<string, string>>;
    /** Sequence of `pg_replication_slots` counts returned on successive polls (defaults to `[0]` — drains immediately). */
    replicationSlotCounts?: ReadonlyArray<number>;
    /** Makes the `pg_replication_slots` COUNT query itself fail (permanent, non-retryable). */
    replicationSlotQueryFails?: boolean;
    /** Fails one exact statement with the given SQLSTATE `code` (or no code, for a non-PgError failure). */
    failStatement?: { readonly sql: string; readonly code?: string; readonly message: string };
    /** When set, an `exec` whose SQL contains this substring fails instead of succeeding. */
    execFailsOn?: string;
    execFailsMessage?: string;
  } = {},
) {
  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  let replicationCallIndex = 0;
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, LegacyDbExecError> =>
          Effect.suspend((): Effect.Effect<void, LegacyDbExecError> => {
            if (opts.execFailsOn !== undefined && sql.includes(opts.execFailsOn)) {
              return Effect.fail(
                new LegacyDbExecError({ message: opts.execFailsMessage ?? "syntax error" }),
              );
            }
            execs.push(sql);
            if (opts.failStatement !== undefined && sql === opts.failStatement.sql) {
              return Effect.fail(
                new LegacyDbExecError({
                  message: opts.failStatement.message,
                  code: opts.failStatement.code,
                }),
              );
            }
            return Effect.void;
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
              if (sql === COUNT_REPLICATION_SLOTS) {
                if (opts.replicationSlotQueryFails === true) {
                  return Effect.fail(new LegacyDbExecError({ message: "connection reset" }));
                }
                const counts = opts.replicationSlotCounts ?? [0];
                const count = counts[Math.min(replicationCallIndex, counts.length - 1)] ?? 0;
                replicationCallIndex++;
                return Effect.succeed([{ count: String(count) }]);
              }
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

// ---------------------------------------------------------------------------
// Native local-reset harness — mirrors `db/start/start.integration.test.ts`'s own
// `mockContainerCliSpawner`/`defaultRoute`/`fakeDbSession`, adapted for reset's
// container-REMOVE-then-recreate flow (rather than start's volume-existence probe)
// and its post-recreate satellite-restart + Kong-reload step.
// ---------------------------------------------------------------------------

const PROJECT_ID = "test";
const DB_ID = `supabase_db_${PROJECT_ID}`;
const KONG_ID = `supabase_kong_${PROJECT_ID}`;
const STORAGE_ID = `supabase_storage_${PROJECT_ID}`;

const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';
const STARTING_STATE = '{"Running":true,"Status":"running","Health":{"Status":"starting"}}';
const STOPPED_STATE = '{"Running":false,"Status":"exited"}';

interface SpawnRecord {
  readonly args: ReadonlyArray<string>;
}

type RouteResult = {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
};

function mockContainerCliSpawner(route: (args: ReadonlyArray<string>) => RouteResult) {
  const spawned: Array<SpawnRecord> = [];
  const encoder = new TextEncoder();

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = command._tag === "StandardCommand" ? command.args : [];
        spawned.push({ args });

        if (command._tag !== "StandardCommand") {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn failed",
            }),
          );
        }

        const result = route(args);
        const stdoutBytes = (result.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(6000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    get spawned() {
      return spawned;
    },
  };
}

function containerNameFromCreateArgs(args: ReadonlyArray<string>): string {
  const nameIndex = args.indexOf("--name");
  return nameIndex !== -1 ? (args[nameIndex + 1] ?? "unknown") : "unknown";
}

function fakeContainerId(name: string): string {
  return [...name]
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

const createArgs = (spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> | undefined =>
  spawned.find((s) => s.args[0] === "create")?.args;

// `docker container rm -f <id>` / `docker volume rm -f <name>` — the target is
// argv[3] (after the `-f` flag at argv[2]), not argv[2] itself.
const removedContainers = (spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> =>
  spawned
    .filter((s) => s.args[0] === "container" && s.args[1] === "rm")
    .map((s) => s.args[3] ?? "");

const removedVolumes = (spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> =>
  spawned.filter((s) => s.args[0] === "volume" && s.args[1] === "rm").map((s) => s.args[3] ?? "");

const restartedContainers = (spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> =>
  spawned.filter((s) => s.args[0] === "restart").map((s) => s.args[1] ?? "");

const kongReloadCalls = (spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> =>
  spawned.filter((s) => s.args[0] === "exec" && s.args[1] === KONG_ID);

/** The three PG15+ one-shot migrate jobs (`legacyStartSetupLocalDatabase`'s `LegacyDockerRun` calls). */
const dbSetupJobCalls = (spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> =>
  spawned.filter((s) => s.args[0] === "run" && s.args[1] === "--rm");

interface DefaultRouteOpts {
  readonly running?: boolean;
  readonly neverHealthy?: boolean;
  readonly kongMissing?: boolean;
  readonly kongNotRunning?: boolean;
  readonly kongReloadFails?: boolean;
  readonly storageMissing?: boolean;
  readonly restartFails?: ReadonlyArray<string>;
}

function defaultLocalResetRoute(opts: DefaultRouteOpts = {}) {
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0 };
    if (args[0] === "context" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "container" && args[1] === "rm") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "rm") return { exitCode: 0 };
    if (args[0] === "network" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "network" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "create") {
      const name = containerNameFromCreateArgs(args);
      return { stdout: [fakeContainerId(name)] };
    }
    if (args[0] === "start") return { exitCode: 0 };
    if (args[0] === "restart") {
      const id = args[1] ?? "";
      if (opts.restartFails?.includes(id) === true) {
        return { exitCode: 1, stderr: [`Error: failed to restart ${id}`] };
      }
      return { exitCode: 0 };
    }
    if (args[0] === "exec" && args[1] === KONG_ID) {
      return opts.kongReloadFails === true
        ? { exitCode: 1, stderr: ["reload failed"] }
        : { exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const id = args[2] ?? "";
      if (id === KONG_ID) {
        if (opts.kongMissing === true)
          return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
        return { stdout: [opts.kongNotRunning === true ? STOPPED_STATE : HEALTHY_STATE] };
      }
      if (id === STORAGE_ID) {
        if (opts.storageMissing === true)
          return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
        // A present-but-unhealthy storage container's wait-then-timeout-fails-the-reset
        // behavior is pinned precisely (exact 30s boundary) by
        // `await-storage-ready.unit.test.ts`'s own fake-clock tests — no route knob for
        // it here (review CLI-1958).
        return { stdout: [HEALTHY_STATE] };
      }
      if (opts.running === false)
        return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
      if (opts.neverHealthy === true) return { stdout: [STARTING_STATE] };
      return { stdout: [HEALTHY_STATE] };
    }
    if (args[0] === "logs") return { exitCode: 0 };
    if (args[0] === "ps") return { stdout: [] };
    return { exitCode: 0 };
  };
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

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
    /** `--debug`. Defaults to `false`. */
    debug?: boolean;
    remoteSeeds?: Readonly<Record<string, string>>;
    execFailsOn?: string;
    execFailsMessage?: string;
    yes?: boolean;
    omitRef?: boolean;
    resolveFails?: boolean;
    // Local-reset-only knobs.
    route?: (args: ReadonlyArray<string>) => RouteResult;
    routeOpts?: DefaultRouteOpts;
    replicationSlotCounts?: ReadonlyArray<number>;
    replicationSlotQueryFails?: boolean;
    failStatement?: { readonly sql: string; readonly code?: string; readonly message: string };
    // pg-delta migrations-catalog cache (Go's `down.ResetAll` → `pgcache.TryCacheMigrationsCatalog`,
    // wired into the remote-reset path after a successful migrate/schema-files + seed).
    catalogStdout?: string;
    catalogExportFailWith?: string;
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
  const route = opts.route ?? defaultLocalResetRoute(opts.routeOpts);
  const child = mockContainerCliSpawner(route);
  // Backs both the local recreate's post-setup pg-delta migrations-catalog warmup
  // (`db-setup.ts`'s `legacyTryCacheMigrationsCatalog`) and the remote path's own
  // post-reset catalog-cache call — tracked so tests can assert on it directly
  // (`edgeRunCalls`/`registryEnvAtRunTime`), same as `db push`'s own integration
  // tests (`push.integration.test.ts`).
  const edgeRunCalls: Array<LegacyEdgeRuntimeRunOpts> = [];
  const registryEnvAtRunTime: Array<string | undefined> = [];
  const edgeRuntime = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeRunCalls.push(runOpts);
      registryEnvAtRunTime.push(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]);
      if (opts.catalogExportFailWith !== undefined) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({ message: opts.catalogExportFailWith }),
        );
      }
      return Effect.succeed({ stdout: opts.catalogStdout ?? '{"version":1}', stderr: "" });
    },
  });
  const pgDeltaSslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.succeed(false),
    requireSslForHost: () => Effect.succeed(false),
  });

  const layer = Layer.mergeAll(
    out.layer,
    conn.layer,
    resolver.layer,
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    child.layer,
    mockRuntimeInfo({ platform: "linux" }),
    mockProcessControl().layer,
    alwaysReadyHttpClientLayer,
    legacyDockerRunLayer.pipe(
      Layer.provide(child.layer),
      Layer.provide(mockProcessControl().layer),
    ),
    edgeRuntime,
    pgDeltaSslProbe,
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
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
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    Layer.succeed(CliArgs, { args: opts.args ?? ["db", "reset", "--linked"] }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
    telemetry.layer,
    linkedCache.layer,
  );
  return {
    layer,
    out,
    conn,
    telemetry,
    linkedCache,
    resolver,
    child,
    edgeRunCalls,
    registryEnvAtRunTime,
  };
}

const migrationFile = (version: string, body = "create table t ();") => ({
  [`supabase/migrations/${version}_test.sql`]: body,
});

const PG14_TOML = 'project_id = "test"\n[db]\nmajor_version = 14\n';
const FAST_HEALTH_TOML = '[db]\nhealth_timeout = "1s"\n';

describe("legacy db reset", () => {
  const tmp = useLegacyTempWorkdir("supabase-db-reset-");

  describe("local reset — PG15+", () => {
    it.live("recreates the container, waits healthy, and runs the setup pipeline", () => {
      const { layer, out, child, telemetry } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Resetting local database...");
        expect(out.stderrText).toContain("Recreating database...\n");
        expect(removedContainers(child.spawned)).toContain(DB_ID);
        expect(removedVolumes(child.spawned)).toContain(DB_ID);
        expect(createArgs(child.spawned)).not.toBeUndefined();
        // Default config: realtime, storage, and auth are all enabled (PG >= 15 default).
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(3);
        expect(out.stderrText).toContain("Restarting containers...\n");
        // Satellite restarts (storage/auth/realtime/pooler), then Kong reload.
        expect(restartedContainers(child.spawned)).toEqual(
          expect.arrayContaining([
            "supabase_storage_test",
            "supabase_auth_test",
            "supabase_realtime_test",
            "supabase_pooler_test",
          ]),
        );
        expect(kongReloadCalls(child.spawned)).toHaveLength(1);
        expect(out.stderrText).toContain("Finished ");
        expect(out.stderrText).toContain("on branch ");
        // The local-reset composition now lives in the shared
        // `legacyResetLocalDatabase` (CLI-2062) — confirm this handler's own
        // single `Effect.ensuring` finalizer still fires exactly once through it.
        expect(telemetry.flushCount).toBe(1);
      });
    });

    it.live(
      "passes the resolved --version through to the setup pipeline's seed/migrate step",
      () => {
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n',
          files: {
            ...migrationFile("20240101000000", "create table version_one_marker ();"),
            ...migrationFile("20240202000000", "create table version_two_marker ();"),
          },
          args: ["db", "reset", "--local"],
          isLocal: true,
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({
            ...DEFAULT_FLAGS,
            local: true,
            version: Option.some("20240101000000"),
          }).pipe(Effect.provide(layer));
          // The migration up to (and including) the resolved version IS re-applied through
          // the recreated database's own session (positive assertion — proves MigrateAndSeed
          // actually ran, not just that the cutoff excluded something)...
          expect(conn.execs.some((sql) => sql.includes("create table version_one_marker ()"))).toBe(
            true,
          );
          // ...but the second migration must not be applied at all.
          expect(conn.execs.some((sql) => sql.includes("create table version_two_marker ()"))).toBe(
            false,
          );
        });
      },
    );

    it.live("reapplies migrations and seeds after a default local reset (PG15)", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: {
          ...migrationFile("20240101000000", "create table pg15_marker ();"),
          "supabase/seed.sql": "insert into pg15_seed_marker values (1);",
        },
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(conn.execs.some((sql) => sql.includes("create table pg15_marker ()"))).toBe(true);
        expect(
          conn.execs.some((sql) => sql.includes("insert into pg15_seed_marker values (1)")),
        ).toBe(true);
      });
    });

    it.live("skips seeding with --no-seed on a local reset", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: { "supabase/seed.sql": "insert into t values (1);" },
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({ ...DEFAULT_FLAGS, local: true, noSeed: true }).pipe(
          Effect.provide(layer),
        );
        expect(conn.execs.some((sql) => sql.includes("insert into t values (1)"))).toBe(false);
      });
    });

    it.live("seeds from --sql-paths overriding config on a local reset", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n\n[db.seed]\nenabled = false\n',
        files: { "supabase/custom-seed.sql": "insert into t values (2);" },
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({
          ...DEFAULT_FLAGS,
          local: true,
          sqlPaths: ["custom-seed.sql"],
        }).pipe(Effect.provide(layer));
        expect(conn.execs.some((sql) => sql.includes("insert into t values (2)"))).toBe(true);
      });
    });

    it.live(
      "fails a local reset when the database is not running, before any recreate work",
      () => {
        const { layer, child } = setup(tmp.current, {
          toml: 'project_id = "test"\n',
          args: ["db", "reset", "--local"],
          isLocal: true,
          routeOpts: { running: false },
        });
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("is not running.");
          expect(child.spawned.some((s) => s.args[0] === "container" && s.args[1] === "rm")).toBe(
            false,
          );
        });
      },
    );

    it.live(
      "fails a local reset before the destructive recreate on a malformed config.toml",
      () => {
        const { layer, child } = setup(tmp.current, {
          toml: 'project_id = "unterminated\n',
          args: ["db", "reset", "--local"],
          isLocal: true,
        });
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("failed to load config");
          }
          expect(child.spawned.some((s) => s.args[0] === "container" && s.args[1] === "rm")).toBe(
            false,
          );
        });
      },
    );

    it.live("seeds buckets after a local reset when storage is ready", () => {
      const { layer, child } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        // No buckets configured -> the seed-buckets core short-circuits, but the
        // storage gate is still consulted (Go inspects storage before buckets.Run).
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(
          child.spawned.some(
            (s) => s.args[0] === "container" && s.args[1] === "inspect" && s.args[2] === STORAGE_ID,
          ),
        ).toBe(true);
      });
    });

    it.live("skips bucket seeding when storage is absent (any inspect error)", () => {
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        routeOpts: { storageMissing: true },
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Finished ");
      });
    });

    it.live("uses the detected git branch in the Finished line", () => {
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      const previous = process.env["GITHUB_HEAD_REF"];
      process.env["GITHUB_HEAD_REF"] = "feature-x";
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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

    it.live("emits a json result for a local reset", () => {
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        format: "json",
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data?.["target"]).toBe("local");
      });
    });

    it.live("still flushes telemetry when the recreate itself fails", () => {
      const { layer, telemetry } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        route: (args) => {
          if (args[0] === "container" && args[1] === "rm") {
            return { exitCode: 1, stderr: ["Error: permission denied"] };
          }
          return defaultLocalResetRoute()(args);
        },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("failed to remove container");
        }
        expect(telemetry.flushed).toBe(true);
      });
    });
  });

  describe("local reset — Kong reload", () => {
    it.live("fails the whole command with the exact suggestion when Kong reload fails", () => {
      const { layer } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        routeOpts: { kongReloadFails: true },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause) as { message: string; suggestion?: string };
          // Byte-matches Go's `DockerExecOnceWithStream` fixed error text (`docker.go:646-648`),
          // not the raw exit code.
          expect(error.message).toContain("failed to reload kong: error executing command");
          expect(error.suggestion).toContain(
            "Local services restarted, but API routes may return 502",
          );
          expect(error.suggestion).toContain(`docker restart ${KONG_ID}`);
        }
      });
    });

    it.live("skips the reload without failing when Kong is excluded from the stack", () => {
      const { layer, out, child } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        routeOpts: { kongMissing: true },
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Finished ");
        expect(kongReloadCalls(child.spawned)).toHaveLength(0);
      });
    });

    it.live("skips the reload without failing when Kong is present but stopped", () => {
      const { layer, out, child } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        routeOpts: { kongNotRunning: true },
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Finished ");
        expect(kongReloadCalls(child.spawned)).toHaveLength(0);
      });
    });

    it.live("fails the command when a satellite restart fails", () => {
      const { layer } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
        routeOpts: { restartFails: ["supabase_storage_test"] },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("failed to restart supabase_storage_test");
        }
      });
    });
  });

  describe("local reset — PG14", () => {
    it.live(
      "recreates via the four-statement DROP/CREATE sequence, then initDatabase + RestartDatabase",
      () => {
        const { layer, out, child, conn } = setup(tmp.current, {
          toml: PG14_TOML,
          args: ["db", "reset", "--local"],
          isLocal: true,
        });
        return Effect.gen(function* () {
          yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          // recreateDatabase: no container/volume removal at all on this branch.
          expect(removedContainers(child.spawned)).toHaveLength(0);
          expect(
            conn.execs.some((sql) => sql === "DROP DATABASE IF EXISTS postgres WITH (FORCE)"),
          ).toBe(true);
          expect(
            conn.execs.some((sql) => sql === "CREATE DATABASE postgres WITH OWNER postgres"),
          ).toBe(true);
          expect(
            conn.execs.some((sql) => sql === "DROP DATABASE IF EXISTS _supabase WITH (FORCE)"),
          ).toBe(true);
          expect(
            conn.execs.some((sql) => sql === "CREATE DATABASE _supabase WITH OWNER postgres"),
          ).toBe(true);
          // initDatabase: schema SQL execs directly over the session — no PG15+ one-shot jobs.
          expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
          expect(conn.execs.length).toBeGreaterThan(4);
          // RestartDatabase: "Restarting containers..." then a real `docker restart` of `db`,
          // THEN the satellite restarts + Kong reload (RestartDatabase-then-restartServices).
          expect(out.stderrText).toContain("Restarting containers...\n");
          const dbRestartIndex = child.spawned.findIndex(
            (s) => s.args[0] === "restart" && s.args[1] === DB_ID,
          );
          const kongReloadIndex = child.spawned.findIndex(
            (s) => s.args[0] === "exec" && s.args[1] === KONG_ID,
          );
          expect(dbRestartIndex).toBeGreaterThanOrEqual(0);
          expect(kongReloadIndex).toBeGreaterThan(dbRestartIndex);
        });
      },
    );

    it.live(
      "attaches Go's ExecBatch error context to a failed DROP/CREATE DATABASE statement",
      () => {
        // Go builds these four statements as a `migration.MigrationFile` and runs them
        // through `.ExecBatch` (`reset.go:165-173`), so a failure gets the same rich
        // context (`At statement: <index>` + the statement text) a real migration file
        // failure would — not the bare driver error (review CLI-1958).
        const { layer } = setup(tmp.current, {
          toml: PG14_TOML,
          args: ["db", "reset", "--local"],
          isLocal: true,
          failStatement: {
            sql: "CREATE DATABASE postgres WITH OWNER postgres",
            message: "permission denied to create database",
          },
        });
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("permission denied to create database");
            expect(cause).toContain("At statement: 1");
            expect(cause).toContain("CREATE DATABASE postgres WITH OWNER postgres");
          }
        });
      },
    );

    it.live("swallows a disconnect-clients failure when the code is invalid_catalog_name", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: PG14_TOML,
        args: ["db", "reset", "--local"],
        isLocal: true,
        failStatement: {
          sql: "ALTER DATABASE postgres ALLOW_CONNECTIONS false",
          code: "3D000",
          message: 'database "postgres" does not exist',
        },
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        // The reset still completes: the swallowed failure does not abort the recreate.
        expect(
          conn.execs.some((sql) => sql === "CREATE DATABASE postgres WITH OWNER postgres"),
        ).toBe(true);
      });
    });

    it.live("surfaces a disconnect-clients failure for any other error code", () => {
      const { layer } = setup(tmp.current, {
        toml: PG14_TOML,
        args: ["db", "reset", "--local"],
        isLocal: true,
        failStatement: {
          sql: "ALTER DATABASE postgres ALLOW_CONNECTIONS false",
          code: "42501",
          message: "permission denied",
        },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("failed to disconnect clients");
        }
      });
    });

    it.live("swallows a disconnect-clients failure that is not a PgError at all", () => {
      // A non-PgError failure (network blip) is swallowed too — only a genuine PgError
      // whose code differs from 3D000 surfaces.
      const { layer, conn } = setup(tmp.current, {
        toml: PG14_TOML,
        args: ["db", "reset", "--local"],
        isLocal: true,
        failStatement: {
          sql: "ALTER DATABASE postgres ALLOW_CONNECTIONS false",
          message: "connection reset by peer",
        },
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        // Swallowed: no PgError code at all -> the reset still completes.
        expect(
          conn.execs.some((sql) => sql === "CREATE DATABASE postgres WITH OWNER postgres"),
        ).toBe(true);
      });
    });

    it.live(
      "swallows a disconnect-clients failure carrying a node system errno, not a real SQLSTATE",
      () => {
        // `legacyToExecError`'s fallback (`legacy-db-connection.sql-pg.layer.ts`) sets `code`
        // from `legacyExtractSqlState`, which returns ANY string `code` found in the cause
        // chain — including a bare node system errno like `ECONNRESET`/`ETIMEDOUT`, which is
        // NOT a Postgres SQLSTATE. Go's `errors.As(err, &pgErr)` never matches a socket error,
        // so Go swallows this too — the discriminator must check `legacyIsSqlState(code)`
        // before comparing against `3D000`, not just `code !== undefined`.
        const { layer, conn } = setup(tmp.current, {
          toml: PG14_TOML,
          args: ["db", "reset", "--local"],
          isLocal: true,
          failStatement: {
            sql: "ALTER DATABASE postgres ALLOW_CONNECTIONS false",
            code: "ECONNRESET",
            message: "socket hang up",
          },
        });
        return Effect.gen(function* () {
          yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          // Swallowed: a node errno is not a SQLSTATE -> the reset still completes.
          expect(
            conn.execs.some((sql) => sql === "CREATE DATABASE postgres WITH OWNER postgres"),
          ).toBe(true);
        });
      },
    );

    it.live(
      "retries the replication-slot drain on a constant 1-second backoff",
      () => {
        const { layer, conn } = setup(tmp.current, {
          toml: PG14_TOML,
          args: ["db", "reset", "--local"],
          isLocal: true,
          replicationSlotCounts: [2, 1, 0],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          const countCalls = conn.queries.filter((q) => q.sql === COUNT_REPLICATION_SLOTS);
          expect(countCalls).toHaveLength(3);
        });
      },
      10_000,
    );

    it.live("fails permanently (no retry) when counting replication slots itself fails", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: PG14_TOML,
        args: ["db", "reset", "--local"],
        isLocal: true,
        replicationSlotQueryFails: true,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("failed to count replication slots");
        }
        // A single attempt — the permanent failure never retries.
        const countCalls = conn.queries.filter((q) => q.sql === COUNT_REPLICATION_SLOTS);
        expect(countCalls).toHaveLength(1);
      });
    });

    it.live(
      "exhausts all 10 retries and fails when replication slots never drain",
      () => {
        const { layer } = setup(tmp.current, {
          toml: PG14_TOML,
          args: ["db", "reset", "--local"],
          isLocal: true,
          replicationSlotCounts: [1],
        });
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("replication slots still active");
          }
        });
      },
      20_000,
    );

    it.live("passes --no-seed and the resolved version to the final MigrateAndSeed step", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: PG14_TOML,
        files: { "supabase/seed.sql": "insert into t values (9);" },
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({ ...DEFAULT_FLAGS, local: true, noSeed: true }).pipe(
          Effect.provide(layer),
        );
        expect(conn.execs.some((sql) => sql.includes("insert into t values (9)"))).toBe(false);
      });
    });

    it.live("reapplies migrations and seeds after a default local reset (PG14)", () => {
      // Positive assertion: proves the final MigrateAndSeed step actually runs and
      // re-applies the user's migrations/seed — this step is currently deletable with
      // every OTHER PG14 assertion (DROP/CREATE statements, restart ordering,
      // disconnect/replication-slot behavior) staying green.
      const { layer, conn } = setup(tmp.current, {
        toml: PG14_TOML,
        files: {
          ...migrationFile("20240101000000", "create table pg14_marker ();"),
          "supabase/seed.sql": "insert into pg14_seed_marker values (1);",
        },
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(conn.execs.some((sql) => sql.includes("create table pg14_marker ()"))).toBe(true);
        expect(
          conn.execs.some((sql) => sql.includes("insert into pg14_seed_marker values (1)")),
        ).toBe(true);
      });
    });

    it.live(
      "passes the resolved --version cutoff through to the final MigrateAndSeed step (PG14)",
      () => {
        const { layer, conn } = setup(tmp.current, {
          toml: PG14_TOML,
          files: {
            ...migrationFile("20240101000000", "create table version_one_marker ();"),
            ...migrationFile("20240202000000", "create table version_two_marker ();"),
          },
          args: ["db", "reset", "--local"],
          isLocal: true,
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({
            ...DEFAULT_FLAGS,
            local: true,
            version: Option.some("20240101000000"),
          }).pipe(Effect.provide(layer));
          // Positive: the migration up to (and including) the resolved version IS re-applied.
          expect(conn.execs.some((sql) => sql.includes("create table version_one_marker ()"))).toBe(
            true,
          );
          // The second migration must not be applied at all.
          expect(conn.execs.some((sql) => sql.includes("create table version_two_marker ()"))).toBe(
            false,
          );
        });
      },
    );

    it.live(
      "does NOT run globals.sql on the PG14 reset path (deliberately different from db start's PG14 path)",
      () => {
        const { layer, conn } = setup(tmp.current, {
          toml: PG14_TOML,
          args: ["db", "reset", "--local"],
          isLocal: true,
        });
        return Effect.gen(function* () {
          yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          // Go's reset.go `initDatabase` calls the EXPORTED `InitSchema14` directly — unlike
          // `db start`'s own PG14 path, which execs globals.sql first. A fingerprint unique
          // to `LEGACY_START_DB_GLOBALS_SQL` (see `templates/db-globals.sql.ts`) must never
          // appear in this reset's execs.
          expect(conn.execs.some((sql) => sql.includes("CREATE ROLE anon"))).toBe(false);
        });
      },
    );

    it.live(
      "resolves db.migrations.schema_paths against supabase/ before applying it on an experimental PG14 reset",
      () => {
        // `legacyRecreateLocalDatabase14` must pass the NORMALIZED `toml.schemaPaths`
        // (`supabase/`-prefix-resolved by `legacyCheckDbToml`) into the final
        // `legacyMigrateAndSeed` call, not the raw, unresolved config value — the raw
        // `["schema.sql"]` pattern would glob-match against the WORKDIR root (where no
        // such file exists), failing the whole reset, instead of `supabase/schema.sql`
        // (where this test actually places the file).
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n[db]\nmajor_version = 14\n[db.migrations]\nschema_paths = ["schema.sql"]\n',
          files: { "supabase/schema.sql": "create table schema_paths_marker ();" },
          args: ["db", "reset", "--local"],
          isLocal: true,
          experimental: true,
        });
        return Effect.gen(function* () {
          yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          expect(
            conn.execs.some((sql) => sql.includes("create table schema_paths_marker ()")),
          ).toBe(true);
        });
      },
    );
  });

  describe("local reset — health timeouts", () => {
    it.live("a container health-check timeout fails the whole recreate", () => {
      const { layer } = setup(tmp.current, {
        toml: `project_id = "test"\n${FAST_HEALTH_TOML}`,
        args: ["db", "reset", "--local"],
        isLocal: true,
        routeOpts: { neverHealthy: true },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      });
    });
  });

  describe("remote reset", () => {
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
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && failure.value._tag).toBe(
            "LegacyDbResetInvalidVersionError",
          );
          // Go's reset.Run returns the bare repair.ErrInvalidVersion (reset.go:35-36) —
          // no `failed to parse <v>:` wrapper (that belongs to `migration repair`).
          expect(Option.isSome(failure) && failure.value.message).toBe("invalid version number");
        }
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

    it.live("rejects an out-of-int64-range --version", () => {
      // Go's `strconv.Atoi` == `ParseInt(s, 10, 0)`, which rejects magnitudes outside the
      // int64 range even though the text is all digits. `INTEGER_PATTERN` alone would have
      // accepted this and fallen through to the glob check instead.
      const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          version: Option.some("99999999999999999999"),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && failure.value._tag).toBe(
            "LegacyDbResetInvalidVersionError",
          );
          expect(Option.isSome(failure) && failure.value.message).toBe("invalid version number");
        }
      });
    });

    it.live("treats an empty --version like no version at all", () => {
      // Go's `len(version) > 0` guard (reset.go:34) skips validation entirely for an empty
      // --version, so it must fall through to a full reset rather than glob-checking "" or
      // rejecting it as an invalid version.
      const { layer, out, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          version: Option.some(""),
        }).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Resetting remote database...");
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
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

    it.live("honors pg-delta's no-transaction migration header on remote reset", () => {
      const set = "SET check_function_bodies = off";
      const action = "DROP SUBSCRIPTION app_events";
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: migrationFile(
          "20240101000000",
          `-- pg-delta: transaction=false\n${set};\n${action};\nRESET ALL;`,
        ),
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
        const setupCommit = conn.execs.indexOf("COMMIT");
        const setIndex = conn.execs.indexOf(set);
        const actionIndex = conn.execs.indexOf(action);
        const cleanupIndex = conn.execs.lastIndexOf("RESET ALL");

        expect(setIndex).toBeGreaterThan(setupCommit);
        expect(actionIndex).toBeGreaterThan(setIndex);
        expect(cleanupIndex).toBeGreaterThan(actionIndex);
        expect(conn.execs.slice(setIndex, cleanupIndex + 1)).toEqual([set, action, "RESET ALL"]);
        expect(
          conn.queries.some((query) => query.sql.includes("INSERT INTO supabase_migrations")),
        ).toBe(true);
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
          expect(JSON.stringify(exit.cause)).toContain(
            "failed to parse config: missing private key",
          );
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

    it.live(
      "caches the migrations catalog after a successful remote reset with SUPABASE_EXPERIMENTAL_PG_DELTA set",
      () => {
        // Go's `down.ResetAll` (`internal/migration/down/down.go:48-61`, the function
        // `resetRemote` delegates to) best-effort caches the pg-delta migrations
        // catalog right after `apply.MigrateAndSeed` succeeds — gated on
        // `pgcache.ShouldCacheMigrationsCatalog()` (`experimental.pgdelta.enabled` OR
        // the legacy `SUPABASE_EXPERIMENTAL_PG_DELTA` env switch), independent of
        // `--experimental`'s own schema-files gate.
        const { layer, out, edgeRunCalls } = setup(tmp.current, {
          toml: 'project_id = "test"\n',
          files: {
            ...migrationFile("20240101000000"),
            "supabase/.env": "SUPABASE_EXPERIMENTAL_PG_DELTA=true\n",
          },
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
          expect(edgeRunCalls).toHaveLength(1);
        });
      },
    );

    it.live(
      "resolves the pg-delta cache export image via SUPABASE_INTERNAL_IMAGE_REGISTRY from supabase/.env",
      () => {
        // Go's `loadNestedEnv` (`os.Setenv`) makes a `supabase/.env`-only
        // `SUPABASE_INTERNAL_IMAGE_REGISTRY` visible to the WHOLE reset run, including
        // the pg-delta catalog export the reset handler triggers after a successful
        // remote reset (review CLI-1958 round 18) — mirroring `db push`'s own
        // `legacyApplyProjectEnv(projectEnv)` scoping (same-named test in
        // `push.integration.test.ts`). Without that scoping, this reads only real
        // `process.env` and falls back to the default registry instead.
        const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
        const { layer, registryEnvAtRunTime } = setup(tmp.current, {
          toml: 'project_id = "test"\n[experimental.pgdelta]\nenabled = true\n',
          files: {
            ...migrationFile("20240101000000"),
            "supabase/.env": "SUPABASE_INTERNAL_IMAGE_REGISTRY=my-mirror.example.com\n",
          },
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(registryEnvAtRunTime).toEqual(["my-mirror.example.com"]);
          // The finalizer reverted it — never leaks into the surrounding process.
          expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (prev === undefined) delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
              else process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = prev;
            }),
          ),
        );
      },
    );

    it.live("warns without failing the reset when the migrations-catalog cache write fails", () => {
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n[experimental.pgdelta]\nenabled = true\n',
        files: migrationFile("20240101000000"),
        confirm: [true],
        catalogExportFailWith: "edge-runtime script produced no output",
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(
          "Warning: failed to cache migrations catalog: edge-runtime script produced no output",
        );
      });
    });

    it.live(
      "falls back to the linked project ref for the pg-delta cache when config.toml has no project_id",
      () => {
        // Go's `flags.LoadConfig` seeds `Config.ProjectId = ProjectRef` BEFORE
        // `Config.Load` runs, so on the linked remote path an absent `project_id`
        // retains the linked ref rather than falling to the workdir basename.
        const { layer, out, edgeRunCalls } = setup(tmp.current, {
          toml: "[experimental.pgdelta]\nenabled = true\n",
          ref: LEGACY_VALID_REF,
          files: migrationFile("20240101000000"),
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
          expect(edgeRunCalls).toHaveLength(1);
        });
      },
    );

    it.live(
      "skips the migrations-catalog cache for a versioned remote reset even with pg-delta caching enabled",
      () => {
        // `pgcache.TryCacheMigrationsCatalog` no-ops on any non-empty `version`
        // (`pgcache/cache.go:73`, `len(version) > 0`) — a `--version`/`--last` reset
        // never refreshes the cache, unlike a full (versionless) reset.
        const { layer, out, edgeRunCalls } = setup(tmp.current, {
          toml: 'project_id = "test"\n[experimental.pgdelta]\nenabled = true\n',
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
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
          expect(edgeRunCalls).toHaveLength(0);
        });
      },
    );

    it.live(
      "applies configured schema files instead of replaying migrations on an experimental remote reset",
      () => {
        // `--linked=false` still selects the linked/remote target (Cobra `Changed`
        // semantics) — exercised here alongside the schema-files branch itself.
        const { layer, out, conn, resolver, linkedCache } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: {
            "supabase/schemas/01_users.sql": "create table schema_users ();",
            ...migrationFile("20240101000000", "create table migrated_table ();"),
            "supabase/seed.sql": "insert into t values (1);",
          },
          experimental: true,
          args: ["db", "reset", "--linked=false"],
          confirm: [true],
          ref: LEGACY_VALID_REF,
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: false }).pipe(Effect.provide(layer));
          // The configured schema file ran...
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
          // ...but the timestamped migration did NOT — Go's `if`/`else if` is mutually
          // exclusive (`apply.go:19-27`); taking the schema-files branch means migrations
          // never run at all.
          expect(conn.execs.some((s) => s.includes("create table migrated_table"))).toBe(false);
          expect(out.stderrText).not.toContain("Applying migration");
          // Seeding still runs afterward — Go's `applySeedFiles` sits outside the
          // if/else if (`apply.go:26`).
          expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
          // A real connection is resolved now — this is a fully native path, not a
          // delegated one that discarded the resolve (CLI-1958 removed the delegate).
          expect(resolver.calls).toBe(1);
          expect(linkedCache.cached).toBe(true);
          expect(linkedCache.cachedRef).toBe(LEGACY_VALID_REF);
        });
      },
    );

    it.live(
      "applies schema files across multiple schema_paths patterns in declaration order, sorted within each pattern",
      () => {
        // Go sorts matches WITHIN each pattern (`sort.Strings`, `config.go:155`) but
        // preserves DECLARATION order ACROSS patterns (no global re-sort) — `zz/*.sql`'s
        // files must all run before `aa/*.sql`'s, even though "aa" sorts before "zz".
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["zz/*.sql", "aa/*.sql"]\n',
          files: {
            "supabase/zz/b.sql": "create table zz_b ();",
            "supabase/zz/a.sql": "create table zz_a ();",
            "supabase/aa/b.sql": "create table aa_b ();",
            "supabase/aa/a.sql": "create table aa_a ();",
          },
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          const order = conn.execs
            .map((s) => /create table (\w+) \(\)/.exec(s)?.[1])
            .filter((name): name is string => name !== undefined);
          expect(order).toEqual(["zz_a", "zz_b", "aa_a", "aa_b"]);
        });
      },
    );

    it.live(
      "expands a schema_paths directory entry to its nested .sql files on an experimental remote reset",
      () => {
        // `[db.migrations].schema_paths` resolves through Go's `Glob.SQLFiles` (not
        // `Glob.Files`), which expands a directory match to its regular `.sql` files,
        // recursively — unlike a plain glob pattern.
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["some-dir"]\n',
          files: {
            "supabase/some-dir/01_top.sql": "create table dir_top ();",
            "supabase/some-dir/nested/02_nested.sql": "create table dir_nested ();",
          },
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table dir_top"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table dir_nested"))).toBe(true);
        });
      },
    );

    it.live(
      "silently applies nothing when schema_paths is unset on an experimental remote reset (Go's undocumented default-config behavior)",
      () => {
        // Go's `schema_paths` default is `[]` (`pkg/config/templates/config.toml:64`).
        // With no patterns to glob, `SQLFiles` returns a nil error, so `applySchemaFiles`
        // is a silent no-op — Go does NOT fall back to replaying migrations (`apply.go:
        // 19-27` is a hard `if`/`else if`).
        const { layer, out, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n',
          files: migrationFile("20240101000000", "create table migrated_table ();"),
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          // Schemas are still dropped (ResetAll drops before MigrateAndSeed)...
          expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
          // ...but the local migration is silently skipped, not applied.
          expect(conn.execs.some((s) => s.includes("create table migrated_table"))).toBe(false);
          expect(out.stderrText).not.toContain("Applying migration");
        });
      },
    );

    it.live(
      "replays migrations instead of schema files on an experimental remote reset when pg-delta is enabled",
      () => {
        const { layer, out, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n\n[experimental.pgdelta]\nenabled = true\n',
          files: {
            "supabase/schemas/01_users.sql": "create table schema_users ();",
            ...migrationFile("20240101000000", "create table migrated_table ();"),
          },
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          // `IsPgDeltaEnabled()` disables the schema-files branch (`apply.go:19`) even
          // though `--experimental` and `schema_paths` are both set.
          expect(conn.execs.some((s) => s.includes("create table migrated_table"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(false);
          expect(out.stderrText).toContain("Applying migration");
        });
      },
    );

    it.live(
      "replays migrations instead of schema files on an experimental remote reset with a resolved version",
      () => {
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: {
            "supabase/schemas/01_users.sql": "create table schema_users ();",
            ...migrationFile("20240101000000", "create table migrated_table ();"),
          },
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({
            ...DEFAULT_FLAGS,
            linked: true,
            version: Option.some("20240101000000"),
          }).pipe(Effect.provide(layer));
          // A resolved --version disables the schema-files branch (`apply.go:19` requires
          // `len(version) == 0`), even with `--experimental` set.
          expect(conn.execs.some((s) => s.includes("create table migrated_table"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(false);
        });
      },
    );

    it.live(
      "fails an experimental remote reset when no schema_paths pattern matches anything",
      () => {
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["nomatch/*.sql"]\n',
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("no files matched pattern: supabase/nomatch/*.sql");
            // No CmdSuggestion on this failure mode — only a per-file exec failure sets one.
            expect(cause).not.toContain("See schema file");
          }
          // Schemas were already dropped before the failed apply step (Go's ResetAll order).
          expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
        });
      },
    );

    it.live("ignores a partial schema_paths glob failure once at least one pattern matches", () => {
      // Go's `applySchemaFiles` only surfaces the joined glob error when NO pattern
      // matched anything at all (`apply.go:53-55`); a partial failure is silently dropped.
      const { layer, out, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql", "typo/*.sql"]\n',
        files: {
          "supabase/schemas/01_users.sql": "create table schema_users ();",
          // Present so the (unrelated) seed glob's own "no files matched" WARN line
          // doesn't show up and get confused with the schema-files warning below.
          "supabase/seed.sql": "insert into t values (1);",
        },
        experimental: true,
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
        expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
        expect(out.stderrText).not.toContain("no files matched pattern");
      });
    });

    it.live(
      "attaches Go's schema-file suggestion when a schema file fails to apply on an experimental remote reset",
      () => {
        const { layer } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: { "supabase/schemas/01_users.sql": "not valid sql;" },
          experimental: true,
          confirm: [true],
          execFailsOn: "not valid sql",
          execFailsMessage: 'syntax error at or near "not"',
        });
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("syntax error at or near");
            // Go's `CmdSuggestion = "See schema file: <Bold(fp)>"` (`apply.go:63`).
            expect(cause).toContain("See schema file:");
            expect(cause).toContain("supabase/schemas/01_users.sql");
          }
        });
      },
    );

    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

    it.live.skipIf(isRoot)(
      "does not attach the schema-file suggestion when a schema file cannot be READ on an experimental remote reset",
      () => {
        // Go's `NewMigrationFromFile` (the file-read/parse step, `apply.go:57-59`) returns
        // BEFORE `CmdSuggestion` is ever set — only a later `ExecBatch` (statement
        // execution) failure attaches it (`apply.go:61-63`). A file that glob-matches but
        // can't be read (permissions changed after the glob) must fail WITHOUT the
        // suggestion, unlike the exec-failure case above.
        const schemaFile = join(tmp.current, "supabase", "schemas", "01_users.sql");
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: { "supabase/schemas/01_users.sql": "create table schema_users ();" },
          experimental: true,
          confirm: [true],
        });
        chmodSync(schemaFile, 0o000);
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).not.toContain("See schema file");
          }
          // The statement was never reached, so it was never executed.
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(false);
        }).pipe(Effect.ensuring(Effect.sync(() => chmodSync(schemaFile, 0o644))));
      },
    );

    it.live.skipIf(isRoot)(
      "fails an experimental remote reset (without silently succeeding) when a matched schema_paths directory cannot be walked",
      () => {
        // Go's `fs.WalkDir` stops on the first `ReadDir` failure and `applySchemaFiles`
        // only silently drops that error when at least one OTHER file was still found
        // (`apply.go:53-55`); with a single pattern matching only the unreadable
        // directory, `declared` stays empty and Go aborts the command — it must not
        // report success having applied nothing. Verified empirically against `apps/cli-go`.
        const schemasDir = join(tmp.current, "supabase", "schemas");
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas"]\n',
          files: { "supabase/schemas/01_users.sql": "create table schema_users ();" },
          experimental: true,
          confirm: [true],
        });
        chmodSync(schemasDir, 0o000);
        return Effect.gen(function* () {
          const exit = yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("failed to walk matched directory");
            expect(cause).not.toContain("See schema file");
          }
          // Schemas were already dropped before the failed apply step (Go's ResetAll order).
          expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(false);
        }).pipe(Effect.ensuring(Effect.sync(() => chmodSync(schemasDir, 0o755))));
      },
    );

    it.live(
      "takes the native experimental schema-files path via SUPABASE_EXPERIMENTAL in the project .env",
      () => {
        // Go loads nested env before `reset.Run` reads viper's EXPERIMENTAL, so a
        // `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` reaches the native
        // three-conjunct gate the same way an explicit `--experimental` does.
        const previous = process.env["SUPABASE_EXPERIMENTAL"];
        delete process.env["SUPABASE_EXPERIMENTAL"];
        const { layer, out, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: {
            "supabase/.env": "SUPABASE_EXPERIMENTAL=true\n",
            "supabase/schemas/01_users.sql": "create table schema_users ();",
            ...migrationFile("20240101000000", "create table migrated_table ();"),
          },
          confirm: [true],
          // No experimental flag / shell env — only the project .env sets it.
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table migrated_table"))).toBe(false);
          expect(out.stderrText).not.toContain("Applying migration");
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

    it.live(
      "applies configured schema files and skips seeding on an experimental remote --db-url reset",
      () => {
        const { layer, conn, resolver } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: { "supabase/schemas/01_users.sql": "create table schema_users ();" },
          experimental: true,
          args: ["db", "reset", "--db-url", "postgresql://db.example.com:5432/postgres"],
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({
            ...DEFAULT_FLAGS,
            dbUrl: Option.some("postgresql://db.example.com:5432/postgres"),
            noSeed: true,
          }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("insert into"))).toBe(false);
          // A `--db-url` target always resolves a real connection — this is no longer
          // delegated at all (CLI-1958).
          expect(resolver.calls).toBe(1);
        });
      },
    );

    it.live("recreates to a specific --version on a local db-url reset", () => {
      const { layer, out, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: migrationFile("20240101000000"),
        args: ["db", "reset", "--db-url", "postgresql://localhost:54322/postgres"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* legacyDbReset({
          ...DEFAULT_FLAGS,
          dbUrl: Option.some("postgresql://localhost:54322/postgres"),
          version: Option.some("20240101000000"),
        }).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Resetting local database to version: 20240101000000");
        expect(conn.execs.some((sql) => sql.includes("insert into"))).toBe(false);
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

    it.live(
      "seeds from --sql-paths on an experimental remote reset, independently of the schema-files apply",
      () => {
        // `--sql-paths` overrides `[db.seed].sql_paths` regardless of which branch of
        // `apply.MigrateAndSeed` ran — Go's `applySeedFiles` sits outside the if/else if
        // (`apply.go:26`), and the seed override is resolved entirely upstream of it.
        const { layer, out, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: {
            "supabase/schemas/01_users.sql": "create table schema_users ();",
            "supabase/custom-seed.sql": "insert into t values (2);",
          },
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* legacyDbReset({
            ...DEFAULT_FLAGS,
            linked: true,
            sqlPaths: ["custom-seed.sql"],
          }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
          expect(out.stderrText).toContain("Seeding data from supabase/custom-seed.sql...");
        });
      },
    );
  });
});
