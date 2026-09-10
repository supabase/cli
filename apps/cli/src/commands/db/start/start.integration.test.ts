import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { vi } from "vitest";

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
} from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
} from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection, type DbSession } from "../../../command-internal/db-connection.service.ts";
import { dockerRunLayer } from "../../../command-internal/docker-run.layer.ts";
import { dbStart } from "./start.handler.ts";
import type { DbStartFlags } from "./start.command.ts";

const DEFAULT_FLAGS: DbStartFlags = { fromBackup: Option.none() };
const PG_NET_CREATE_FINGERPRINT = "create extension if not exists pg_net schema extensions";
const PG_NET_DROP_FINGERPRINT = "drop extension if exists pg_net";
const GLOBALS_FINGERPRINT = "CREATE ROLE anon";

function flags(fromBackup?: string): DbStartFlags {
  return { fromBackup: fromBackup === undefined ? Option.none() : Option.some(fromBackup) };
}

interface SpawnRecord {
  readonly args: ReadonlyArray<string>;
}

type RouteResult = {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
};

/** A single-container version of `start.integration.test.ts`'s `mockStartContainerCliSpawner`. */
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

const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';
const STARTING_STATE = '{"Running":true,"Status":"running","Health":{"Status":"starting"}}';

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

/** The single `docker create` call for the `db` container, if one happened. */
function createArgs(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> | undefined {
  return spawned.find((s) => s.args[0] === "create")?.args;
}

/** Every `-v <bind>` value passed to `docker create`. */
function bindsFromCreateArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const binds: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v") binds.push(args[i + 1] ?? "");
  }
  return binds;
}

/** The three PG15+ one-shot migrate jobs (`startSetupLocalDatabase`'s `DockerRun` calls). */
function dbSetupJobCalls(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> {
  return spawned.filter((s) => s.args[0] === "run" && s.args[1] === "--rm");
}

function rollbackWasAttempted(spawned: ReadonlyArray<SpawnRecord>): boolean {
  return spawned.some((s) => s.args[0] === "container" && s.args[1] === "prune");
}

function volumePruneWasAttempted(spawned: ReadonlyArray<SpawnRecord>): boolean {
  return spawned.some((s) => s.args[0] === "volume" && s.args[1] === "prune");
}

/** Stateful default route: only created containers inspect successfully, matching Docker across initial state detection and post-create health waits. Existing volume by default (a restart). */
function defaultRoute(opts: { readonly neverHealthy?: boolean } = {}) {
  const created = new Set<string>();
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0 };
    if (args[0] === "network" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "network" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "inspect") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "context" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "create") {
      const name = containerNameFromCreateArgs(args);
      created.add(name);
      return { stdout: [fakeContainerId(name)] };
    }
    if (args[0] === "start") return { exitCode: 0 };
    if (args[0] === "container" && args[1] === "inspect") {
      const id = args[2] ?? "";
      if (!created.has(id)) {
        return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
      }
      if (opts.neverHealthy === true) return { stdout: [STARTING_STATE] };
      return { stdout: [HEALTHY_STATE] };
    }
    if (args[0] === "logs") return { exitCode: 0 };
    if (args[0] === "ps") return { stdout: [] };
    return { exitCode: 0 };
  };
}

/** Overrides the default route's "volume already exists" answer to simulate a brand-new Postgres volume. */
function freshVolumeRoute(
  base: (args: ReadonlyArray<string>) => RouteResult,
): (args: ReadonlyArray<string>) => RouteResult {
  return (args) => {
    if (args[0] === "volume" && args[1] === "inspect") {
      return { exitCode: 1, stderr: [`Error: No such volume: ${args[2] ?? ""}`] };
    }
    return base(args);
  };
}

/**
 * Makes `isLocalDbRunning`'s pre-bring-up `container inspect` succeed unconditionally,
 * simulating an already-up local db — the already-running short-circuit returns before any
 * other `container inspect` call happens.
 */
function alreadyRunningRoute(
  base: (args: ReadonlyArray<string>) => RouteResult,
): (args: ReadonlyArray<string>) => RouteResult {
  return (args) => {
    if (args[0] === "container" && args[1] === "inspect") return { stdout: [HEALTHY_STATE] };
    return base(args);
  };
}

