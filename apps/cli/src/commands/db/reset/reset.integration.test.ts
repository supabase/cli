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
} from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { dockerRunLayer } from "../../../command-internal/docker-run.layer.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConfigConnectTempRoleError } from "../../../command-internal/db-config.errors.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type PgConnInput,
  type DbSession,
} from "../../../command-internal/db-connection.service.ts";
import { dbReset } from "./reset.handler.ts";
import type { DbResetFlags } from "./reset.command.ts";

const LIST_MIGRATIONS =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const SELECT_SEEDS = "SELECT path, hash FROM supabase_migrations.seed_files";
const COUNT_REPLICATION_SLOTS =
  "SELECT COUNT(*) FROM pg_replication_slots WHERE database IN ('postgres', '_supabase')";

const CONN: PgConnInput = {
  host: "db.example.supabase.co",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

const DEFAULT_FLAGS: DbResetFlags = {
  dbUrl: Option.none(),
  linked: false,
  local: false,
  projectRef: Option.none(),
  noSeed: false,
  sqlPaths: [],
  version: Option.none(),
  last: Option.none(),
};

/**
 * Tracks every `resolve`/`resolvePoolerFallback` call so tests can prove a connection was
 * resolved exactly once per reset.
 */
function mockResolver(opts: {
  isLocal: boolean;
  ref?: string;
  omitRef?: boolean;
  resolveFails?: boolean;
}) {
  let calls = 0;
  const layer = Layer.succeed(DbConfigResolver, {
    resolve: (flags: DbConfigFlags) => {
      calls++;
      // A threaded `--project-ref` flag takes the same precedence a real resolver gives it, so
      // a test can prove the flag (not just `opts.ref`) drives the resolved ref.
      const linkedProjectRef = flags.linkedProjectRef ?? Option.none();
      const resolvedRef =
        Option.isSome(linkedProjectRef) && linkedProjectRef.value.length > 0
          ? linkedProjectRef.value
          : opts.ref;
      return opts.resolveFails === true
        ? Effect.fail(
            new DbConfigConnectTempRoleError({
              message: "failed to create login role: network error",
            }),
          )
        : Effect.succeed(
            (opts.omitRef === true
              ? { conn: CONN, isLocal: opts.isLocal }
              : {
                  conn: CONN,
                  isLocal: opts.isLocal,
                  ref: resolvedRef !== undefined ? Option.some(resolvedRef) : Option.none(),
                }) satisfies ResolvedDbConfig,
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
 * A single `DbConnection` mock shared by both the remote path (tracks `execs`/`queries` for
 * drop-schema/migrate/seed assertions) and the native local recreate path (the PG14 branch's
 * `session.exec`/`.query` calls) — `dbReset` composes exactly one `DbConnection` layer.
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
  const layer = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string): Effect.Effect<void, DbExecError> =>
          Effect.suspend((): Effect.Effect<void, DbExecError> => {
            if (opts.execFailsOn !== undefined && sql.includes(opts.execFailsOn)) {
              return Effect.fail(
                new DbExecError({ message: opts.execFailsMessage ?? "syntax error" }),
              );
            }
            execs.push(sql);
            if (opts.failStatement !== undefined && sql === opts.failStatement.sql) {
              return Effect.fail(
                new DbExecError({
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
        ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DbExecError> =>
          Effect.suspend((): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DbExecError> => {
            queries.push({ sql, params });
            if (sql === SELECT_SEEDS) {
              return Effect.succeed(
                Object.entries(opts.remoteSeeds ?? {}).map(([path, hash]) => ({ path, hash })),
              );
            }
            if (sql === LIST_MIGRATIONS) return Effect.succeed([]);
            if (sql === COUNT_REPLICATION_SLOTS) {
              if (opts.replicationSlotQueryFails === true) {
                return Effect.fail(new DbExecError({ message: "connection reset" }));
              }
              const counts = opts.replicationSlotCounts ?? [0];
              const count = counts[Math.min(replicationCallIndex, counts.length - 1)] ?? 0;
              replicationCallIndex++;
              return Effect.succeed([{ count: String(count) }]);
            }
            return Effect.succeed([]);
          }),
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
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

// `docker ... rm -f <id>` puts the target at argv[3] (after the `-f` flag at argv[2]).
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

/** The three PG15+ one-shot migrate jobs (`startSetupLocalDatabase`'s `DockerRun` calls). */
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
        // A present-but-unhealthy storage container's wait-then-timeout behavior (exact 30s
        // boundary) is covered by `await-storage-ready.unit.test.ts`'s fake-clock tests instead.
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
    // Simulates an unlinked workdir: `loadProjectRef` fails with `ProjectRefNotLinkedError`
    // absent an explicit `--project-ref` flag, instead of falling back to `opts.ref`.
    linkedFails?: boolean;
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
  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();
  // The local-reset bucket-seed core statically requires the (lazy) Management-API factory,
  // though `--local` never invokes it.
  const platformApi = mockCommandPlatformApiService({});
  const resolver = mockResolver({
    isLocal: opts.isLocal ?? false,
    ref: opts.ref ?? VALID_REF,
    omitRef: opts.omitRef,
    resolveFails: opts.resolveFails,
  });
  const route = opts.route ?? defaultLocalResetRoute(opts.routeOpts);
  const child = mockContainerCliSpawner(route);
  const layer = Layer.mergeAll(
    out.layer,
    conn.layer,
    resolver.layer,
    mockCommandSettings({ workdir }),
    BunServices.layer,
    child.layer,
    mockRuntimeInfo({ platform: "linux" }),
    mockProcessControl().layer,
    alwaysReadyHttpClientLayer,
    dockerRunLayer.pipe(Layer.provide(child.layer), Layer.provide(mockProcessControl().layer)),
    Layer.succeed(NetworkIdFlag, Option.none()),
    // The remote-reset confirmation is answered through mockOutput's `promptConfirmResponses`
    // (the TTY/clack path); stdin is only required to satisfy the effect's service dependency.
    mockTty({ stdinIsTty: true }),
    mockStdin(true),
    // `loadProjectRef` gives an explicit `--project-ref` flag top precedence, mirrored here so a
    // test can prove the flag (not just `opts.ref`) drives the linked ref.
    Layer.succeed(ProjectRefResolver, {
      resolve: () => Effect.succeed(opts.ref ?? VALID_REF),
      resolveForLink: () => Effect.succeed(opts.ref ?? VALID_REF),
      resolveOptional: () => Effect.succeed(Option.some(opts.ref ?? VALID_REF)),
      loadProjectRef: (flagValue: Option.Option<string>) =>
        Option.isSome(flagValue) && flagValue.value.length > 0
          ? Effect.succeed(flagValue.value)
          : opts.linkedFails === true
            ? Effect.fail(new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }))
            : Effect.succeed(opts.ref ?? VALID_REF),
      promptProjectRef: () => Effect.succeed(opts.ref ?? VALID_REF),
    }),
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(platformApi.layer)),
    }),
    Layer.succeed(CliArgs, { args: opts.args ?? ["db", "reset", "--linked"] }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(DebugFlag, opts.debug ?? false),
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
  };
}

const migrationFile = (version: string, body = "create table t ();") => ({
  [`supabase/migrations/${version}_test.sql`]: body,
});

const PG14_TOML = 'project_id = "test"\n[db]\nmajor_version = 14\n';
const FAST_HEALTH_TOML = '[db]\nhealth_timeout = "1s"\n';

describe("db reset", () => {
  const tmp = useTempWorkdir("supabase-db-reset-");

  describe("local reset — PG15+", () => {
    it.live("recreates the container, waits healthy, and runs the setup pipeline", () => {
      const { layer, out, child, telemetry } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        // Confirms the single `Effect.ensuring` finalizer still fires exactly once.
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
          yield* dbReset({
            ...DEFAULT_FLAGS,
            local: true,
            version: Option.some("20240101000000"),
          }).pipe(Effect.provide(layer));
          expect(conn.execs.some((sql) => sql.includes("create table version_one_marker ()"))).toBe(
            true,
          );
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* dbReset({ ...DEFAULT_FLAGS, local: true, noSeed: true }).pipe(Effect.provide(layer));
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
        yield* dbReset({
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
          const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
          const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
        // No buckets configured, so the seed-buckets core short-circuits, but storage is still
        // inspected first.
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause) as { message: string; suggestion?: string };
          // Message text is an established output contract, not the raw exit code.
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
          yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
          // Restarting containers logs first, then a real `docker restart` of `db`, then the
          // satellite restarts + Kong reload.
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
        // Built as a migration file and run through a batch executor, so a failure gets the same
        // rich context (`At statement: <index>` + statement text) a real migration failure would.
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
          const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("failed to disconnect clients");
        }
      });
    });

    it.live("swallows a disconnect-clients failure that is not a PgError at all", () => {
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(
          conn.execs.some((sql) => sql === "CREATE DATABASE postgres WITH OWNER postgres"),
        ).toBe(true);
      });
    });

    it.live(
      "swallows a disconnect-clients failure carrying a node system errno, not a real SQLSTATE",
      () => {
        // `extractSqlState` returns any string `code` found in the cause chain, including a bare
        // node errno like `ECONNRESET` — not a real SQLSTATE. The discriminator must check
        // `isSqlState(code)` before comparing against `3D000`, not just `code !== undefined`.
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
          yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
          yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
          const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
        yield* dbReset({ ...DEFAULT_FLAGS, local: true, noSeed: true }).pipe(Effect.provide(layer));
        expect(conn.execs.some((sql) => sql.includes("insert into t values (9)"))).toBe(false);
      });
    });

    it.live("reapplies migrations and seeds after a default local reset (PG14)", () => {
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
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(conn.execs.some((sql) => sql.includes("create table pg14_marker ()"))).toBe(true);
        expect(
          conn.execs.some((sql) => sql.includes("insert into pg14_seed_marker values (1)")),
        ).toBe(true);
      });
    });

    it.live("installs pg_net before replay when Database Webhooks is enabled (PG14)", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: `${PG14_TOML}[experimental.webhooks]\nenabled = true\n`,
        files: migrationFile(
          "20240101000000",
          "select net.http_post(url := 'https://example.com');",
        ),
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        const pgNetIndex = conn.execs.findIndex((sql) =>
          sql.includes("create extension if not exists pg_net schema extensions"),
        );
        const migrationIndex = conn.execs.findIndex((sql) => sql.includes("https://example.com"));
        expect(pgNetIndex).toBeGreaterThanOrEqual(0);
        expect(migrationIndex).toBeGreaterThan(pgNetIndex);
        // The PG14 dump installs pg_net unconditionally, so it's dropped first and only
        // recreated because webhooks are enabled.
        const dropIndex = conn.execs.findIndex((sql) =>
          sql.includes("drop extension if exists pg_net"),
        );
        expect(dropIndex).toBeGreaterThanOrEqual(0);
        expect(pgNetIndex).toBeGreaterThan(dropIndex);
      });
    });

    it.live("drops the PG14 dump's implicit pg_net when Database Webhooks is disabled", () => {
      // Without this drop, a PG14 `db reset` would leave pg_net installed and diverge from
      // `supabase start`, surfacing as drift in the next engine's shadow baseline.
      const { layer, conn } = setup(tmp.current, {
        toml: PG14_TOML,
        args: ["db", "reset", "--local"],
        isLocal: true,
      });
      return Effect.gen(function* () {
        yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(conn.execs.some((sql) => sql.includes("drop extension if exists pg_net"))).toBe(
          true,
        );
        expect(
          conn.execs.some((sql) =>
            sql.includes("create extension if not exists pg_net schema extensions"),
          ),
        ).toBe(false);
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
          yield* dbReset({
            ...DEFAULT_FLAGS,
            local: true,
            version: Option.some("20240101000000"),
          }).pipe(Effect.provide(layer));
          expect(conn.execs.some((sql) => sql.includes("create table version_one_marker ()"))).toBe(
            true,
          );
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
          yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          // A fingerprint unique to `START_DB_GLOBALS_SQL` must never appear in this reset's execs.
          expect(conn.execs.some((sql) => sql.includes("CREATE ROLE anon"))).toBe(false);
        });
      },
    );

    it.live(
      "resolves db.migrations.schema_paths against supabase/ before applying it on an experimental PG14 reset",
      () => {
        // `recreateLocalDatabase14` must pass the normalized `toml.schemaPaths` (resolved by
        // `checkDbToml`) into the final `migrateAndSeed` call — the raw `["schema.sql"]` pattern
        // would glob-match against the workdir root instead of `supabase/schema.sql`.
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n[db]\nmajor_version = 14\n[db.migrations]\nschema_paths = ["schema.sql"]\n',
          files: { "supabase/schema.sql": "create table schema_paths_marker ();" },
          args: ["db", "reset", "--local"],
          isLocal: true,
          experimental: true,
        });
        return Effect.gen(function* () {
          yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      });
    });
  });

  describe("remote reset", () => {
    it.live("fails a remote reset on a malformed config.toml", () => {
      const { layer } = setup(tmp.current, { toml: 'project_id = "unterminated\n' });
      return Effect.gen(function* () {
        const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("failed to load config");
        }
      });
    });

    it.live("loads a Go-style env() boolean in config for a remote reset", () => {
      // Regression: `enabled = "env(VAR)"` must load via env-expansion + boolean
      // parsing (`checkDbToml`) instead of the strict @supabase/config
      // loader rejecting it.
      const previous = process.env["MIGRATIONS_ENABLED"];
      process.env["MIGRATIONS_ENABLED"] = "true";
      const { layer, out } = setup(tmp.current, {
        toml: 'project_id = "test"\n\n[db.migrations]\nenabled = "env(MIGRATIONS_ENABLED)"\n',
        files: migrationFile("20240101000000"),
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      });
    });

    it.live("rejects --version together with --last", () => {
      const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
      return Effect.gen(function* () {
        const exit = yield* dbReset({
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
        const exit = yield* dbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          version: Option.some("not-a-number"),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && failure.value._tag).toBe("DbResetInvalidVersionError");
          expect(Option.isSome(failure) && failure.value.message).toBe("invalid version number");
        }
      });
    });

    it.live("fails when --version has no matching migration file", () => {
      const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
      return Effect.gen(function* () {
        const exit = yield* dbReset({
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
      const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
      return Effect.gen(function* () {
        const exit = yield* dbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          version: Option.some("99999999999999999999"),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && failure.value._tag).toBe("DbResetInvalidVersionError");
          expect(Option.isSome(failure) && failure.value.message).toBe("invalid version number");
        }
      });
    });

    it.live("treats an empty --version like no version at all", () => {
      const { layer, out, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* dbReset({
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
        const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
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
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Resetting remote database...");
        expect(out.stderrText).not.toContain("Connecting to");
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
        expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
        expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
        expect(linkedCache.cached).toBe(true);
      });
    });

    it.live("fails a remote reset before dropping schemas on an undecryptable secret", () => {
      // Every secret is decrypted while loading config, before the reset runs, so an
      // undecryptable secret must abort before any destructive work.
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n\n[db.vault]\nmy_secret = "encrypted:anything"\n',
        confirm: [true],
      });
      return Effect.gen(function* () {
        const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain(
            "failed to parse config: missing private key",
          );
        }
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(false);
      });
    });

    it.live("fails a remote reset before dropping schemas on an empty project_id", () => {
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = ""\n',
        confirm: [true],
      });
      return Effect.gen(function* () {
        const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
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
      const { layer, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        files: { "supabase/.env": "SUPABASE_YES=true\n" },
        // No `confirm` responses: the prompt must auto-confirm.
      });
      return Effect.gen(function* () {
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
      });
    });

    it.live("still caches the linked ref when DB-config resolution fails", () => {
      const { layer, linkedCache } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        resolveFails: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(linkedCache.cached).toBe(true);
        expect(linkedCache.cachedRef).toBe(VALID_REF);
      });
    });

    it.live("resets the project given via --project-ref without a linked workdir", () => {
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, conn, linkedCache } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        confirm: [true],
        linkedFails: true,
      });
      return Effect.gen(function* () {
        yield* dbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          projectRef: Option.some(FLAG_REF),
        }).pipe(Effect.provide(layer));
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
        expect(linkedCache.cached).toBe(true);
        expect(linkedCache.cachedRef).toBe(FLAG_REF);
      });
    });

    it.live("--project-ref overrides an already-linked workdir's project ref", () => {
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, linkedCache } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        ref: VALID_REF,
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* dbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          projectRef: Option.some(FLAG_REF),
        }).pipe(Effect.provide(layer));
        expect(linkedCache.cached).toBe(true);
        expect(linkedCache.cachedRef).toBe(FLAG_REF);
        expect(linkedCache.cachedRef).not.toBe(VALID_REF);
      });
    });

    it.live("rejects --project-ref on the default local target", () => {
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, conn, resolver, linkedCache } = setup(tmp.current, {
        toml: 'project_id = "test"\n',
        args: ["db", "reset"],
      });
      return Effect.gen(function* () {
        const exit = yield* dbReset({
          ...DEFAULT_FLAGS,
          projectRef: Option.some(FLAG_REF),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain(
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
          );
        }
        expect(conn.execs).toEqual([]);
        expect(resolver.calls).toBe(0);
        expect(linkedCache.cached).toBe(false);
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
        yield* dbReset({
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
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true, last: Option.some(1) }).pipe(
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
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true, last: Option.some(2) }).pipe(
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
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true, noSeed: true }).pipe(
          Effect.provide(layer),
        );
        expect(out.stderrText).not.toContain("Seeding data from");
      });
    });

    it.live(
      "applies configured schema files instead of replaying migrations on an experimental remote reset",
      () => {
        // `--linked=false` still selects the linked/remote target, exercised here alongside the
        // schema-files branch itself.
        const { layer, out, conn, resolver, linkedCache } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n\n[experimental.pgdelta]\nenabled = false\n',
          files: {
            "supabase/schemas/01_users.sql": "create table schema_users ();",
            ...migrationFile("20240101000000", "create table migrated_table ();"),
            "supabase/seed.sql": "insert into t values (1);",
          },
          experimental: true,
          args: ["db", "reset", "--linked=false"],
          confirm: [true],
          ref: VALID_REF,
        });
        return Effect.gen(function* () {
          yield* dbReset({ ...DEFAULT_FLAGS, linked: false }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table migrated_table"))).toBe(false);
          expect(out.stderrText).not.toContain("Applying migration");
          expect(out.stderrText).toContain("Seeding data from supabase/seed.sql...");
          expect(resolver.calls).toBe(1);
          expect(linkedCache.cached).toBe(true);
          expect(linkedCache.cachedRef).toBe(VALID_REF);
        });
      },
    );

    it.live(
      "applies schema files across multiple schema_paths patterns in declaration order, sorted within each pattern",
      () => {
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
          yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
          yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table dir_top"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table dir_nested"))).toBe(true);
        });
      },
    );

    it.live(
      "silently applies nothing when schema_paths is unset on an experimental remote reset (Go's undocumented default-config behavior)",
      () => {
        const { layer, out, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n',
          files: migrationFile("20240101000000", "create table migrated_table ();"),
          experimental: true,
          confirm: [true],
        });
        return Effect.gen(function* () {
          yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
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
          yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
          yield* dbReset({
            ...DEFAULT_FLAGS,
            linked: true,
            version: Option.some("20240101000000"),
          }).pipe(Effect.provide(layer));
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
          const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("no files matched pattern: supabase/nomatch/*.sql");
            expect(cause).not.toContain("See schema file");
          }
          expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
        });
      },
    );

    it.live("ignores a partial schema_paths glob failure once at least one pattern matches", () => {
      const { layer, out, conn } = setup(tmp.current, {
        toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql", "typo/*.sql"]\n',
        files: {
          "supabase/schemas/01_users.sql": "create table schema_users ();",
          // Present so the seed glob's own "no files matched" warning doesn't show up here too.
          "supabase/seed.sql": "insert into t values (1);",
        },
        experimental: true,
        confirm: [true],
      });
      return Effect.gen(function* () {
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
          const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("syntax error at or near");
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
        const schemaFile = join(tmp.current, "supabase", "schemas", "01_users.sql");
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas/*.sql"]\n',
          files: { "supabase/schemas/01_users.sql": "create table schema_users ();" },
          experimental: true,
          confirm: [true],
        });
        chmodSync(schemaFile, 0o000);
        return Effect.gen(function* () {
          const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).not.toContain("See schema file");
          }
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(false);
        }).pipe(Effect.ensuring(Effect.sync(() => chmodSync(schemaFile, 0o644))));
      },
    );

    it.live.skipIf(isRoot)(
      "fails an experimental remote reset (without silently succeeding) when a matched schema_paths directory cannot be walked",
      () => {
        const schemasDir = join(tmp.current, "supabase", "schemas");
        const { layer, conn } = setup(tmp.current, {
          toml: 'project_id = "test"\n\n[db.migrations]\nschema_paths = ["schemas"]\n',
          files: { "supabase/schemas/01_users.sql": "create table schema_users ();" },
          experimental: true,
          confirm: [true],
        });
        chmodSync(schemasDir, 0o000);
        return Effect.gen(function* () {
          const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const cause = JSON.stringify(exit.cause);
            expect(cause).toContain("failed to walk matched directory");
            expect(cause).not.toContain("See schema file");
          }
          expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(false);
        }).pipe(Effect.ensuring(Effect.sync(() => chmodSync(schemasDir, 0o755))));
      },
    );

    it.live(
      "takes the native experimental schema-files path via SUPABASE_EXPERIMENTAL in the project .env",
      () => {
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
          yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
        const exit = yield* dbReset({
          ...DEFAULT_FLAGS,
          noSeed: true,
          sqlPaths: ["seed.sql"],
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("--no-seed cannot be used with --sql-paths");
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
          yield* dbReset({
            ...DEFAULT_FLAGS,
            dbUrl: Option.some("postgresql://db.example.com:5432/postgres"),
            noSeed: true,
          }).pipe(Effect.provide(layer));
          expect(conn.execs.some((s) => s.includes("create table schema_users"))).toBe(true);
          expect(conn.execs.some((s) => s.includes("insert into"))).toBe(false);
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
        yield* dbReset({
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
        yield* dbReset({
          ...DEFAULT_FLAGS,
          dbUrl: Option.some("postgresql://db.example.com:5432/postgres"),
        }).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Resetting remote database...");
        expect(conn.execs.some((s) => s.includes("drop schema if exists"))).toBe(true);
      });
    });

    it.live("announces a matching [remotes.*] override", () => {
      const { layer, out } = setup(tmp.current, {
        toml: `project_id = "base"\n\n[remotes.preview]\nproject_id = "${VALID_REF}"\n`,
        confirm: [true],
        ref: VALID_REF,
      });
      return Effect.gen(function* () {
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
        yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(Effect.provide(layer));
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
        // json mode's default-false prompt has no confirm response, so it declines and cancels.
        const exit = yield* dbReset({ ...DEFAULT_FLAGS, linked: true }).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(out).toBeDefined();
      });
    });

    it.live("rejects --no-seed together with --sql-paths", () => {
      const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n' });
      return Effect.gen(function* () {
        const exit = yield* dbReset({
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
        const exit = yield* dbReset({
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
        const exit = yield* dbReset({
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
        yield* dbReset({
          ...DEFAULT_FLAGS,
          linked: true,
          sqlPaths: [absSeed],
        }).pipe(Effect.provide(layer));
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
        yield* dbReset({
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
          yield* dbReset({
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
