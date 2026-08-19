import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Path, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { vi } from "vitest";

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyShadowCacheDisabled,
  useLegacyTempWorkdir,
  withLegacyShadowCacheEnabled,
  legacySequentialExecBatch,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
} from "../../../shared/legacy-db-connection.service.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import {
  LegacyEdgeRuntimeScript,
  type LegacyEdgeRuntimeRunOpts,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyShadowBaselineCacheDir } from "../../../shared/legacy-pgdelta.paths.ts";
import { legacyDbStart } from "./start.handler.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

const DEFAULT_FLAGS: LegacyDbStartFlags = { fromBackup: Option.none() };
const PG_NET_CREATE_FINGERPRINT = "create extension if not exists pg_net schema extensions";
const PG_NET_DROP_FINGERPRINT = "drop extension if exists pg_net";
const GLOBALS_FINGERPRINT = "CREATE ROLE anon";

function flags(fromBackup?: string): LegacyDbStartFlags {
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

/** Scoped-down port of `start.integration.test.ts`'s own `mockStartContainerCliSpawner` — one container instead of 14. */
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

/** The three PG15+ one-shot migrate jobs (`legacyRunFreshDbSetup`'s `LegacyDockerRun` calls). */
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
 * Makes `legacyIsLocalDbRunning`'s pre-bring-up `container inspect` succeed
 * unconditionally, simulating an already-up local db — this is the very first
 * Docker call the handler makes, so no other `container inspect` call happens on
 * this path (the already-running short-circuit returns before `StartDatabase`).
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
 * Makes `legacyIsLocalDbRunning`'s pre-bring-up `container inspect` fail for a
 * reason other than "no such container" — simulates an unreachable Docker daemon
 * during the running-check, which `AssertSupabaseDbIsRunning` propagates instead of
 * treating as "not running".
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

/** Mirrors `start.integration.test.ts`'s own `fakeDbSession` — PG15+ (this suite's default) never calls `exec`/`query` (its schema init is three one-shot `LegacyDockerRun` jobs instead). */
function fakeDbSession() {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "exec", sql });
      }),
    query: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "query", sql });
        return [];
      }),
    execBatch: (statements) => legacySequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

const tempRoot = useLegacyTempWorkdir("supabase-db-start-int-");

