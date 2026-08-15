/**
 * The shadow baseline cache's acquire/export/restore flow, driven end to end against a tiny
 * in-test Docker model (create/start/stop/rm all mutate the same container table, and `docker cp`
 * really moves bytes in and out of it) plus the REAL filesystem under a per-test temp workdir, so
 * the tar artifact, its atomic publish, and its retention rule are exercised for real.
 *
 * Scenario-oriented on purpose: every test is a sequence of real acquires and releases, and the
 * assertions are on the resulting Docker state, the tar on disk, and what the caller was told
 * about the baseline — not on internal call ordering, except where the ordering IS the contract
 * (the export must stop the container before copying and start it again afterwards).
 */

import { join } from "node:path";

import type { ProjectConfig } from "@supabase/config";
import { ProjectConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import { LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import { legacyShadowBaselineCacheDir } from "../legacy-pgdelta.paths.ts";
import { LEGACY_PGDATA_PARENT_PATH, LEGACY_PGDATA_PATH } from "./pgdata-snapshot.ts";
import {
  LEGACY_SHADOW_BASELINE_KEEP,
  LEGACY_SHADOW_CACHE_ENV,
  legacyAcquireShadowDatabase,
  type LegacyShadowCacheOpts,
} from "./shadow-cache.ts";
import { LEGACY_SHADOW_DEBUG_ENV } from "./shadow-debug.ts";
import { legacyRemoveShadowDatabase } from "./shadow-database.ts";
import type { LegacyShadowDbSetupInput, LegacyShadowSetupInput } from "./shadow-database.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const defaultConfig: ProjectConfig = decodeConfig({});

const tempRoot = useLegacyTempWorkdir("legacy-shadow-cache-");

/** Sets an env var for the duration of `body`, restoring whatever the host had. */
const withEnv = <A, E, R>(
  name: string,
  value: string | undefined,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      return previous;
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

const withShadowCacheEnv = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  withEnv(LEGACY_SHADOW_CACHE_ENV, value, body);

/**
 * Isolates the global shadow-baseline cache under a per-test `SUPABASE_HOME` so tests never
 * write into the developer's real `~/.supabase`. Nested with the opt-in/opt-out gate.
 */
const withShadowCacheHome = <A, E, R>(
  value: string | undefined,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  withEnv(
    "SUPABASE_HOME",
    join(tempRoot.current, "_supabase_home"),
    withShadowCacheEnv(value, body),
  );

const withShadowDebugEnv = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  withEnv(LEGACY_SHADOW_DEBUG_ENV, value, body);

/**
 * Captures every write `body` makes directly to the real `process.stderr` — the channel
 * `legacyWaitForShadowReady`'s own `ready-attempt`/`ready-wait` debug lines use, since that
 * function has no `Output` in its context (see `health-check.ts`'s own doc comment). Mirrors
 * `health-check.unit.test.ts`'s own capture/restore pattern.
 */
const captureStderr = <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly result: A; readonly writes: ReadonlyArray<string> }, E, R> =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
    globalThis.process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof globalThis.process.stderr.write;
    const result = yield* body.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.process.stderr.write = originalWrite;
        }),
      ),
    );
    return { result, writes };
  });

// ---------------------------------------------------------------------------
// A minimal, stateful Docker model
// ---------------------------------------------------------------------------

/** The bytes the fake `docker cp <id>:PGDATA -` emits — stands in for a real ~90MB PGDATA tar. */
const FAKE_PGDATA_TAR = "data/PG_VERSION\n17\n";

interface FakeContainer {
  readonly labels: Readonly<Record<string, string>>;
  readonly autoRemove: boolean;
  running: boolean;
  /** Whether this container has ever been `docker start`ed — distinguishes a RE-start for `failRestart`. */
  everStarted?: boolean;
  /** What a previous `docker cp - <id>:<path>` unpacked into this container, if anything. */
  restored: string | undefined;
}

