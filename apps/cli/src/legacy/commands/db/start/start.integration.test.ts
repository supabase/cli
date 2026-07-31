import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
} from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
} from "../../../shared/legacy-db-connection.service.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyDbStart } from "./start.handler.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

const DEFAULT_FLAGS: LegacyDbStartFlags = { fromBackup: Option.none() };

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

/** The three PG15+ one-shot migrate jobs (`legacyStartSetupLocalDatabase`'s `LegacyDockerRun` calls). */
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
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

const tempRoot = useLegacyTempWorkdir("supabase-db-start-int-");

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
  readonly skipConfig?: boolean;
  readonly workdir?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly networkId?: string;
  /** `--experimental`/`SUPABASE_EXPERIMENTAL`. Defaults to `false`. */
  readonly experimental?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const workdir = opts.workdir ?? tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(workdir, opts.configContents ?? 'project_id = "test"\n');
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

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliConfig,
    telemetry.layer,
    child.layer,
    alwaysReadyHttpClientLayer,
    Layer.succeed(LegacyDbConnection, { connect: () => Effect.succeed(dbSession.session) }),
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
  );
  return { layer, out, telemetry, child, dbSession };
}

const currentBranchPath = (workdir: string) =>
  join(workdir, "supabase", ".branches", "_current_branch");

describe("legacy db start", () => {
  it.live("reports an already-running database without starting a container", () => {
    const { layer, out, telemetry, child } = setup({ running: true });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Postgres database is already running.");
      expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      expect(telemetry.flushed).toBe(true);
      // `initCurrentBranch` is inside `StartDatabase`, never reached on the already-running
      // short-circuit — `AssertSupabaseDbIsRunning` returns before `StartDatabase` is ever
      // called (`start.go:48-50`).
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
      // A configured (but unreachable) third-party JWKS issuer would fail `legacyResolveLocalJwks`
      // if it were ever called — Go's own `initSchema15`'s realtime job resolves JWKS itself,
      // gated on `Realtime.Enabled` (`internal/db/start/start.go:337-341`), so a fresh volume
      // with realtime disabled must never even attempt it, regardless of what it would have
      // resolved to. This is the one place `db start`'s own JWKS gating is directly observable
      // (`legacyStartDatabase`'s `setup.jwks` is a LAZY `Effect`, evaluated only when reached).
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
    "restarts against an existing volume: skips the SetupLocalDatabase-equivalent pipeline but still writes _current_branch",
    () => {
      const { layer, out, child } = setup();
      return Effect.gen(function* () {
        yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Starting database from backup...\n");
        expect(out.stderrText).not.toContain("Initialising schema...");
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
        expect(readFileSync(currentBranchPath(tempRoot.current), "utf8")).toBe("main");
      });
    },
  );

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
        // Go's `Run` always calls `DockerRemoveAll` on ANY `StartDatabase` failure
        // (`start.go:54-59`), including this guard — `deleteVolumes: false` since the volume
        // this guard detected must never be pruned.
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
      // This run's own volume was confirmed fresh (`freshVolumeRoute`), so the rollback prunes
      // it too — matching Go's `NoBackupVolume` gate. A regression that hardcoded
      // `legacyRollbackStart`'s `deleteVolumes` to `false` would still pass every OTHER
      // assertion in this file, since only the "backup volume already exists" test (a
      // non-fresh-volume scenario) currently asserts the negative half.
      expect(volumePruneWasAttempted(child.spawned)).toBe(true);
      // The health-check timeout aborts before `SetupLocalDatabase`/`initCurrentBranch` ever run.
      expect(existsSync(currentBranchPath(tempRoot.current))).toBe(false);
    });
  });

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

  // Go's `Config.Load` (`flags.LoadConfig`) decodes every `time.Duration` field unconditionally,
  // for every command including `db start` — even though `db start` never starts GoTrue itself.
  // Mirrors `commands/start/start.handler.ts`'s own identical eager-validation tests.
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

  it.live("fails on a malformed auth duration field even when the db is already running", () => {
    // Go's `flags.LoadConfig` (and therefore this eager duration validation) runs before
    // `AssertSupabaseDbIsRunning` in `start.Run` (`internal/db/start/start.go:45-47`) — a
    // malformed `auth.*` duration field must fail the command even when Postgres is already
    // up, not be masked by the already-running short-circuit. Mirrors the sibling
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
    });
  });
});