/**
 * Makes `isLocalDbRunning`'s pre-bring-up `container inspect` fail for a reason other than
 * "no such container" — simulates an unreachable Docker daemon during the running-check, which
 * is propagated rather than treated as "not running".
 */
function runningCheckFailsRoute(
  base: (args: ReadonlyArray<string>) => RouteResult,
): (args: ReadonlyArray<string>) => RouteResult {
  return (args) => {
    if (args[0] === "container" && args[1] === "inspect") {
      return { exitCode: 1, stderr: ["Error: cannot connect to the Docker daemon"] };
    }
    return base(args);
  };
}

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/** PG15+ (this suite's default) never calls `exec`/`query` directly — its schema init is three one-shot `DockerRun` jobs instead. */
function fakeDbSession() {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: DbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "exec", sql });
      }),
    query: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "query", sql });
        return [];
      }),
    execBatch: (statements) => sequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

const tempRoot = useTempWorkdir("supabase-db-start-int-");

function writeConfig(workdir: string, contents: string) {
  mkdirSync(join(workdir, "supabase"), { recursive: true });
  writeFileSync(join(workdir, "supabase", "config.toml"), contents);
}

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly route?: (args: ReadonlyArray<string>) => RouteResult;
  readonly running?: boolean;
  readonly runningFails?: boolean;
  readonly configContents?: string;
  readonly projectEnvContents?: string;
  readonly skipConfig?: boolean;
  readonly workdir?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly networkId?: string;
  /** `--experimental`/`SUPABASE_EXPERIMENTAL`. Defaults to `false`. */
  readonly experimental?: boolean;
  /** `--debug`. Defaults to `false`. */
  readonly debug?: boolean;
  /** Number of initial `DbConnection.connect` attempts that fail before succeeding. */
  readonly connectFailures?: number;
  /** Whether the mocked connect failures are dial-level (`retryable`). Defaults to `true`. */
  readonly connectFailuresRetryable?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const workdir = opts.workdir ?? tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(workdir, opts.configContents ?? 'project_id = "test"\n');
    if (opts.projectEnvContents !== undefined) {
      writeFileSync(join(workdir, "supabase", ".env"), opts.projectEnvContents);
    }
  }
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cliSettings = mockCommandSettings({ workdir });
  const baseRoute = opts.route ?? defaultRoute();
  const route =
    opts.running === true
      ? alreadyRunningRoute(baseRoute)
      : opts.runningFails === true
        ? runningCheckFailsRoute(baseRoute)
        : baseRoute;
  const child = mockContainerCliSpawner(route);
  const dbSession = fakeDbSession();

  let connectAttempts = 0;
  const connectFailures = opts.connectFailures ?? 0;
  const dbConnection = Layer.succeed(DbConnection, {
    connect: () =>
      Effect.suspend(() => {
        connectAttempts += 1;
        if (connectAttempts <= connectFailures) {
          return Effect.fail(
            new DbConnectError({
              message:
                "failed to connect to postgres: failed to connect to `host=127.0.0.1 user=postgres database=postgres`: connect ECONNREFUSED 127.0.0.1:54322",
              ...(opts.connectFailuresRetryable === false ? {} : { retryable: true }),
            }),
          );
        }
        return Effect.succeed(dbSession.session);
      }),
  });

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliSettings,
    telemetry.layer,
    child.layer,
    alwaysReadyHttpClientLayer,
    dbConnection,
    dockerRunLayer.pipe(Layer.provide(child.layer), Layer.provide(mockProcessControl().layer)),
    mockProcessControl().layer,
    mockRuntimeInfo({ platform: opts.platform ?? "linux", cwd: opts.cwd ?? workdir }),
    Layer.succeed(
      NetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(CliArgs, { args: ["db", "start"] }),
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(DebugFlag, opts.debug ?? false),
  );
  return {
    layer,
    out,
    telemetry,
    child,
    dbSession,
    get connectAttempts() {
      return connectAttempts;
    },
  };
}

const currentBranchPath = (workdir: string) =>
  join(workdir, "supabase", ".branches", "_current_branch");