// The baseline cache (`db-bootstrap/main-db-baseline.ts`) is ON by default and reads
// `process.env` directly, so every fresh-volume bring-up below would otherwise restore or publish
// a real tar under the developer's own `~/.supabase`. This suite's subject is the bring-up itself;
// the cache-focused scenarios opt back in per-test with `withLegacyShadowCacheEnabled`.
useLegacyShadowCacheDisabled();

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
  /** `LegacyEdgeRuntimeScript`'s mocked stdout for the pg-delta catalog-export call (`db-setup.ts`'s `legacyTryCacheMigrationsCatalog`). Only ever reached on a fresh volume with pg-delta enabled. */
  readonly catalogStdout?: string;
  /** Fails the mocked catalog-export call with this message instead of succeeding. */
  readonly catalogExportFailWith?: string;
  /** Number of initial `LegacyDbConnection.connect` attempts that fail before succeeding. */
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
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliConfig = mockLegacyCliConfig({ workdir });
  const baseRoute = opts.route ?? defaultRoute();
  const route =
    opts.running === true
      ? alreadyRunningRoute(baseRoute)
      : opts.runningFails === true
        ? runningCheckFailsRoute(baseRoute)
        : baseRoute;
  const child = mockContainerCliSpawner(route);
  const dbSession = fakeDbSession();
  const edgeRunCalls: Array<LegacyEdgeRuntimeRunOpts> = [];
  const edgeRuntime = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeRunCalls.push(runOpts);
      if (opts.catalogExportFailWith !== undefined) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({ message: opts.catalogExportFailWith }),
        );
      }
      return Effect.succeed({ stdout: opts.catalogStdout ?? '{"version":1}', stderr: "" });
    },
  });
  const sslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.succeed(false),
    requireSslForHost: () => Effect.succeed(false),
  });

  let connectAttempts = 0;
  const connectFailures = opts.connectFailures ?? 0;
  const dbConnection = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.suspend(() => {
        connectAttempts += 1;
        if (connectAttempts <= connectFailures) {
          return Effect.fail(
            new LegacyDbConnectError({
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
    cliConfig,
    telemetry.layer,
    child.layer,
    alwaysReadyHttpClientLayer,
    dbConnection,
    legacyDockerRunLayer.pipe(
      Layer.provide(child.layer),
      Layer.provide(mockProcessControl().layer),
    ),
    mockProcessControl().layer,
    mockRuntimeInfo({ platform: opts.platform ?? "linux", cwd: opts.cwd ?? workdir }),
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(CliArgs, { args: ["db", "start"] }),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
    edgeRuntime,
    sslProbe,
  );
  return {
    layer,
    out,
    telemetry,
    child,
    dbSession,
    edgeRunCalls,
    get connectAttempts() {
      return connectAttempts;
    },
  };
}

const currentBranchPath = (workdir: string) =>
  join(workdir, "supabase", ".branches", "_current_branch");

describe("legacy db start", () => {
  afterEach(() => {
    delete process.env["SUPABASE_NETWORK_ID"];
  });

  it.live("reports an already-running database without starting a container", () => {
    const { layer, out, telemetry, child } = setup({ running: true });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Postgres database is already running.");
      expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      expect(telemetry.flushed).toBe(true);
      // `initCurrentBranch` is inside `legacyStartDatabase`, never reached on
      // the already-running short-circuit — the already-running check
      // returns before `legacyStartDatabase` is ever called.
      expect(existsSync(currentBranchPath(tempRoot.current))).toBe(false);
    });
  });

  it.live(
    "starts the database on a fresh volume: creates the container, runs the SetupLocalDatabase-equivalent pipeline, and writes _current_branch",
    () => {
      const { layer, out, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(s.layer));
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
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(s.layer), Effect.exit);
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
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Initialising schema...");
        // PG <= 14's `initSchema` execs globals.sql + the initial-schema SQL directly over the
        // `LegacyDbConnection` session — no PG15+ one-shot `docker run --rm` migrate jobs at all.
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
        expect(dbSession.calls.length).toBeGreaterThan(0);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live(
    "a fresh volume with realtime disabled skips the realtime migrate job AND never attempts JWKS resolution",
    () => {
      // A configured (but unreachable) third-party JWKS issuer would fail
      // `legacyResolveLocalJwks` if it were ever called — the PG15 realtime
      // job resolves JWKS itself, gated on `Realtime.Enabled`, so a fresh
      // volume with realtime disabled must never even attempt it, regardless
      // of what it would have resolved to. This is the one place `db
      // start`'s own JWKS gating is directly observable
      // (`legacyStartDatabase`'s `setup.jwks` is a LAZY `Effect`, evaluated
      // only when reached).
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
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
        }
        // The container was already created/started/healthy by the time JWKS resolution runs
        // (deep inside the fresh-volume setup step) — the rollback still tears it down.
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
    "caches the migrations catalog after a fresh-volume setup with the legacy pg-delta engine",
    () => {
      const { layer, out, edgeRunCalls } = setup({
        configContents: 'project_id = "test"\n[experimental.pgdelta]\nenabled = true\n',
        projectEnvContents: "SUPABASE_USE_PG_DELTA_NEXT=false\n",
        route: freshVolumeRoute(defaultRoute()),
        catalogStdout: '{"snapshot":"ok"}',
      });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).not.toContain("failed to cache migrations catalog");
        // Runs once, AFTER the fresh-volume migrate+seed pipeline — the
        // catalog cache runs immediately after the migrate-and-seed step.
        expect(edgeRunCalls).toHaveLength(1);
        const tempDir = join(tempRoot.current, "supabase", ".temp", "pgdelta");
        const catalogFiles = readdirSync(tempDir).filter((name) =>
          name.startsWith("catalog-local-migrations-"),
        );
        expect(catalogFiles).toHaveLength(1);
        expect(readFileSync(join(tempDir, catalogFiles[0]!), "utf8")).toBe('{"snapshot":"ok"}');
      });
    },
  );

  it.live(
    "warns without failing db start when the legacy migrations-catalog export fails on a fresh volume",
    () => {
      const { layer, out } = setup({
        configContents: 'project_id = "test"\n[experimental.pgdelta]\nenabled = true\n',
        projectEnvContents: "SUPABASE_USE_PG_DELTA_NEXT=false\n",
        route: freshVolumeRoute(defaultRoute()),
        catalogExportFailWith: "edge-runtime script produced no output",
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(
          "Warning: failed to cache migrations catalog: edge-runtime script produced no output",
        );
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live(
    "does not attempt to cache the migrations catalog on a fresh volume when pg-delta is disabled",
    () => {
      const { layer, out, edgeRunCalls } = setup({ route: freshVolumeRoute(defaultRoute()) });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(edgeRunCalls).toHaveLength(0);
        expect(out.stderrText).not.toContain("failed to cache migrations catalog");
        expect(existsSync(join(tempRoot.current, "supabase", ".temp", "pgdelta"))).toBe(false);
      });
    },
  );

  it.live(
    "restarts against an existing volume: skips the SetupLocalDatabase-equivalent pipeline but still writes _current_branch",
    () => {
      const { layer, out, child, dbSession } = setup();
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Starting database from backup...\n");
        expect(out.stderrText).not.toContain("Initialising schema...");
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
        // No schema/globals/vault/roles SQL — the setup pipeline really is skipped. The
        // only SQL on this path is the Database Webhooks convergence, which reads the
        // migration history and (webhooks disabled, no migration owning pg_net) drops it.
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
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* legacyDbStart(flags("/abs/host/backup.sql")).pipe(Effect.provide(layer));
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
        const exit = yield* legacyDbStart(flags("/abs/host/backup.sql")).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toMatchObject({
            _tag: "LegacyStartBackupVolumeExistsError",
            message: "backup volume already exists",
          });
          expect((error as { suggestion?: string }).suggestion).toContain(
            "supabase stop --no-backup",
          );
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        // The rollback always removes everything on ANY start-database
        // failure, including this guard — `deleteVolumes: false` since the
        // volume this guard detected must never be pruned.
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
      yield* legacyDbStart(flags("dump.sql")).pipe(Effect.provide(layer));
      const args = createArgs(child.spawned);
      expect(bindsFromCreateArgs(args ?? [])).toContain("/caller/here/dump.sql:/etc/backup.sql:ro");
    });
  });

  it.live("treats an empty --from-backup as a normal no-backup start", () => {
    const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* legacyDbStart(flags("")).pipe(Effect.provide(layer));
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
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(rollbackWasAttempted(child.spawned)).toBe(true);
      // This run's own volume was confirmed fresh (`freshVolumeRoute`), so
      // the rollback prunes it too. A regression that hardcoded
      // `legacyRollbackStart`'s `deleteVolumes` to `false` would still pass
      // every OTHER assertion in this file, since only the "backup volume
      // already exists" test (a non-fresh-volume scenario) currently asserts
      // the negative half.
      expect(volumePruneWasAttempted(child.spawned)).toBe(true);
      // The health-check timeout aborts before `SetupLocalDatabase`/`initCurrentBranch` ever run.
      expect(existsSync(currentBranchPath(tempRoot.current))).toBe(false);
    });
  });

  it.live(
    "honors a SUPABASE_DEBUG set only in the project .env: the rollback's Pruned reports fire without --debug",
    () => {
      // Every Go debug read on this path went through `viper.GetBool("DEBUG")` under
      // `AutomaticEnv` after `loadNestedEnv` had `os.Setenv`'d the project `supabase/.env` into
      // the process — so a `SUPABASE_DEBUG` set only there, never in the shell or via `--debug`,
      // still gated the rollback's `Pruned …:` stderr reports. Delete any shell `SUPABASE_DEBUG`
      // first: shell *presence* (even `false`) suppresses the project value entirely, per
      // `legacyViperEnvBoolWithProjectFallback`'s own semantics.
      const previous = process.env["SUPABASE_DEBUG"];
      delete process.env["SUPABASE_DEBUG"];
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db]\nhealth_timeout = "1s"\n',
        route: freshVolumeRoute(defaultRoute({ neverHealthy: true })),
      });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), "SUPABASE_DEBUG=true\n");
      // `reportPruned` writes straight to the real process stderr (matching Go's unconditional
      // `os.Stderr`), never the mocked `Output` service — intercept it like
      // `health-check.unit.test.ts`'s own log-dump assertions do.
      const writes: Array<string> = [];
      const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
      globalThis.process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof globalThis.process.stderr.write;
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
        // The log dump (`legacyWaitForHealthyServices`'s own unconditional behavior on timeout,
        // teed straight to the real process stderr, not the mocked `Output` service) still runs —
        // exercised by every other health-timeout test via the shared `../../../shared/db-bootstrap/health-check.ts` suite;
        // this test only asserts the command-level outcome that's specific to `--from-backup`.
        yield* legacyDbStart(flags("/abs/host/backup.sql")).pipe(Effect.provide(layer));
        expect(rollbackWasAttempted(child.spawned)).toBe(false);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

  it.live("proceeds with no config file (missing config is tolerated)", () => {
    const { layer, child } = setup({ skipConfig: true, route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(createArgs(child.spawned)).not.toBeUndefined();
    });
  });

  it.live(
    "fails with a typed error on a malformed supabase/.env file, before any container is created",
    () => {
      const { layer, child } = setup({});
      writeFileSync(join(tempRoot.current, "supabase", ".env"), "not a valid env line at all\n");
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live("fails fast on a malformed config.toml", () => {
    const { layer, child, telemetry } = setup({ configContents: 'project_id = "unterminated\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
    // `network-id` is a persistent flag bound to a `SUPABASE_NETWORK_ID` env
    // fallback, read fresh at its own call site — well after the config's
    // dotenv pass — so a shell/project-dotenv `SUPABASE_NETWORK_ID` is
    // effective when the flag itself is omitted (review: PRRT_kwDOErm0O86VlqIL).
    process.env["SUPABASE_NETWORK_ID"] = "env-network";
    const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
      // The gate is on a non-empty resolved value, not merely "the flag was
      // passed" — an empty override (e.g. a shell expanding an unset var to
      // "") must fall through to the generated `supabase_network_<projectId>`
      // name, not produce a literal `--network ""` on the `docker create` call.
      const { layer, child } = setup({
        route: freshVolumeRoute(defaultRoute()),
        networkId: "",
      });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Config loading decodes every duration field unconditionally, for every
  // command including `db start` — even though `db start` never starts
  // GoTrue itself. Mirrors `commands/start/start.handler.ts`'s own identical
  // eager-validation tests.
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
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails with a typed config error on a malformed SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT override, before any container is created",
    () => {
      // `auth.rate_limit` (plain uints) has no enabled-gated validation —
      // its only check is the unconditional type-decode inside config
      // loading's single pass, which fails a non-numeric override regardless
      // of `auth.enabled` or whether `db start` itself ever reads the field
      // (review: PRRT_kwDOErm0O86Vk-e0).
      const { layer, child } = setup({});
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("auth.rate_limit");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Closes the review-thread gap: config loading decodes the ENTIRE config
  // struct unconditionally in a single pass, including every field below,
  // regardless of whether `db start` itself ever reads it — mirrors
  // `commands/start/start.handler.ts`'s own identical eager-validation tests
  // for these same fields (review: PRRT_kwDOErm0O86VlOHQ).
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
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Regression test for the exact gap the review thread found: `legacyEnvOverrideRealtimeIpVersion`/
  // `legacyEnvOverrideRealtimeMaxHeaderLength` used to be invoked ONLY inside
  // `legacyResolveDbBootstrapConfig`, which never runs once `legacyIsLocalDbRunning`
  // short-circuits — so a malformed override was silently ignored whenever
  // Postgres was already running, unlike the established behavior of
  // decoding both fields unconditionally before the already-running check
  // (review: PRRT_kwDOErm0O86VmHkl).
  it.live.each([
    ["realtime.ip_version", "SUPABASE_REALTIME_IP_VERSION", "IPv5"],
    ["realtime.max_header_length", "SUPABASE_REALTIME_MAX_HEADER_LENGTH", "not-a-uint"],
  ] as const)(
    "fails with a typed config error on a malformed %s override even when Postgres is already running",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Same gap, same shape, whole `db.settings.*` group: `legacyResolveDbSettingsEnvOverrides`
  // was only ever invoked building `legacyStartDatabase`'s
  // `postgresSpec.db.settings`, which never runs once
  // `legacyIsLocalDbRunning` short-circuits — so a malformed override was
  // silently ignored whenever Postgres was already running, unlike the
  // established behavior of decoding the entire `db.settings` struct
  // unconditionally before the already-running check (review:
  // PRRT_kwDOErm0O86Vn3Hw).
  it.live.each([
    ["db.settings.max_connections", "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "bogus"],
    ["db.settings.track_commit_timestamp", "SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP", "bogus"],
  ] as const)(
    "fails with a typed config error on a malformed %s override even when Postgres is already running",
    ([dottedFieldPath, envVar, envValue]) => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), `${envVar}=${envValue}\n`);
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Same gap, same shape, different field: `storage.enabled` (a plain bool)
  // was only ever resolved inside `legacyResolveDbBootstrapConfig` (gating
  // the fresh-volume storage migrate job), which never runs once
  // `legacyIsLocalDbRunning` short-circuits — so a malformed override was
  // silently ignored whenever Postgres was already running, unlike the
  // established behavior of decoding it unconditionally before the
  // already-running check (review: PRRT_kwDOErm0O86VooCL).
  it.live(
    "fails with a typed config error on a malformed SUPABASE_STORAGE_ENABLED override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STORAGE_ENABLED=not-a-bool\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("storage.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Same gap, same shape, different fields: `edge_runtime.enabled`,
  // `db.network_restrictions.enabled`, `studio.enabled`, and
  // `local_smtp.enabled` were only ever resolved inside
  // `legacyResolveLocalConfigValues` (the not-running branch's own
  // config-values resolver, called below), which never runs once
  // `legacyIsLocalDbRunning` short-circuits — so a malformed override was
  // silently ignored whenever Postgres was already running, unlike the
  // established behavior of decoding all four unconditionally before the
  // already-running check (review: PRRT_kwDOErm0O86Vo7zx).
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
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Regression test for the review thread this fix closes: `studio.api_url`
  // was resolved (`studioApiUrlForValidation`) but never parsed with
  // `legacyGoUrlParse` in this eager battery — only
  // `legacyResolveLocalConfigValues` (the not-running branch, called well
  // after the already-running short-circuit below) ever validated it.
  // Validation parses `studio.api_url` immediately after the `studio.port`
  // check, still inside the studio-enabled gate — so a malformed
  // `SUPABASE_STUDIO_API_URL` would otherwise be silently accepted whenever
  // Postgres is already running (review: PRRT_kwDOErm0O86WEBfl).
  it.live(
    "fails with a typed config error on a malformed SUPABASE_STUDIO_API_URL override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STUDIO_API_URL=http://[::1\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("Invalid config for studio.api_url");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Regression test for the sibling review thread: `local_smtp.port` was resolved
  // (`localSmtpPortForValidation`) but the `local_smtp.enabled`-gated zero check never ran in this
  // eager battery — only `legacyResolveLocalConfigValues`'s `mailpitEnabled`/`mailpitPort` pair
  // (the not-running branch, called well after the already-running short-circuit below) ever
  // checked it. Validation rejects `local_smtp.port === 0` ONLY when
  // `local_smtp.enabled` — so an enabled `[local_smtp]` section with a zero
  // port would otherwise be silently accepted whenever Postgres is already
  // running (review: PRRT_kwDOErm0O86WEBfq).
  it.live(
    "fails with a typed config error when local_smtp is enabled with a zero port even when Postgres is already running",
    () => {
      const { layer, child } = setup({
        running: true,
        configContents: 'project_id = "test"\n[local_smtp]\nenabled = true\nport = 0\n',
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("Missing required field in config: local_smtp.port");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Same gap, same shape, different field: `auth.jwt_expiry` (a plain uint)
  // was only ever resolved as part of `values.authJwtExpiry`
  // (`legacyResolveLocalConfigValues`), which this handler calls ONLY in the
  // not-running branch — so a malformed override was silently ignored
  // whenever Postgres was already running, unlike the established behavior
  // of decoding it unconditionally before the already-running check
  // (review: PRRT_kwDOErm0O86VmpeG).
  it.live(
    "fails with a typed config error on a malformed SUPABASE_AUTH_JWT_EXPIRY override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_JWT_EXPIRY=not-a-uint\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("auth.jwt_expiry");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Same gap, same shape, different field: `api.port` (a plain uint16) was
  // only ever resolved as part of `values.apiPort`
  // (`legacyResolveLocalConfigValues`), which this handler calls ONLY in the
  // not-running branch — so a malformed override was silently ignored
  // whenever Postgres was already running, unlike the established behavior
  // of decoding it unconditionally before the already-running check
  // (review: PRRT_kwDOErm0O86Vnmss).
  it.live(
    "fails with a typed config error on a malformed SUPABASE_API_PORT override even when Postgres is already running",
    () => {
      const { layer, child } = setup({ running: true });
      writeFileSync(join(tempRoot.current, "supabase", ".env"), "SUPABASE_API_PORT=not-a-port\n");
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("api.port");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  // Same gap, same shape, remaining root-level `auth.*` scalars: none of
  // these is referenced by any auth-enabled gate, so — like `auth.jwt_expiry`
  // above — each was only ever resolved as part of
  // `legacyResolveLocalConfigValues`, which this handler calls ONLY in the
  // not-running branch, and a malformed override was silently ignored
  // whenever Postgres was already running, unlike the established behavior
  // of decoding all of them unconditionally before the already-running
  // check (review: PRRT_kwDOErm0O86VnEV6).
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
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(dottedFieldPath);
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on an invalid auth.passkey.enabled even when auth is disabled, matching Go's Config.Load",
    () => {
      // `auth.passkey`/`auth.webauthn` have no `@supabase/config` schema at
      // all — `auth.passkey.enabled` is decoded unconditionally via
      // `legacyResolveGotruePasskeyWebauthn`'s raw-document read, so the
      // malformed value must live directly in config.toml here since
      // `@supabase/config` never sees (or rejects) this unmodeled field —
      // there's no schema-level bool coercion to catch it first
      // (review: PRRT_kwDOErm0O86VlOHQ).
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.passkey]\nenabled = "bad"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("auth.passkey");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on an invalid auth.external.<custom>.enabled even when auth is disabled, matching Go's Config.Load",
    () => {
      // `auth.external` is a genuine dynamic map keyed by provider name — an
      // unmodeled/custom provider name like `custom` is a legitimate config
      // shape `@supabase/config`'s schema silently drops at decode time, so
      // `legacyResolveAuthExternalProviders`'s raw-document read is the only
      // place this malformed value is ever seen — same override-only-throw
      // reasoning as the passkey test above (review: PRRT_kwDOErm0O86VlOHQ).
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.external.custom]\nenabled = "bad"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("auth.external");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED override, matching Go's Config.Load",
    () => {
      // `auth.hook.<type>.*` is bound like every other nested field, decoded
      // in the same unconditional config-load pass as `auth.external` above.
      // `legacyResolveAuthHooks` only applies the env override when the
      // `[auth.hook.<type>]` section is present in the raw document
      // (`@supabase/config`'s schema always decodes a `{ enabled: false }`
      // default regardless of file presence, which would otherwise erase the
      // presence signal the env override needs) — so the section must exist
      // in config.toml for the override below to be reached at all. `db
      // start` never built a GoTrue container, so nothing else in this
      // handler called `legacyResolveAuthHooks` before now (review:
      // PRRT_kwDOErm0O86WBGSW).
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[auth.hook.send_email]\nenabled = false\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("auth.hook");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_AUTH_EMAIL_SMTP_PORT override even when auth is disabled, matching Go's Config.Load",
    () => {
      // `auth.email.smtp.*` is bound like every other nested field once
      // `[auth.email.smtp]` is present in config.toml, decoded in the same
      // unconditional config-load pass as `auth.hook` above — confirmed
      // empirically that this decode failure fires even with `auth.enabled = false`,
      // well before the auth-enabled-gated email validation and before the
      // already-running check. `db start` never built a GoTrue container, so
      // nothing else in this handler called `legacyResolveAuthEmailSmtp`
      // before now (review: PRRT_kwDOErm0O86WC8J3).
      const { layer, child } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.email.smtp]\nhost = "smtp.example.com"\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_EMAIL_SMTP_PORT=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("auth.email.smtp");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "ignores SUPABASE_AUTH_EMAIL_SMTP_PORT when [auth.email.smtp] is absent from config.toml",
    () => {
      // Only keys already bound from the merged config are intercepted — an
      // absent `[auth.email.smtp]` section never picks up an env override
      // alone (confirmed empirically), so `legacyResolveAuthEmailSmtp`'s own
      // presence gate must return `undefined` and the eager check below must
      // be a no-op rather than failing on a section the config never mentions.
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[auth]\nenabled = false\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_AUTH_EMAIL_SMTP_PORT=bogus\n",
      );
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(createArgs(child.spawned)).not.toBeUndefined();
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED override, matching Go's Config.Load",
    () => {
      // `storage.image_transformation` is a nil-unless-declared pointer
      // field, bound like every other nested pointer field once
      // `[storage.image_transformation]` is present in config.toml — the
      // same shape as `auth.hook`/`auth.email.smtp` above (confirmed
      // empirically: `SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=bogus`
      // fails config loading when the section is present, even though `db
      // start` never builds ImgProxy or the Storage container). `db start`
      // never resolves this field elsewhere, so nothing else in this
      // handler called the eager check before now (review: PRRT_kwDOErm0O86WDkO9).
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[storage.image_transformation]\nenabled = true\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("storage.image_transformation.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "ignores SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED when [storage.image_transformation] is absent from config.toml",
    () => {
      // Only keys already bound from the merged config are intercepted — an
      // absent `[storage.image_transformation]` section never picks up an
      // env override alone (confirmed empirically), so the eager check must
      // gate on section presence and be a no-op rather than failing on a
      // section the config never mentions.
      const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(createArgs(child.spawned)).not.toBeUndefined();
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_DB_SSL_ENFORCEMENT_ENABLED override, matching Go's Config.Load",
    () => {
      // `db.ssl_enforcement` is a nil-unless-declared pointer field, bound
      // like every other nested pointer field once `[db.ssl_enforcement]` is
      // present in config.toml — the same presence-gated shape as
      // `storage.image_transformation` above, not the plain-bool shape of
      // `db.network_restrictions.enabled` (never a pointer). `db start`
      // never resolves this field elsewhere, so nothing else in this
      // handler called the eager check before now (review: PRRT_kwDOErm0O86WE42a).
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db.ssl_enforcement]\nenabled = true\n',
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("db.ssl_enforcement.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "fails on a malformed SUPABASE_DB_SSL_ENFORCEMENT_ENABLED override even when Postgres is already running",
    () => {
      // Same gap, already-running variant: Codex's exact repro for this finding was an
      // already-running project declaring `[db.ssl_enforcement]` — the eager check above already
      // covers the non-running path, this proves the running short-circuit doesn't mask it either
      // (review: PRRT_kwDOErm0O86WE42a).
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[db.ssl_enforcement]\nenabled = true\n',
        running: true,
      });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain("db.ssl_enforcement.enabled");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live(
    "ignores SUPABASE_DB_SSL_ENFORCEMENT_ENABLED when [db.ssl_enforcement] is absent from config.toml",
    () => {
      // Only keys already bound from the merged config are intercepted — an
      // absent `[db.ssl_enforcement]` section never picks up an env override
      // alone (confirmed empirically for the identical
      // `storage.image_transformation` shape above), so the eager check must
      // gate on section presence and be a no-op rather than failing on a
      // section the config never mentions.
      const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
      writeFileSync(
        join(tempRoot.current, "supabase", ".env"),
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED=bogus\n",
      );
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(createArgs(child.spawned)).not.toBeUndefined();
      });
    },
  );

  it.live(
    "fails with a typed config error when [experimental.webhooks] is present without enabled = true, even when Postgres is already running",
    () => {
      // Experimental validation rejects ANY present `[experimental.webhooks]`
      // section whose `enabled` isn't explicitly `true` — this runs
      // unconditionally inside config loading, before the already-running
      // check. `db start`'s own `legacyCheckDbToml` call (D's shared
      // db/migration config pipeline, `legacy-db-config.toml-read.ts`)
      // previously never populated
      // `LegacyExperimentalInput.webhooksPresent`/`webhooksEnabled` at all,
      // so `legacyValidateResolvedConfig`'s existing webhooks check never
      // ran for `db start` (or any other D caller) — silently accepted
      // regardless of whether Postgres was already running (review:
      // PRRT_kwDOErm0O86WE42i).
      const { layer, child } = setup({
        configContents: 'project_id = "test"\n[experimental.webhooks]\nenabled = false\n',
        running: true,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const message = JSON.stringify(exit.cause);
          expect(message).toContain("LegacyDbConfigLoadError");
          expect(message).toContain(
            "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
          );
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      });
    },
  );

  it.live("starts normally when [experimental.webhooks] is absent from config.toml", () => {
    // An absent `[experimental.webhooks]` section is never rejected (the
    // bool zero-value default is fine) — the new webhooks presence check
    // must be a no-op rather than failing on a section the config never mentions.
    const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(createArgs(child.spawned)).not.toBeUndefined();
    });
  });

  it.live(
    "warns when api.auto_expose_new_tables is true, matching Go's unconditional Config.Validate print",
    () => {
      // This warning is printed unconditionally right after the `project_id`
      // check, before any `api.enabled`/`auth.enabled` gate — so it must
      // fire on a fresh start regardless of those flags. The removed hidden
      // bootstrap child used to print this itself; the native path has no
      // equivalent call without this fix (review: PRRT_kwDOErm0O86WC8J7).
      const { layer, out } = setup({
        configContents: 'project_id = "test"\n[api]\nauto_expose_new_tables = true\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain(
          "WARN: api.auto_expose_new_tables is deprecated and will be removed on 2026-10-30.",
        );
      });
    },
  );

  it.live("does not warn about api.auto_expose_new_tables when it is unset", () => {
    const { layer, out } = setup({ route: freshVolumeRoute(defaultRoute()) });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("auto_expose_new_tables");
    });
  });

  it.live("warns about api.auto_expose_new_tables even when the db is already running", () => {
    // Config loading (Load + Validate, including this print) runs before
    // the already-running check — the warning must fire even on the
    // already-running short-circuit, not be masked by it.
    const { layer, out } = setup({
      configContents: 'project_id = "test"\n[api]\nauto_expose_new_tables = true\n',
      running: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("WARN: api.auto_expose_new_tables is deprecated");
      expect(out.stderrText).toContain("Postgres database is already running.");
    });
  });

  it.live(
    "prints @supabase/config's deprecated-[inbucket]-section WARN only once on a fresh, not-already-running start",
    () => {
      // `legacyLoadLocalProjectContext` wraps `@supabase/config`'s `loadProjectConfig`, which
      // unconditionally `Console.error`s a deprecation WARN for a legacy `[inbucket]` section
      // (`packages/config/src/io.ts`'s `normalizeDeprecatedSMTPSections`, pinned to the real
      // console — not this file's `Output` service, so it must be observed with a raw
      // `console.error` spy, same idiom as `stop`/`status`'s own identical deprecated-provider
      // tests). This handler used to load that context TWICE on the not-running path: once
      // eagerly here (ahead of the already-running short-circuit), and again inside
      // `legacyBuildLocalDbContainerInputs`'s own, now-removed, internal
      // reload — doubling this WARN for one invocation, unlike the
      // established single config-load call. Threading the eagerly-loaded
      // context through as `legacyBuildLocalDbContainerInputs`'s
      // `preloadedContext` fixes this.
      const { layer } = setup({
        configContents: 'project_id = "test"\n[inbucket]\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      const warnings: Array<string> = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
    // Config loading (and therefore this eager duration validation) runs
    // before the already-running check — a malformed `auth.*` duration
    // field must fail the command even when Postgres is already up, not be
    // masked by the already-running short-circuit. Mirrors the sibling
    // "undecryptable secret" already-running test above.
    const { layer, out } = setup({
      configContents: 'project_id = "test"\n[auth.email]\nmax_frequency = "not-a-duration"\n',
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const message = JSON.stringify(exit.cause);
        expect(message).toContain("LegacyDbConfigLoadError");
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
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("WARN: no SMS provider is enabled. Disabling phone login");
      });
    },
  );

  it.live(
    "does not warn about SMS when auth is disabled, matching Go's Enabled-gated (s *sms) validate()",
    () => {
      // The sms validation that sources this warning only runs when auth is
      // enabled. A disabled-auth project with `enable_signup = true` and no
      // provider configured must NOT print the warning (review: PRRT_kwDOErm0O86Vk-e2).
      const { layer, out } = setup({
        configContents:
          'project_id = "test"\n[auth]\nenabled = false\n[auth.sms]\nenable_signup = true\n',
        route: freshVolumeRoute(defaultRoute()),
      });
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
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
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        const args = createArgs(child.spawned);
        expect(args?.includes("--add-host")).toBe(false);
      });
    },
  );

  it.live("propagates a Docker inspect failure", () => {
    const { layer } = setup({ runningFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(rollbackWasAttempted(child.spawned)).toBe(true);
      // Same reasoning as the health-timeout rollback test above — this run's own volume was
      // confirmed fresh, so the rollback prunes it too.
      expect(volumePruneWasAttempted(child.spawned)).toBe(true);
    });
  });

  it.live("emits a json result when the database is already running", () => {
    const { layer, out } = setup({ running: true, format: "json" });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["status"]).toBe("already-running");
    });
  });

  it.live("emits a json result after starting the database", () => {
    const { layer, out, child } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(createArgs(child.spawned)).not.toBeUndefined();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["status"]).toBe("started");
      // "Starting database..." (or "...from backup..." on a pre-existing
      // volume, as here — see `defaultRoute`) is written to stderr
      // unconditionally — no output-format concept gates it, so the
      // `--output-format json` run must still see it on stderr (review:
      // PRRT_kwDOErm0O86VmHkn).
      expect(out.stderrText).toContain("Starting database from backup...\n");
    });
  });

  // The baseline cache (`shared/db-bootstrap/main-db-baseline.ts`) is ON in production; the
  // suite-wide `useLegacyShadowCacheDisabled` above turns it off everywhere else so the other
  // scenarios assert the plain bring-up. These turn it back on — under a per-test
  // `SUPABASE_HOME`, so the ~90MB-in-production tar never lands in the developer's real
  // `~/.supabase` — and drive `db start` for real against it. The cache's own mechanics (key
  // derivation, atomic publish, retention, degradation) are covered at their own level in
  // `shared/db-bootstrap/shadow-cache.integration.test.ts`.
  describe("cached database baseline", () => {
    const SHADOW_HOME_DIR = "_supabase_home";

    /** Re-enables the cache the suite-wide gate turned off, rooted at this test's own home. */
    const withCacheEnabled = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      withLegacyShadowCacheEnabled(join(tempRoot.current, SHADOW_HOME_DIR), body);

    /**
     * Every published `shadow-baseline-<key>.tar` under the per-test home, at the directory
     * production itself derives — a relocated cache directory cannot pass unnoticed here.
     */
    const publishedBaselineTars = (): ReadonlyArray<string> => {
      const dir = legacyShadowBaselineCacheDir(
        Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer))),
        { SUPABASE_HOME: join(tempRoot.current, SHADOW_HOME_DIR) },
      );
      return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".tar")) : [];
    };

    /**
     * The baseline restore's own `docker cp - <id>:/var/lib/postgresql` (PGDATA's PARENT).
     * Deliberately narrower than `cp -`: every container create also copies its secret files
     * that way, targeting `<id>:/`.
     */
    const isBaselineRestoreCp = (args: ReadonlyArray<string>): boolean =>
      args[0] === "cp" && args[1] === "-" && (args[2] ?? "").endsWith(":/var/lib/postgresql");

    /** One full fresh-volume `db start`. */
    const runFreshStart = Effect.fnUntraced(function* (fromBackup?: string) {
      const s = setup({ route: freshVolumeRoute(defaultRoute()) });
      yield* legacyDbStart(flags(fromBackup)).pipe(Effect.provide(s.layer));
      return s;
    });

    it.live(
      "reuses the published baseline on the next fresh-volume start instead of re-running it",
      () =>
        withCacheEnabled(
          Effect.gen(function* () {
            const cold = yield* runFreshStart();
            // Cold: the platform baseline really ran, and the snapshot was taken at its seam.
            expect(cold.out.stderrText).toContain("Initialising schema...");
            expect(dbSetupJobCalls(cold.child.spawned)).toHaveLength(3);
            expect(cold.child.spawned.filter((s) => s.args[0] === "stop")).toHaveLength(1);
            expect(publishedBaselineTars()).toHaveLength(1);

            const warm = yield* runFreshStart();
            // Warm: the restored cluster already carries the baseline, so neither its progress
            // text nor its one-shot migrate jobs happen — and nothing is re-snapshotted.
            expect(warm.out.stderrText).toContain("Restoring cached baseline...\n");
            expect(warm.out.stderrText).not.toContain("Initialising schema...");
            expect(warm.out.stderrText).not.toContain("Seeding globals from roles.sql...");
            expect(dbSetupJobCalls(warm.child.spawned)).toHaveLength(0);
            expect(warm.child.spawned.filter((s) => s.args[0] === "stop")).toHaveLength(0);

            // The tar is unpacked into the created-but-unstarted container: the entrypoint has
            // to find an initialized PGDATA, so the copy MUST precede `docker start`.
            const restoreCp = warm.child.spawned.findIndex((s) => isBaselineRestoreCp(s.args));
            const start = warm.child.spawned.findIndex((s) => s.args[0] === "start");
            expect(restoreCp).toBeGreaterThanOrEqual(0);
            expect(start).toBeGreaterThan(restoreCp);

            // `initCurrentBranch` is the last line of `StartDatabase` on every path.
            expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
            expect(publishedBaselineTars()).toHaveLength(1);
          }),
        ),
      20_000,
    );

    it.live(
      "--from-backup never restores a cached baseline, even when one is published for this project",
      () =>
        withCacheEnabled(
          Effect.gen(function* () {
            // `--from-backup` and a plain fresh start hash to the SAME key (the restore
            // entrypoint is not a key input), so this leaves a tar the backup run below would
            // warm-hit if it consulted the cache at all.
            yield* runFreshStart();
            expect(publishedBaselineTars()).toHaveLength(1);

            const backup = yield* runFreshStart("/abs/host/backup.sql");

            expect(backup.out.stderrText).not.toContain("Restoring cached baseline...");
            // The only archive this path delivers is its own backup bind.
            expect(bindsFromCreateArgs(createArgs(backup.child.spawned) ?? [])).toContain(
              "/abs/host/backup.sql:/etc/backup.sql:ro",
            );
            expect(backup.child.spawned.some((s) => isBaselineRestoreCp(s.args))).toBe(false);
            // The whole `SetupLocalDatabase`-equivalent pipeline is skipped, so there is no
            // platform baseline to publish either — the pool is left exactly as it was.
            expect(dbSetupJobCalls(backup.child.spawned)).toHaveLength(0);
            expect(backup.child.spawned.filter((s) => s.args[0] === "stop")).toHaveLength(0);
            expect(publishedBaselineTars()).toHaveLength(1);
          }),
        ),
      20_000,
    );
  });
});