function fakeDockerDaemon(
  opts: {
    readonly failStart?: boolean;
    /** Fails only RE-starts (a `docker start` after the container has already run once) — the cold export's revive step. */
    readonly failRestart?: boolean;
    readonly failCopyOut?: boolean;
    readonly failCopyIn?: boolean;
  } = {},
) {
  const containers = new Map<string, FakeContainer>();
  const spawned: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let nextId = 0;

  /**
   * Drains a `Stream` passed as a command's `stdin` into a string, the way the real
   * `NodeChildProcessSpawner` runs a user-supplied stdin stream into the child's stdin sink — a
   * fake that ignored it would never notice the restore tar was not actually delivered.
   */
  const readStdin = Effect.fnUntraced(function* (command: ChildProcess.Command) {
    const configured = command._tag === "StandardCommand" ? command.options.stdin : undefined;
    // A caller may pass either a bare `CommandInput` or a `StdinConfig` wrapping one.
    const input = Stream.isStream(configured)
      ? configured
      : Predicate.hasProperty(configured, "stream")
        ? configured.stream
        : undefined;
    if (!Stream.isStream(input)) return "";
    return yield* Stream.runFold(
      input,
      () => "",
      (text: string, chunk) => text + decoder.decode(chunk as Uint8Array, { stream: true }),
    ).pipe(Effect.orElseSucceed(() => ""));
  });

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);

      let exitCode = 0;
      let stdout = "";
      let stderr = "";

      if (args[0] === "network" && args[1] === "inspect") {
        exitCode = 1;
      } else if (args[0] === "create") {
        nextId += 1;
        const id = `shadowcontainer${String(nextId).padStart(2, "0")}`.padEnd(64, "0");
        const labels: Record<string, string> = {};
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] !== "--label") continue;
          const [key = "", ...rest] = (args[index + 1] ?? "").split("=");
          labels[key] = rest.join("=");
        }
        containers.set(id, {
          labels,
          autoRemove: args.includes("--rm"),
          running: false,
          restored: undefined,
        });
        stdout = id;
      } else if (args[0] === "start") {
        const container = containers.get(args[1] ?? "");
        if (
          opts.failStart === true ||
          container === undefined ||
          (opts.failRestart === true && container.everStarted)
        ) {
          exitCode = 1;
        } else {
          container.running = true;
          container.everStarted = true;
        }
      } else if (args[0] === "stop") {
        const id = args[1] ?? "";
        const container = containers.get(id);
        if (container === undefined) exitCode = 1;
        else {
          container.running = false;
          // Docker destroys an `--rm` container the moment it exits, `docker stop` included —
          // verified against Docker 29. This is exactly why the cold export path drops `--rm`.
          if (container.autoRemove) containers.delete(id);
        }
      } else if (args[0] === "rm") {
        containers.delete(args[args.length - 1] ?? "");
      } else if (args[0] === "cp" && args[1] === "-") {
        // Secret copy is `docker cp - <id>:/`; restore is `docker cp - <id>:<pgdata parent>`.
        // Both use stdin, so failCopyIn must apply only to the restore — otherwise a warm
        // fallback test kills the pgsodium root-key copy and never reaches the archive.
        const [id = "", containerPath = ""] = (args[2] ?? "").split(":");
        const container = containers.get(id);
        const received = yield* readStdin(command);
        const isSecret = containerPath === "" || containerPath === "/";
        if (container === undefined || (!isSecret && opts.failCopyIn === true)) {
          exitCode = 1;
          stderr = "no such container";
        } else if (!isSecret) {
          container.restored = `${containerPath}::${received}`;
        }
      } else if (args[0] === "cp" && args[2] === "-") {
        // Export: `docker cp <id>:<containerPath> -`, tar on stdout.
        const [id = ""] = (args[1] ?? "").split(":");
        const container = containers.get(id);
        if (opts.failCopyOut === true || container === undefined) {
          exitCode = 1;
          stderr = "no such container";
        } else {
          stdout = FAKE_PGDATA_TAR;
        }
      } else if (args[0] === "container" && args[1] === "inspect") {
        const container = containers.get(args[2] ?? "");
        exitCode = container === undefined ? 1 : 0;
        stdout =
          container === undefined
            ? ""
            : JSON.stringify({
                Running: container.running,
                Status: container.running ? "running" : "exited",
                Health: { Status: "healthy" },
              });
      }

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        // `docker cp … -` writes the raw archive, every other call a trailing newline.
        stdout: Stream.fromIterable(stdout.length > 0 ? [encoder.encode(stdout)] : []),
        stderr: Stream.fromIterable(stderr.length > 0 ? [encoder.encode(stderr)] : []),
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  /**
   * One readable label per Docker call, so a test can assert the SEQUENCE of meaningful steps
   * rather than raw argv. `cp` is split three ways because the shadow issues three different
   * copies: the pgsodium root key every shadow gets (`cp-secret`, `container-lifecycle.ts`), the
   * baseline export (`cp-out`), and the baseline restore (`cp-in`).
   */
  const stepOf = (args: ReadonlyArray<string>): string => {
    if (args[0] === "network") return "network";
    if (args[0] === "container" && args[1] === "inspect") return "inspect";
    if (args[0] === "cp") {
      if (args[1] === "-") {
        const dest = args[2] ?? "";
        const containerPath = dest.slice(dest.indexOf(":") + 1);
        return containerPath === "" || containerPath === "/" ? "cp-secret" : "cp-in";
      }
      if (args[2] === "-") return "cp-out";
      return "cp-secret";
    }
    return args[0] ?? "";
  };

  return {
    spawner,
    spawned,
    containers,
    /** Every argv whose first token is `verb` (`create`/`rm`/`stop`/`start`/`cp`). */
    calls: (verb: string) => spawned.filter((args) => args[0] === verb),
    /** Every argv classified as `step` — see {@link stepOf}. */
    stepCalls: (step: string) => spawned.filter((args) => stepOf(args) === step),
    /** The full step sequence, with the `network` bookkeeping calls dropped as noise. */
    steps: () => spawned.map(stepOf).filter((step) => step !== "network"),
    ids: () => [...containers.keys()],
  };
}