describe("db start", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
  });
  afterEach(() => {
    delete process.env["SUPABASE_NETWORK_ID"];
    vi.unstubAllEnvs();
  });

  it.live("reports an already-running database without starting a container", () => {
    const { layer, out, telemetry, child } = setup({ running: true });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Postgres database is already running.");
      expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      expect(telemetry.flushed).toBe(true);
      expect(existsSync(currentBranchPath(tempRoot.current))).toBe(false);
    });
  });

  it.live(
    "starts the database on a fresh volume: creates the container, runs the SetupLocalDatabase-equivalent pipeline, and writes _current_branch",
    () => {
      const { layer, out, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Starting database...\n");
        expect(out.stderrText).not.toContain("Starting database from backup...");
        expect(createArgs(child.spawned)).not.toBeUndefined();
        expect(out.stderrText).toContain("Initialising schema...");
        // Default config: realtime, storage, and auth are all enabled (PG >= 15 default).
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(3);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
        expect(out.stderrText).not.toContain("Finished");
      });
    },
  );

  it.live(
    "fresh volume: retries the host connect while the published port is not yet reachable (#6136)",
    () => {
      const s = setup({ route: freshVolumeRoute(defaultRoute()), connectFailures: 2 });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(s.layer));
        expect(s.connectAttempts).toBe(3);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
    15_000,
  );

  it.live("fresh volume: a non-dial connect failure is not retried", () => {
    const s = setup({
      route: freshVolumeRoute(defaultRoute()),
      connectFailures: 1,
      connectFailuresRetryable: false,
    });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(s.layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(s.connectAttempts).toBe(1);
    });
  });

  it.live(
    "PG <= 14 on a fresh volume: execs schema/globals SQL directly instead of the PG15+ one-shot migrate jobs",
    () => {
      const { layer, out, child, dbSession } = setup({
        configContents: 'project_id = "test"\n[db]\nmajor_version = 14\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Initialising schema...");
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
        expect(dbSession.calls.length).toBeGreaterThan(0);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live(
    "a fresh volume with realtime disabled skips the realtime migrate job AND never attempts JWKS resolution",
    () => {
      // globalThis.fetch is stubbed to fail so any JWKS resolution attempt would blow up the
      // test.
      const previousFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(() => Promise.reject(new Error("ECONNREFUSED")), {
        preconnect: previousFetch.preconnect,
      });
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[realtime]\nenabled = false\n[auth.third_party.firebase]\nenabled = true\nproject_id = "fb-project"\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        // Default config: storage and auth stay enabled — only the realtime job is skipped.
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(2);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
          }),
        ),
      );
    },
  );

  it.live(
    "a fresh volume with realtime enabled fails with a typed error when JWKS resolution fails",
    () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(() => Promise.reject(new Error("ECONNREFUSED")), {
        preconnect: previousFetch.preconnect,
      });
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth.third_party.firebase]\nenabled = true\nproject_id = "fb-project"\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
        }
        // The container is already created/healthy by the time JWKS resolution runs, so the
        // rollback still tears it down.
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
          }),
        ),
      );
    },
  );

  it.live(
    "restarts against an existing volume: skips the SetupLocalDatabase-equivalent pipeline but still writes _current_branch",
    () => {
      const { layer, out, child, dbSession } = setup();
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Starting database from backup...\n");
        expect(out.stderrText).not.toContain("Initialising schema...");
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
        // The only SQL on this path is the Webhooks convergence, which finds no migration
        // owning pg_net (webhooks disabled) and drops it.
        expect(dbSession.calls.some((call) => call.sql.includes(PG_NET_CREATE_FINGERPRINT))).toBe(
          false,
        );
        expect(dbSession.calls.some((call) => call.sql.includes(GLOBALS_FINGERPRINT))).toBe(false);
        expect(dbSession.calls.some((call) => call.sql.includes(PG_NET_DROP_FINGERPRINT))).toBe(
          true,
        );
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live("installs pg_net on an existing volume from effective Webhooks config", () => {
    const { layer, out, child, dbSession } = setup({
      configContents: 'project_id = "test"\n[experimental.webhooks]\nenabled = false\n',
      projectEnvContents: "SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED=true\n",
    });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Initialising schema...");
      expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
      expect(
        dbSession.calls.filter(
          (call) => call.kind === "exec" && call.sql.includes(PG_NET_CREATE_FINGERPRINT),
        ),
      ).toHaveLength(1);
    });
  });

  it.live(
    "--from-backup on a fresh volume: uses the restore entrypoint, binds the backup file, and skips the SetupLocalDatabase-equivalent pipeline entirely",
    () => {
      const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      return Effect.gen(function* () {
        yield* dbStart(flags("/abs/host/backup.sql")).pipe(Effect.provide(layer));
        const args = createArgs(child.spawned);
        expect(args).not.toBeUndefined();
        const script = args?.[(args?.indexOf("-c") ?? -1) + 1];
        expect(script).toContain("/docker-entrypoint-initdb.d/migrate.sh");
        expect(bindsFromCreateArgs(args ?? [])).toContain(
          "/abs/host/backup.sql:/etc/backup.sql:ro",
        );
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live(
    '--from-backup against an existing volume fails with "backup volume already exists" and rolls back without creating a container',
    () => {
      const { layer, child } = setup();
      return Effect.gen(function* () {
        const exit = yield* dbStart(flags("/abs/host/backup.sql")).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toMatchObject({
            _tag: "StartBackupVolumeExistsError",
            message: "backup volume already exists",
          });
          expect((error as { suggestion?: string }).suggestion).toContain(
            "supabase stop --no-backup",
          );
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        // The volume this guard detected must never be pruned, even though the rollback still
        // removes everything else on failure.
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
        expect(volumePruneWasAttempted(child.spawned)).toBe(false);
      });
    },
  );

  it.live("resolves a relative --from-backup against the caller cwd, not the workdir", () => {
    const { layer, child } = setup({
      route: freshVolumeRoute(defaultRoute()),
      cwd: "/caller/here",
    });
    return Effect.gen(function* () {
      yield* dbStart(flags("dump.sql")).pipe(Effect.provide(layer));
      const args = createArgs(child.spawned);
      expect(bindsFromCreateArgs(args ?? [])).toContain("/caller/here/dump.sql:/etc/backup.sql:ro");
    });
  });

  it.live("treats an empty --from-backup as a normal no-backup start", () => {
    const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* dbStart(flags("")).pipe(Effect.provide(layer));
      const args = createArgs(child.spawned);
      expect(bindsFromCreateArgs(args ?? []).some((b) => b.endsWith(":/etc/backup.sql:ro"))).toBe(
        false,
      );
    });
  });

  it.live("a health-check timeout without --from-backup fails the command and rolls back", () => {
    // `db.health_timeout` (unlike the generic 30s `serviceTimeout` every other service waits on)
    // is a real config.toml-configurable seam — this keeps the scenario fast instead of waiting
    // out the real 2m default.
    const { layer, child } = setup({
      configContents: 'project_id = "test"\n[db]\nhealth_timeout = "1s"\n',
      route: freshVolumeRoute(defaultRoute({ neverHealthy: true })),
    });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(rollbackWasAttempted(child.spawned)).toBe(true);
      // This run's fresh volume means the rollback prunes it too — the "backup volume already
      // exists" test above covers the non-pruning case.
      expect(volumePruneWasAttempted(child.spawned)).toBe(true);
      expect(existsSync(currentBranchPath(tempRoot.current))).toBe(false);
    });
  });

  it.live(
    "honors a SUPABASE_DEBUG set only in the project .env: the rollback's Pruned reports fire without --debug",
    () => {
      // A shell SUPABASE_DEBUG (even "false") would suppress the project .env value, so clear
      // it first.
      const previous = process.env["SUPABASE_DEBUG"];
      delete process.env["SUPABASE_DEBUG"];
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db]\nhealth_timeout = "1s"\n',
        route: freshVolumeRoute(defaultRoute({ neverHealthy: true })),
      });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), "SUPABASE_DEBUG=true\n");
      // This log write goes straight to the real process stderr, never the mocked Output
      // service, so intercept it directly.
      const writes: Array<string> = [];
      const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
      globalThis.process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof globalThis.process.stderr.write;
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
        expect(writes.some((chunk) => chunk.includes("Pruned containers:"))).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.process.stderr.write = originalWrite;
            if (previous === undefined) delete process.env["SUPABASE_DEBUG"];
            else process.env["SUPABASE_DEBUG"] = previous;
          }),
        ),
      );
    },
  );

  it.live(
    "a health-check timeout WITH --from-backup is swallowed: the command still succeeds and writes _current_branch",
    () => {
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db]\nhealth_timeout = "1s"\n',
        route: freshVolumeRoute(defaultRoute({ neverHealthy: true })),
      });
      return Effect.gen(function* () {
        // The stderr log dump on timeout is covered by the shared health-check.ts suite; this
        // test only asserts the outcome specific to `--from-backup`.
        yield* dbStart(flags("/abs/host/backup.sql")).pipe(Effect.provide(layer));
        expect(rollbackWasAttempted(child.spawned)).toBe(false);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live("proceeds with no config file (missing config is tolerated)", () => {
    const { layer, child } = setup({ skipConfig: true, route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(createArgs(child.spawned)).not.toBeUndefined();
    });
  });

  it.live(
    "fails with a typed error on a malformed supabase/.env file, before any container is created",
    () => {
      const { layer, child } = setup({});
      writeFileSync(join(tempRoot.current, "supabase", ".env"), "not a valid env line at all\n");
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live("fails fast on a malformed config.toml", () => {
    const { layer, child, telemetry } = setup({ configContents: 'project_id = "unterminated\n' });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to load config");
      }
      expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("fails fast on an undecryptable secret even when the db is already running", () => {
    const { layer, out } = setup({
      configContents: '[db]\nroot_key = "encrypted:anything"\n',
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to parse config: missing private key");
      }
      expect(out.stderrText).not.toContain("already running");
    });
  });

  it.live(
    "--network-id forces the created network/container onto the override, not the generated network name",
    () => {
      const { layer, child } = setup({
        route: freshVolumeRoute(defaultRoute()),
        networkId: "custom-network",
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(
          child.spawned.some((s) => s.args[0] === "network" && s.args.at(-1) === "custom-network"),
        ).toBe(true);
        const args = createArgs(child.spawned);
        const networkIndex = args?.indexOf("--network") ?? -1;
        expect(args?.[networkIndex + 1]).toBe("custom-network");
      });
    },
  );

  it.live("falls back to SUPABASE_NETWORK_ID when --network-id is omitted", () => {
    process.env["SUPABASE_NETWORK_ID"] = "env-network";
    const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(
        child.spawned.some((s) => s.args[0] === "network" && s.args.at(-1) === "env-network"),
      ).toBe(true);
      const args = createArgs(child.spawned);
      const networkIndex = args?.indexOf("--network") ?? -1;
      expect(args?.[networkIndex + 1]).toBe("env-network");
    });
  });

  it.live(
    "an explicitly empty --network-id falls back to the generated network name, not a literal empty override",
    () => {
      const { layer, child } = setup({
        route: freshVolumeRoute(defaultRoute()),
        networkId: "",
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(
          child.spawned.some(
            (s) => s.args[0] === "network" && s.args.at(-1) === "supabase_network_test",
          ),
        ).toBe(true);
        const args = createArgs(child.spawned);
        const networkIndex = args?.indexOf("--network") ?? -1;
        expect(args?.[networkIndex + 1]).toBe("supabase_network_test");
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_DB_HEALTH_TIMEOUT, before any container is created",
    () => {
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db]\nhealth_timeout = "not-a-duration"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Config loading decodes every duration field unconditionally for every command, including
  // `db start`, even though it never starts GoTrue itself.
  it.live.each([
    ["auth.email.max_frequency", '[auth.email]\nmax_frequency = "not-a-duration"\n'],
    ["auth.sms.max_frequency", '[auth.sms]\nmax_frequency = "not-a-duration"\n'],
    ["auth.sessions.timebox", '[auth.sessions]\ntimebox = "not-a-duration"\n'],
    [
      "auth.sessions.inactivity_timeout",
      '[auth.sessions]\ninactivity_timeout = "not-a-duration"\n',
    ],
    ["auth.mfa.phone.max_frequency", '[auth.mfa.phone]\nmax_frequency = "not-a-duration"\n'],
  ] as const)(
    "fails with a typed config error on a malformed %s, before any container is created",
    ([dottedFieldPath, tomlFragment]) => {
      const { layer, child } = setup({
        configContents: `project_id = "test"\n${tomlFragment}`,
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT override, before any container is created",
    () => {
      // auth.rate_limit has no enabled-gated validation — it's decoded unconditionally
      // regardless of auth.enabled or whether db start reads the field.
      const { layer, child } = setup({});
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("auth.rate_limit");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Config loading decodes the entire config struct unconditionally in one pass, including
  // every field below, regardless of whether `db start` itself reads it.
  it.live.each([
    ["edge_runtime.inspector_port", "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT", "not-a-port"],
    ["edge_runtime.policy", "SUPABASE_EDGE_RUNTIME_POLICY", "not-a-policy"],
    ["api.max_rows", "SUPABASE_API_MAX_ROWS", "not-a-uint"],
    ["storage.analytics.max_namespaces", "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES", "not-a-uint"],
    ["local_smtp.port", "SUPABASE_LOCAL_SMTP_PORT", "not-a-port"],
    ["analytics.port", "SUPABASE_ANALYTICS_PORT", "not-a-port"],
    ["db.pooler.pool_mode", "SUPABASE_DB_POOLER_POOL_MODE", "not-a-mode"],
    ["db.pooler.enabled", "SUPABASE_DB_POOLER_ENABLED", "not-a-bool"],
    ["auth.web3", "SUPABASE_AUTH_WEB3_SOLANA_ENABLED", "not-a-bool"],
    ["auth.oauth_server", "SUPABASE_AUTH_OAUTH_SERVER_ENABLED", "not-a-bool"],
    ["auth.third_party", "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED", "not-a-bool"],
    ["api.enabled", "SUPABASE_API_ENABLED", "not-a-bool"],
    ["storage.vector.enabled", "SUPABASE_STORAGE_VECTOR_ENABLED", "not-a-bool"],
  ] as const)(
    "fails with a typed config error on a malformed %s override, before any container is created",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({});
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live.each([
    ["realtime.ip_version", "SUPABASE_REALTIME_IP_VERSION", "IPv5"],
    ["realtime.max_header_length", "SUPABASE_REALTIME_MAX_HEADER_LENGTH", "not-a-uint"],
  ] as const)(
    "fails with a typed config error on a malformed %s override even when Postgres is already running",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live.each([
    ["db.settings.max_connections", "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "bogus"],
    ["db.settings.track_commit_timestamp", "SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP", "bogus"],
  ] as const)(
    "fails with a typed config error on a malformed %s override even when Postgres is already running",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_STORAGE_ENABLED override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STORAGE_ENABLED=not-a-bool\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("storage.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live.each([
    ["edge_runtime.enabled", "SUPABASE_EDGE_RUNTIME_ENABLED", "not-a-bool"],
    ["db.network_restrictions.enabled", "SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED", "not-a-bool"],
    ["studio.enabled", "SUPABASE_STUDIO_ENABLED", "not-a-bool"],
    ["local_smtp.enabled", "SUPABASE_LOCAL_SMTP_ENABLED", "not-a-bool"],
  ] as const)(
    "fails with a typed config error on a malformed %s override even when Postgres is already running",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_STUDIO_API_URL override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STUDIO_API_URL=http://[::1\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("Invalid config for studio.api_url");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error when local_smtp is enabled with a zero port even when Postgres is already running",
    () => {
      const { layer, child } = setup({
        running: true,
        configContents: 'project_id = "test"\n[local_smtp]\nenabled = true\nport = 0\n',
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("Missing required field in config: local_smtp.port");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_AUTH_JWT_EXPIRY override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_JWT_EXPIRY=not-a-uint\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("auth.jwt_expiry");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_API_PORT override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), "SUPABASE_API_PORT=not-a-port\n");
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("api.port");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live.each([
    ["auth.enable_signup", "SUPABASE_AUTH_ENABLE_SIGNUP", "not-a-bool"],
    ["auth.enable_anonymous_sign_ins", "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS", "not-a-bool"],
    [
      "auth.enable_refresh_token_rotation",
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      "not-a-bool",
    ],
    [
      "auth.refresh_token_reuse_interval",
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      "not-a-uint",
    ],
    ["auth.enable_manual_linking", "SUPABASE_AUTH_ENABLE_MANUAL_LINKING", "not-a-bool"],
    ["auth.minimum_password_length", "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH", "not-a-uint"],
    ["auth.password_requirements", "SUPABASE_AUTH_PASSWORD_REQUIREMENTS", "not-a-requirement"],
  ] as const)(
    "fails with a typed config error on a malformed %s override even when Postgres is already running",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on an invalid auth.passkey.enabled even when auth is disabled, matching Go's Config.Load",
    () => {
      // auth.passkey has no @supabase/config schema, so the malformed value must live in
      // config.toml directly — an env override would never reach the raw-document read that
      // decodes it.
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.passkey]\nenabled = "bad"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("auth.passkey");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on an invalid auth.external.<custom>.enabled even when auth is disabled, matching Go's Config.Load",
    () => {
      // auth.external is a dynamic provider map; an unmodeled key like "custom" is silently
      // dropped by @supabase/config's schema, so the malformed value must live in config.toml
      // directly.
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.external.custom]\nenabled = "bad"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("auth.external");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED override, matching Go's Config.Load",
    () => {
      // The [auth.hook.send_email] section must be present for the env override to reach the
      // decode — an absent section decodes a schema default that erases the presence signal
      // the override needs.
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[auth.hook.send_email]\nenabled = false\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("auth.hook");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_AUTH_EMAIL_SMTP_PORT override even when auth is disabled, matching Go's Config.Load",
    () => {
      // [auth.email.smtp] must be present in config.toml for the env override to reach the
      // decode.
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.email.smtp]\nhost = "smtp.example.com"\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_EMAIL_SMTP_PORT=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("auth.email.smtp");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "ignores SUPABASE_AUTH_EMAIL_SMTP_PORT when [auth.email.smtp] is absent from config.toml",
    () => {
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[auth]\nenabled = false\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_EMAIL_SMTP_PORT=bogus\n",
      );
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(createArgs(child.spawned)).not.toBeUndefined();
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED override, matching Go's Config.Load",
    () => {
      // [storage.image_transformation] must be present in config.toml for the env override to
      // reach the decode.
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[storage.image_transformation]\nenabled = true\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("storage.image_transformation.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "ignores SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED when [storage.image_transformation] is absent from config.toml",
    () => {
      const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(createArgs(child.spawned)).not.toBeUndefined();
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_DB_SSL_ENFORCEMENT_ENABLED override, matching Go's Config.Load",
    () => {
      // [db.ssl_enforcement] must be present in config.toml for the env override to reach the
      // decode (a presence-gated pointer field, unlike the plain-bool db.network_restrictions.enabled).
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db.ssl_enforcement]\nenabled = true\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("db.ssl_enforcement.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_DB_SSL_ENFORCEMENT_ENABLED override even when Postgres is already running",
    () => {
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db.ssl_enforcement]\nenabled = true\n',
        running: true,
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain("db.ssl_enforcement.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "ignores SUPABASE_DB_SSL_ENFORCEMENT_ENABLED when [db.ssl_enforcement] is absent from config.toml",
    () => {
      const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(createArgs(child.spawned)).not.toBeUndefined();
      });
    },
  );

  it.live(
    "fails with a typed config error when [experimental.webhooks] is present without enabled = true, even when Postgres is already running",
    () => {
      // Experimental validation rejects any present [experimental.webhooks] section whose
      // enabled isn't explicitly true, unconditionally before the already-running check.
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[experimental.webhooks]\nenabled = false\n',
        running: true,
      });
      return Effect.gen(function* () {
        const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("DbConfigLoadError");
          expect(message).toContain(
            "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
          );
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live("starts normally when [experimental.webhooks] is absent from config.toml", () => {
    const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(createArgs(child.spawned)).not.toBeUndefined();
    });
  });

  it.live(
    "never mentions api.auto_expose_new_tables on stderr, whatever the flag is set to",
    () => {
      // Each case's config.toml is written just before its own run — writing all three up
      // front would let the last write clobber the earlier ones in the shared temp workdir.
      const configContentsCases = [
        'project_id = "test"\n[api]\nauto_expose_new_tables = true\n',
        'project_id = "test"\n[api]\nauto_expose_new_tables = false\n',
        undefined,
      ];
      return Effect.gen(function* () {
        for (const configContents of configContentsCases) {
          const { layer, out } = setup({ configContents, route: freshVolumeRoute(defaultRoute()) });
          const onDiskConfig = readFileSync(
            join(tempRoot.current, "supabase", "config.toml"),
            "utf8",
          );
          expect(onDiskConfig).toBe(configContents ?? 'project_id = "test"\n');
          yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
          expect(out.stderrText).not.toContain("auto_expose_new_tables");
        }
      });
    },
  );

  it.live(
    "prints @supabase/config's deprecated-[inbucket]-section WARN only once on a fresh, not-already-running start",
    () => {
      // The deprecation WARN is Console.error-pinned to the real console, not this file's
      // Output service, so it must be observed with a raw console.error spy, like
      // stop/status's identical tests.
      const { layer } = setup({
        configContents: 'project_id = "test"\n[inbucket]\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      const warnings: Array<string> = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        const inbucketWarnings = warnings.filter((m) =>
          m.includes(
            "WARN: config section [inbucket] is deprecated. Please use [local_smtp] instead.",
          ),
        );
        expect(inbucketWarnings).toHaveLength(1);
      }).pipe(Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())));
    },
  );

  it.live("fails on a malformed auth duration field even when the db is already running", () => {
    const { layer, out } = setup({
      configContents: 'project_id = "test"\n[auth.email]\nmax_frequency = "not-a-duration"\n',
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const message = JSON.stringify(exit.cause);
        expect(message).toContain("DbConfigLoadError");
        expect(message).toContain("auth.email.max_frequency");
      }
      expect(out.stderrText).not.toContain("already running");
    });
  });

  it.live(
    "warns when auth.sms.enable_signup is true but no SMS provider is enabled, matching Go's (s *sms) validate()",
    () => {
      const { layer, out } = setup({
        configContents: 'project_id = "test"\n[auth.sms]\nenable_signup = true\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("WARN: no SMS provider is enabled. Disabling phone login");
      });
    },
  );

  it.live(
    "does not warn about SMS when auth is disabled, matching Go's Enabled-gated (s *sms) validate()",
    () => {
      const { layer, out } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.sms]\nenable_signup = true\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).not.toContain("no SMS provider is enabled");
      });
    },
  );

  it.live(
    "does not add the Linux-only host.docker.internal extra host on a non-Linux platform",
    () => {
      const { layer, child } = setup({
        route: freshVolumeRoute(defaultRoute()),
        platform: "darwin",
      });
      return Effect.gen(function* () {
        yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        const args = createArgs(child.spawned);
        expect(args?.includes("--add-host")).toBe(false);
      });
    },
  );

  it.live("propagates a Docker inspect failure", () => {
    const { layer } = setup({ runningFails: true });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to inspect service");
      }
    });
  });

  it.live("propagates a container-create failure and rolls back", () => {
    const base = defaultRoute();
    const route = freshVolumeRoute((args) => {
      if (args[0] === "create") return { exitCode: 1, stderr: ["boom"] };
      return base(args);
    });
    const { layer, child } = setup({ route });
    return Effect.gen(function* () {
      const exit = yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(rollbackWasAttempted(child.spawned)).toBe(true);
      expect(volumePruneWasAttempted(child.spawned)).toBe(true);
    });
  });

  it.live("emits a json result when the database is already running", () => {
    const { layer, out } = setup({ running: true, format: "json" });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["status"]).toBe("already-running");
    });
  });

  it.live("emits a json result after starting the database", () => {
    const { layer, out, child } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* dbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(createArgs(child.spawned)).not.toBeUndefined();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["status"]).toBe("started");
      // Progress text like "Starting database..." goes to stderr unconditionally, even in
      // json output mode — only structured payloads on stdout are format-gated.
      expect(out.stderrText).toContain("Starting database from backup...\n");
    });
  });
});