// ---------------------------------------------------------------------------
// A fake Postgres the readiness probe can connect to
// ---------------------------------------------------------------------------

function fakeCluster(opts: { readonly failConnect?: boolean } = {}) {
  const connected: Array<string> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (cfg) =>
      Effect.suspend(() => {
        connected.push(cfg.database);
        return opts.failConnect === true
          ? Effect.fail(new LegacyDbConnectError({ message: "connection refused" }))
          : Effect.succeed({
              exec: () => Effect.void,
              query: () => Effect.succeed([]),
              extensionExists: () => Effect.succeed(false),
              copyToCsv: () => Effect.succeed(new Uint8Array()),
              queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
            });
      }),
  });
  return { layer, connected };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const shadowSetup = (): LegacyShadowDbSetupInput<never> => ({
  majorVersion: 17,
  config: defaultConfig,
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54320/postgres",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwks: Effect.succeed('{"keys":[]}'),
  apiUrl: "http://127.0.0.1:54321",
  authExternalUrl: undefined,
  siteUrl: defaultConfig.auth.site_url,
  anonKey: "anon-key",
  serviceRoleKey: "service-role-key",
  storageTargetMigration: "",
  realtimeEnabledForSetup: false,
  storageEnabledForSetup: false,
  authEnabledForSetup: false,
  serviceVersionOverrides: {},
  projectEnvValues: undefined,
  debug: false,
  webhooksEnabled: false,
  apiAutoExposeNewTables: Option.some(true),
  vault: [],
});

const shadowInput = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  overrides: { readonly shadowPort?: number; readonly jwtExpiry?: number } = {},
): LegacyShadowSetupInput<never> => ({
  db: { major_version: 17, settings: {} },
  experimental: defaultConfig.experimental,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: overrides.jwtExpiry ?? 3600,
  networkId: "supabase_network_proj",
  image: "public.ecr.aws/supabase/postgres:17.4.1.030",
  configImage: "supabase/postgres:17.4.1.030",
  shadowPort: overrides.shadowPort ?? 54320,
  password: "postgres",
  projectId: "proj",
  isBitbucketPipeline: false,
  workdir: tempRoot.current,
  extraHosts: [],
  fs,
  path,
  hostname: "127.0.0.1",
  healthTimeoutSeconds: 2,
  setup: shadowSetup(),
});

const shadowCacheDir = (path: Path.Path) => legacyShadowBaselineCacheDir(path);

/** The snapshot tars in the global cache dir, whatever keys they belong to. */
const soleTarName = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, path: Path.Path) {
  const entries = yield* fs
    .readDirectory(shadowCacheDir(path))
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return entries.filter((entry) => entry.endsWith(".tar"));
});

/** A full cold run: acquire, export the baseline, release. */
const coldRun = (
  docker: ReturnType<typeof fakeDockerDaemon>,
  input: LegacyShadowSetupInput<never>,
  opts: LegacyShadowCacheOpts = {},
) =>
  Effect.gen(function* () {
    const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input, opts);
    yield* handle.snapshotBaseline;
    yield* legacyRemoveShadowDatabase(docker.spawner, handle.containerId);
    return handle;
  });

describe("legacyAcquireShadowDatabase", () => {
  it.live("is today's bare create when the cache is explicitly disabled", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "0",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);

        // `--rm` intact, no PGDATA copies either way, and the snapshot step is a no-op. The one
        // `cp-secret` is the pgsodium root key every shadow has always been given.
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(docker.steps()).toEqual(["create", "cp-secret", "start"]);
        // Nothing is written to disk at all.
        expect(yield* soleTarName(fs, path)).toEqual([]);

        yield* legacyRemoveShadowDatabase(docker.spawner, handle.containerId);
        expect(docker.calls("rm")[0]).toEqual(["rm", "-f", "-v", handle.containerId]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("bypassCache acquires an uncached shadow even when a warm tar exists", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        // A published tar for this exact key — `sync --no-cache`'s bypass must ignore it.
        yield* coldRun(docker, input);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input, {
          bypassCache: true,
        });
        expect(handle.baselinePresent).toBe(false);
        // No restore in, no export out: the bypassed run neither reads nor rewrites the tar.
        const bypassSteps = docker.steps().slice(docker.steps().lastIndexOf("create"));
        expect(bypassSteps).toEqual(["create", "cp-secret", "start"]);
        expect(docker.calls("create").at(-1) ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(docker.stepCalls("cp-out")).toHaveLength(1); // the initial cold run's only
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("stays uncached on PG14, whose setup mutates role defaults mid-session", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // PG<=14's globals SQL runs `ALTER ROLE … SET …` on the setup session; a snapshot
        // boundary would force migrations onto a fresh session that observes those defaults,
        // unlike Go's single-connection flow — so the cache must stand down entirely.
        const base = shadowInput(fs, path);
        const input = {
          ...base,
          db: { ...base.db, major_version: 14 },
          setup: { ...base.setup, majorVersion: 14 },
        };
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        expect(handle.snapshotRequired).toBe(false);
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a warm hit also sweeps abandoned partials left by a killed concurrent writer", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        yield* coldRun(docker, input);
        // A concurrent writer that lost the publish race and was SIGKILLed mid-export: its
        // partial predates the hour threshold. Every later run is warm, so the warm branch
        // must be the one to sweep it.
        const abandoned = path.join(
          shadowCacheDir(path),
          "shadow-baseline-0011223344556677.tar.4242.partial",
        );
        yield* fs.writeFileString(abandoned, "stale");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        yield* fs.utimes(abandoned, twoHoursAgo, twoHoursAgo);

        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(warm.baselinePresent).toBe(true);
        expect(yield* fs.exists(abandoned)).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("stays uncached for an OrioleDB cluster even with the cache enabled", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // OrioleDB runs the shadow with an external S3 storage backend, so a disk-level PGDATA
        // tar is not a coherent snapshot — the acquire must degrade to the bare uncached shadow.
        const input = {
          ...shadowInput(fs, path),
          experimental: { ...defaultConfig.experimental, orioledb_version: "15" },
        };
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        expect(docker.calls("create")[0] ?? []).toContain("--rm");
        yield* handle.snapshotBaseline;
        expect(docker.calls("stop")).toEqual([]);
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("takes the cache path when the env var is unset (default ON)", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      undefined,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
        yield* handle.snapshotBaseline;
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("cold run stops, exports the tar, and starts the container again", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        expect(handle.baselinePresent).toBe(false);
        // The cold container must survive its own `docker stop`, so it carries no `--rm`.
        expect(docker.calls("create")[0] ?? []).not.toContain("--rm");

        yield* handle.snapshotBaseline;

        // Ordering IS the contract here: stop before the copy (a live PGDATA is not coherent to
        // copy), start plus a readiness probe after it (the caller is about to reconnect).
        expect(docker.steps()).toEqual([
          "create",
          "cp-secret",
          "start",
          "stop",
          "cp-out",
          "start",
          "inspect",
        ]);
        expect(docker.stepCalls("cp-out")[0]).toEqual([
          "cp",
          `${handle.containerId}:${LEGACY_PGDATA_PATH}`,
          "-",
        ]);
        expect(docker.containers.get(handle.containerId)?.running).toBe(true);

        // Exactly one tar, published under its final name with the exported bytes intact — no
        // `.partial` left behind.
        const tars = yield* soleTarName(fs, path);
        expect(tars).toHaveLength(1);
        expect(tars[0]).toMatch(/^shadow-baseline-[0-9a-f]{16}\.tar$/u);
        expect(yield* fs.readFileString(path.join(shadowCacheDir(path), tars[0] ?? ""))).toBe(
          FAKE_PGDATA_TAR,
        );
        const leftovers = yield* fs.readDirectory(shadowCacheDir(path));
        expect(leftovers.filter((entry) => entry.includes("partial"))).toEqual([]);

        // Release is the uncached removal, same as ever — nothing is kept.
        yield* legacyRemoveShadowDatabase(docker.spawner, handle.containerId);
        expect(docker.ids()).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("warm run restores the tar into a FRESH container before starting it", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const cold = yield* coldRun(docker, input);

        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, input);
        // A brand new container every time — the cache keeps a file, never a container.
        expect(warm.containerId).not.toBe(cold.containerId);
        expect(warm.baselinePresent).toBe(true);
        // Throwaway again: the warm container never gets stopped, so `--rm` is back.
        expect(docker.calls("create").at(-1) ?? []).toContain("--rm");

        // The restore lands BEFORE the start, and carries the exported bytes into PGDATA's parent.
        const warmSteps = docker.steps().slice(docker.steps().lastIndexOf("create"));
        expect(warmSteps).toEqual(["create", "cp-secret", "cp-in", "start", "inspect"]);
        expect(docker.stepCalls("cp-in").at(-1)).toEqual([
          "cp",
          "-",
          `${warm.containerId}:${LEGACY_PGDATA_PARENT_PATH}`,
        ]);
        expect(docker.containers.get(warm.containerId)?.restored).toBe(
          `${LEGACY_PGDATA_PARENT_PATH}::${FAKE_PGDATA_TAR}`,
        );

        // Nothing more is exported: the baseline is already on disk.
        yield* warm.snapshotBaseline;
        expect(docker.calls("stop")).toHaveLength(1);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a pre-created permissive temp file cannot leak into the published tar's mode", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const tempDir = shadowCacheDir(path);
        yield* fs.makeDirectory(tempDir, { recursive: true });
        // An adversarially (or crash-) pre-created temp file at THIS process's own temp path,
        // world-readable. The export must not inherit its mode: the pre-remove + `wx`
        // exclusive-create guarantees a fresh 0600 inode.
        yield* coldRun(docker, input); // publish once to learn the tar name
        const [tarName = ""] = yield* soleTarName(fs, path);
        const tarPath = path.join(tempDir, tarName);
        const tempPath = `${tarPath}.${process.pid}.partial`;
        yield* fs.remove(tarPath); // force the next run cold
        yield* fs.writeFileString(tempPath, "poisoned");
        yield* fs.chmod(tempPath, 0o666);

        yield* coldRun(docker, input);

        const info = yield* fs.stat(tarPath);
        // 0o600 exactly — not the pre-created file's 0o666.
        expect((Number(info.mode) & 0o777).toString(8)).toBe("600");
        expect(yield* fs.readFileString(tarPath)).toBe(FAKE_PGDATA_TAR);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a cold export sweeps abandoned partial temp files but never fresh ones", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = shadowCacheDir(path);
        yield* fs.makeDirectory(tempDir, { recursive: true });
        // A SIGKILLed export's leftover (writer long gone — hour-plus-old mtime) and a
        // concurrent writer's live temp file (fresh mtime).
        const abandoned = path.join(tempDir, "shadow-baseline-0123456789abcdef.tar.99999.partial");
        const live = path.join(tempDir, "shadow-baseline-fedcba9876543210.tar.88888.partial");
        yield* fs.writeFileString(abandoned, "stale");
        yield* fs.writeFileString(live, "in-flight");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        yield* fs.utimes(abandoned, twoHoursAgo, twoHoursAgo);

        yield* coldRun(docker, shadowInput(fs, path));

        expect(yield* fs.exists(abandoned)).toBe(false);
        expect(yield* fs.exists(live)).toBe(true);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("publishing distinct keys keeps both tars until LRU/TTL eviction", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* coldRun(docker, shadowInput(fs, path));
        const first = yield* soleTarName(fs, path);
        expect(first).toHaveLength(1);

        // A changed baked-in input (jwt expiry) is a different cluster / different key — both
        // must coexist in the global cache (unlike the old project-local current-key-only sweep,
        // which would have deleted the first). Host publish port is NOT a key input.
        const rekeyed = yield* coldRun(docker, shadowInput(fs, path, { jwtExpiry: 7200 }));
        const both = yield* soleTarName(fs, path);
        expect(both).toHaveLength(2);
        expect(both).toContain(first[0]);
        expect(rekeyed.baselinePresent).toBe(false);

        // An unrelated file in the cache directory is untouched by retention.
        const stray = path.join(shadowCacheDir(path), "catalog-abc.json");
        yield* fs.writeFileString(stray, "{}");

        // Fill to the keep-cap + 1 with more distinct keys; the oldest (first) is evicted.
        for (let i = 0; i < LEGACY_SHADOW_BASELINE_KEEP - 1; i++) {
          yield* coldRun(docker, shadowInput(fs, path, { jwtExpiry: 8000 + i }));
        }
        const afterCap = yield* soleTarName(fs, path);
        expect(afterCap).toHaveLength(LEGACY_SHADOW_BASELINE_KEEP);
        expect(afterCap).not.toContain(first[0]);
        expect(yield* fs.exists(stray)).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("worktrees with identical settings share a warm hit from the global cache", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktreeA = path.join(tempRoot.current, "worktree-a");
        const worktreeB = path.join(tempRoot.current, "worktree-b");
        yield* fs.makeDirectory(path.join(worktreeA, "supabase"), { recursive: true });
        yield* fs.makeDirectory(path.join(worktreeB, "supabase"), { recursive: true });

        const cold = yield* coldRun(docker, { ...shadowInput(fs, path), workdir: worktreeA });
        expect(cold.baselinePresent).toBe(false);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        // Same settings, different project path — the second worktree must restore, not re-export.
        const warm = yield* legacyAcquireShadowDatabase(docker.spawner, {
          ...shadowInput(fs, path),
          workdir: worktreeB,
        });
        expect(warm.baselinePresent).toBe(true);
        expect(warm.containerId).not.toBe(cold.containerId);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
        yield* legacyRemoveShadowDatabase(docker.spawner, warm.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a changed published host port is still a warm hit", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cold = yield* coldRun(docker, shadowInput(fs, path, { shadowPort: 54320 }));
        expect(cold.baselinePresent).toBe(false);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        // pg-delta next allocates an ephemeral host port per shadow; the published port is
        // not in PGDATA, so a later run on a different port must restore the same tar.
        const warm = yield* legacyAcquireShadowDatabase(
          docker.spawner,
          shadowInput(fs, path, { shadowPort: 54399 }),
        );
        expect(warm.baselinePresent).toBe(true);
        expect(yield* soleTarName(fs, path)).toHaveLength(1);
        yield* legacyRemoveShadowDatabase(docker.spawner, warm.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("legacy forced-on webhooks and next config-following webhooks do not share a tar", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        // `shadowSetup.webhooksEnabled` is false, so `"config"` (next migrate) and
        // `"disabled"` (next declarative) bake the same cluster; `"enabled"` (legacy
        // migrate) does not and must not restore that tar.
        yield* coldRun(docker, input, { webhooks: "config" });
        expect(yield* soleTarName(fs, path)).toHaveLength(1);

        const forcedOn = yield* coldRun(docker, input, { webhooks: "enabled" });
        expect(forcedOn.baselinePresent).toBe(false);
        expect(yield* soleTarName(fs, path)).toHaveLength(2);

        const warmConfig = yield* legacyAcquireShadowDatabase(docker.spawner, input, {
          webhooks: "config",
        });
        expect(warmConfig.baselinePresent).toBe(true);
        const warmDisabled = yield* legacyAcquireShadowDatabase(docker.spawner, input, {
          webhooks: "disabled",
        });
        expect(warmDisabled.baselinePresent).toBe(true);
        expect(yield* soleTarName(fs, path)).toHaveLength(2);
        yield* legacyRemoveShadowDatabase(docker.spawner, warmConfig.containerId);
        yield* legacyRemoveShadowDatabase(docker.spawner, warmDisabled.containerId);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("a changed internal image registry is a different key, not a warm hit", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        yield* coldRun(docker, input);
        const defaultRegistryTar = yield* soleTarName(fs, path);
        expect(defaultRegistryTar).toHaveLength(1);

        // The one-shot migrate jobs resolve their images through
        // `SUPABASE_INTERNAL_IMAGE_REGISTRY`, so a different registry can bake different
        // realtime/storage/auth schema under identical tags — the snapshot must not be shared.
        const mirrored = yield* withEnv(
          "SUPABASE_INTERNAL_IMAGE_REGISTRY",
          "mirror.internal.example",
          coldRun(docker, input),
        );
        expect(mirrored.baselinePresent).toBe(false);
        const mirroredTar = yield* soleTarName(fs, path);
        // Distinct keys coexist in the global cache — the default-registry tar is not swept.
        expect(mirroredTar).toHaveLength(2);
        expect(mirroredTar).toContain(defaultRegistryTar[0]);
        expect(mirroredTar.some((name) => name !== defaultRegistryTar[0])).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live(
    "a shadow that cannot come back after the snapshot fails the run, not just the cache",
    () => {
      const docker = fakeDockerDaemon({ failRestart: true });
      const cluster = fakeCluster();
      const out = mockOutput();
      return withShadowCacheHome(
        "1",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
          // The export itself succeeds (stop + copy-out are fine); the revive `docker start` fails.
          // Reporting success here would send the caller's next connect to a dead container's port
          // — possibly answered by a DIFFERENT Postgres by then — so this must be a failure, not a
          // "not cached" warning.
          const exit = yield* handle.snapshotBaseline.pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(out.stderrText).not.toContain("Warning: shadow baseline not cached");
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
    },
  );

  it.live("a failed export warns, leaves no tar, and still brings the container back up", () => {
    const docker = fakeDockerDaemon({ failCopyOut: true });
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handle = yield* legacyAcquireShadowDatabase(docker.spawner, shadowInput(fs, path));
        // The run itself must never fail for a cache problem.
        yield* handle.snapshotBaseline;

        expect(out.stderrText).toContain("Warning: shadow baseline not cached");
        // The caller is about to reconnect, so the container is running again regardless.
        expect(docker.containers.get(handle.containerId)?.running).toBe(true);
        // Neither a published tar nor a half-written temp file survives.
        const entries = yield* fs.readDirectory(shadowCacheDir(path));
        expect(entries).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live(
    "a failed warm restore falls back cold, keeping the tar until its export replaces it",
    () => {
      const docker = fakeDockerDaemon({ failCopyIn: true });
      const cluster = fakeCluster();
      const out = mockOutput();
      return withShadowCacheHome(
        "1",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const input = shadowInput(fs, path);
          // A cold run first, so a snapshot for this exact key exists to be restored.
          const cold = yield* coldRun(docker, input);
          expect(yield* soleTarName(fs, path)).toHaveLength(1);

          const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, input);
          expect(out.stderrText).toContain("cached shadow baseline unusable");
          // Falls all the way back to a cold provision — a fresh container with no baseline.
          expect(fallback.baselinePresent).toBe(false);
          expect(fallback.containerId).not.toBe(cold.containerId);
          // The container whose restore failed is removed, not orphaned: with the cold run's own
          // container already released by `coldRun`, only the fallback's remains.
          expect(docker.ids()).toEqual([fallback.containerId]);
          // An extraction failure does NOT implicate the tar's contents (it could just as well be
          // a daemon hiccup), so the tar survives the fallback decision...
          expect(yield* soleTarName(fs, path)).toHaveLength(1);
          // ...and the cold fallback's own export atomically republishes over it, so a genuinely
          // corrupt tar still self-heals within this one run.
          yield* fallback.snapshotBaseline;
          expect(yield* soleTarName(fs, path)).toHaveLength(1);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
    },
  );

  it.live("a restored shadow that never becomes ready is removed before the cold retry", () => {
    const docker = fakeDockerDaemon();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const healthy = fakeCluster();
        const cold = yield* coldRun(docker, input).pipe(Effect.provide(healthy.layer));
        const tarBefore = yield* soleTarName(fs, path);
        expect(tarBefore).toHaveLength(1);

        // The restored cluster refuses every connection — the restore produced something
        // unstartable, so the tar itself is suspect.
        const broken = fakeCluster({ failConnect: true });
        const fallback = yield* legacyAcquireShadowDatabase(docker.spawner, input).pipe(
          Effect.provide(broken.layer),
        );

        expect(fallback.baselinePresent).toBe(false);
        expect(fallback.containerId).not.toBe(cold.containerId);
        // The suspect container is gone before the replacement is created — it holds the shadow's
        // published port.
        const removeIndex = docker.spawned.findIndex((args) => args[0] === "rm");
        const recreateIndex = docker.spawned.findLastIndex((args) => args[0] === "create");
        expect(removeIndex).toBeGreaterThanOrEqual(0);
        expect(removeIndex).toBeLessThan(recreateIndex);
        expect(yield* soleTarName(fs, path)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, fakeCluster().layer)));
  });
});

describe("SUPABASE_SHADOW_DEBUG phase-timing instrumentation", () => {
  it.live("emits export and restore phase lines when the debug env var is set", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = shadowInput(fs, path);
        const { writes } = yield* withShadowDebugEnv(
          "1",
          captureStderr(
            Effect.gen(function* () {
              yield* coldRun(docker, input);
              yield* legacyAcquireShadowDatabase(docker.spawner, input);
            }),
          ),
        );

        // Routed through the mocked `Output` (both phases run inside shadow-cache.ts, which
        // always has `Output` in context).
        expect(out.stderrText).toContain("shadow-debug: baseline-export");
        expect(out.stderrText).toContain("shadow-debug: baseline-restore");
        // Written straight to the real `process.stderr` by `legacyWaitForShadowReady`
        // (`health-check.ts`), which has no `Output` in its own context.
        expect(writes.some((chunk) => chunk.includes("shadow-debug: ready-wait"))).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });

  it.live("emits no shadow-debug lines when the debug env var is unset", () => {
    const docker = fakeDockerDaemon();
    const cluster = fakeCluster();
    const out = mockOutput();
    return withShadowCacheHome(
      "1",
      withShadowDebugEnv(
        undefined,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { writes } = yield* captureStderr(coldRun(docker, shadowInput(fs, path)));
          expect(out.stderrText).not.toContain("shadow-debug:");
          expect(writes.some((chunk) => chunk.includes("shadow-debug:"))).toBe(false);
        }),
      ),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, out.layer, cluster.layer)));
  });
});
