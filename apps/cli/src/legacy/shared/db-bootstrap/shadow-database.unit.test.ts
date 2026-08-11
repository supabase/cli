import type { ProjectConfig } from "@supabase/config";
import { ProjectConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Fiber, Layer, Option, Path, Schema, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyContainerRuntimeNotFoundMessage } from "../legacy-container-cli.ts";
import type { LegacyDbSession } from "../legacy-db-connection.service.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import { LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "../legacy-docker-run.service.ts";
import type { LegacySetupDatabaseInput } from "./db-setup.ts";
import { LEGACY_SHADOW_ENTRYPOINT_ARGS } from "./postgres.service.ts";
import {
  LEGACY_SHADOW_CREATE_TEMPLATE_SQL,
  LegacyShadowDbError,
  legacyBuildShadowSetupDatabaseInput,
  legacyConnectShadowDatabase,
  legacyCreateShadowDatabase,
  legacyMigrateShadowDatabase,
  legacyMigrateNextShadowDatabase,
  legacyRemoveShadowDatabase,
  legacySetupShadowConn,
  legacySetupShadowDatabase,
  type LegacyCreateShadowDatabaseInput,
  type LegacyShadowDbSetupInput,
} from "./shadow-database.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const defaultConfig: ProjectConfig = decodeConfig({});
const PG_NET_CREATE_FINGERPRINT = "create extension if not exists pg_net schema extensions";

const tempRoot = useLegacyTempWorkdir("legacy-shadow-database-");

function fakeSession() {
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

function mockDbConnection(session: LegacyDbSession) {
  return Layer.succeed(LegacyDbConnection, { connect: () => Effect.succeed(session) });
}

/**
 * A `LegacyDbConnection` whose `connect` fails with `LegacyDbConnectError` on
 * the first `failTimes` calls, then succeeds with `session` on every call
 * after that (`failTimes: Number.POSITIVE_INFINITY` never succeeds at all) —
 * for pinning {@link legacyConnectShadowDatabase}'s retry-schedule ATTEMPT
 * COUNT precisely, not merely "it eventually succeeds"/"it eventually fails".
 */
function mockFlakyDbConnection(session: LegacyDbSession, failTimes: number) {
  let attempts = 0;
  return {
    layer: Layer.succeed(LegacyDbConnection, {
      connect: () =>
        Effect.suspend(() => {
          attempts++;
          return attempts <= failTimes
            ? Effect.fail(new LegacyDbConnectError({ message: "connection refused" }))
            : Effect.succeed(session);
        }),
    }),
    get attempts() {
      return attempts;
    },
  };
}

function mockDockerRun() {
  const runs: Array<LegacyDockerRunOpts> = [];
  return Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(0),
    runCapture: (runOpts) => {
      runs.push(runOpts);
      return Effect.succeed({ exitCode: 0, stdout: new Uint8Array(), stderr: "" });
    },
    // The shadow's own PG15+ one-shot platform-baseline jobs (`legacyRunStartMigrateJob`)
    // go through `runStream`, not `runCapture` — see `db-setup.ts`'s own doc comment.
    runStream: (runOpts) => {
      runs.push(runOpts);
      return Effect.succeed({ exitCode: 0, stderr: "" });
    },
  });
}

/** Fakes `docker image inspect` (always cached), `network inspect`/`create`, `create` (returns a fixed id), `start`, and `rm`. */
function mockSpawner() {
  const spawned: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      // `legacyEnsureNetwork` probes with `network inspect` before ever creating one — report
      // it as missing so a `legacyCreateShadowDatabase` call actually reaches `network create`,
      // rather than short-circuiting on the pre-check the way an always-exit-0 mock would (the
      // ONLY caller of this mock that ever spawns `network`/`create` args at all).
      const exitCode = args[0] === "network" && args[1] === "inspect" ? 1 : 0;
      const stdout = args[0] === "create" ? "shadow-container-id-0123456789abcdef" : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(stdout.length > 0 ? [encoder.encode(`${stdout}\n`)] : []),
        stderr: Stream.empty,
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
  return { spawner, spawned };
}

/**
 * A spawner that fails to even launch a process — for both `docker` and
 * `podman` — mirroring the "daemon not on PATH" scenario `health-check.unit.test.ts`
 * scripts for `legacyWaitForHealthyServices`. Every `spawner.spawn` call fails
 * before ever returning a handle, so `legacySpawnContainerCliWithRuntime`
 * exhausts both runtimes and surfaces `LegacyContainerRuntimeNotFoundError`.
 */
function mockUnspawnableSpawner() {
  return ChildProcessSpawner.make(() =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "docker: command not found",
      }),
    ),
  );
}

function baseCreateInput(
  overrides: Partial<LegacyCreateShadowDatabaseInput> = {},
): LegacyCreateShadowDatabaseInput {
  return {
    db: { major_version: 17, settings: {} },
    experimental: defaultConfig.experimental,
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwtExpiry: 3600,
    networkId: "supabase_network_proj",
    image: "public.ecr.aws/supabase/postgres:17.4.1.030",
    configImage: "supabase/postgres:17.4.1.030",
    shadowPort: 54320,
    password: "postgres",
    projectId: "proj",
    isBitbucketPipeline: false,
    workdir: tempRoot.current,
    extraHosts: [],
    ...overrides,
  };
}

describe("legacyCreateShadowDatabase / legacyRemoveShadowDatabase", () => {
  it.effect(
    "creates the network then the container with no --name, and returns the created id",
    () => {
      const mock = mockSpawner();
      return legacyCreateShadowDatabase(mock.spawner, baseCreateInput()).pipe(
        Effect.map(({ containerId }) => {
          expect(containerId).toBe("shadow-container-id-0123456789abcdef");
          const networkCreateIdx = mock.spawned.findIndex(
            (a) => a[0] === "network" && a[1] === "create",
          );
          const createIdx = mock.spawned.findIndex((a) => a[0] === "create");
          expect(mock.spawned[networkCreateIdx]).toEqual([
            "network",
            "create",
            "--label",
            "com.supabase.cli.project=proj",
            "--label",
            "com.docker.compose.project=proj",
            "supabase_network_proj",
          ]);
          expect(networkCreateIdx).toBeGreaterThanOrEqual(0);
          expect(networkCreateIdx).toBeLessThan(createIdx);
          expect(mock.spawned[createIdx]).not.toContain("--name");
          expect(mock.spawned[createIdx]).toContain("--rm");
          // Go's `NewContainerConfig("-c", "max_worker_processes=0")` splice
          // (`CreateShadowDatabase`, `diff.go:140`) is not a bare docker flag — it's rendered
          // into the entrypoint script's own `docker-entrypoint.sh postgres -D /etc/postgresql
          // <args>` line (the script is the LAST `docker create` argv element, `cmd`'s second
          // entry). Assert it lands there, not merely that the literal string appears somewhere
          // in argv.
          const script = mock.spawned[createIdx]?.at(-1) ?? "";
          expect(script).toContain(
            `docker-entrypoint.sh postgres -D /etc/postgresql ${LEGACY_SHADOW_ENTRYPOINT_ARGS}`,
          );
        }),
      );
    },
  );

  it.effect("legacyRemoveShadowDatabase issues docker rm -f -v against the given id", () => {
    const mock = mockSpawner();
    return legacyRemoveShadowDatabase(mock.spawner, "shadow-container-id-0123456789abcdef").pipe(
      Effect.map(() => {
        expect(mock.spawned).toContainEqual([
          "rm",
          "-f",
          "-v",
          "shadow-container-id-0123456789abcdef",
        ]);
      }),
      Effect.provide(mockOutput().layer),
    );
  });

  it.effect(
    "legacyRemoveShadowDatabase is a pure no-op (no spawn at all) for an empty container id",
    () => {
      const mock = mockSpawner();
      const out = mockOutput();
      return legacyRemoveShadowDatabase(mock.spawner, "").pipe(
        Effect.map(() => {
          expect(mock.spawned).toEqual([]);
          expect(out.stderrText).toBe("");
        }),
        Effect.provide(out.layer),
      );
    },
  );

  it.effect(
    "reports (but never fails the caller for) a failure to even spawn the removal itself",
    () => {
      const out = mockOutput();
      return legacyRemoveShadowDatabase(
        mockUnspawnableSpawner(),
        "shadow-container-id-0123456789abcdef",
      ).pipe(
        Effect.exit,
        Effect.map((exit) => {
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(out.stderrText).toBe(
            `Failed to remove container: shadow-container-id-0123456789abcdef ${legacyContainerRuntimeNotFoundMessage}\n`,
          );
        }),
        Effect.provide(out.layer),
      );
    },
  );
});

const shadowConnConfig = {
  host: "127.0.0.1",
  port: 54320,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

describe("legacyConnectShadowDatabase", () => {
  it.effect(
    "dials the shadow's own connect config and returns the session on the first successful attempt",
    () => {
      const { session } = fakeSession();
      return legacyConnectShadowDatabase(shadowConnConfig).pipe(
        Effect.scoped,
        Effect.map((resolvedSession) => {
          expect(resolvedSession).toBe(session);
        }),
        Effect.provide(mockDbConnection(session)),
      );
    },
  );

  it.effect(
    "retries a failing connect on a 1-second backoff and returns the session once it stops failing",
    () => {
      const { session } = fakeSession();
      const mock = mockFlakyDbConnection(session, 3);
      return Effect.gen(function* () {
        const fiber = yield* legacyConnectShadowDatabase(shadowConnConfig).pipe(
          Effect.scoped,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        yield* TestClock.adjust("1 seconds");
        yield* TestClock.adjust("1 seconds");

        const resolvedSession = yield* Fiber.join(fiber);
        expect(resolvedSession).toBe(session);
        // 3 failed attempts, then the 4th that finally succeeds — pins the EXACT
        // attempt count (a `Schedule.min` regression would also "eventually
        // succeed" here, since 3 retries is well under either combinator's
        // ceiling — see the always-failing case below for the test that
        // actually distinguishes `min` from `max`).
        expect(mock.attempts).toBe(4);
      }).pipe(Effect.provide(mock.layer));
    },
  );

  it.effect(
    "gives up after exactly 11 attempts (1 initial + 10 retries) instead of retrying forever — pins Schedule.max over Schedule.min",
    () => {
      const { session } = fakeSession();
      // Never succeeds — pegs the retry schedule to its hard 10-retry ceiling.
      // `Schedule.max` (the correct combinator: recur while BOTH inputs can
      // still recur) stops here because `Schedule.recurs(10)` is exhausted. A
      // regression to `Schedule.min` (recur while EITHER input can still
      // recur) would keep recurring forever on `Schedule.spaced`'s unbounded
      // side, so this fiber would never complete — `Fiber.join` below would
      // hang/time out rather than resolve, catching exactly that swap.
      const mock = mockFlakyDbConnection(session, Number.POSITIVE_INFINITY);
      return Effect.gen(function* () {
        const fiber = yield* legacyConnectShadowDatabase(shadowConnConfig).pipe(
          Effect.scoped,
          Effect.forkChild({ startImmediately: true }),
        );

        for (let i = 0; i < 9; i++) {
          yield* TestClock.adjust("1 seconds");
        }
        // Not yet exhausted — 9 retries is one short of the 10-retry cap.
        expect(fiber.pollUnsafe()).toBeUndefined();

        // The 10th one-second backoff crosses the boundary.
        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyShadowDbError);
        expect(mock.attempts).toBe(11);
      }).pipe(Effect.provide(mock.layer));
    },
  );
});

function baseSetupDatabaseInput(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): LegacySetupDatabaseInput {
  return {
    session,
    fs,
    path,
    workdir,
    config: defaultConfig,
    majorVersion: 17,
    dbHost: "abcdef012345",
    projectId: "proj",
    networkId: "supabase_network_proj",
    dbUrl: "postgresql://postgres:postgrespassword@127.0.0.1:54322/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: '{"keys":[]}',
    apiUrl: "http://127.0.0.1:54321",
    siteUrl: defaultConfig.auth.site_url,
    anonKey: "anon-key",
    serviceRoleKey: "service-role-key",
    storageTargetMigration: "",
    images: {
      realtime: "public.ecr.aws/supabase/realtime:v2.34.7",
      storage: "public.ecr.aws/supabase/storage-api:v1.0.0",
      auth: "public.ecr.aws/supabase/gotrue:v2.170.0",
    },
    projectEnvValues: undefined,
    debug: false,
    apiAutoExposeNewTables: Option.some(true),
    vault: [],
  };
}

describe("legacySetupShadowConn", () => {
  it.effect("runs SetupDatabase, then unconditionally execs CREATE_TEMPLATE", () => {
    const { session, calls } = fakeSession();
    const workdir = tempRoot.current;
    const mock = mockSpawner();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySetupShadowConn(
        mock.spawner,
        baseSetupDatabaseInput(session, fs, path, workdir),
      );
      expect(calls.some((c) => c.sql === LEGACY_SHADOW_CREATE_TEMPLATE_SQL)).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(BunServices.layer, mockOutput().layer, mockDockerRun(), mockRuntimeInfo()),
      ),
    );
  });

  it.effect("can disable config-driven extension activation for a desired-state scratch", () => {
    const { session, calls } = fakeSession();
    const workdir = tempRoot.current;
    const mock = mockSpawner();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = baseSetupDatabaseInput(session, fs, path, workdir);
      yield* legacySetupShadowConn(
        mock.spawner,
        {
          ...input,
          config: decodeConfig({ experimental: { webhooks: { enabled: true } } }),
        },
        { activateUserExtensions: false },
      );
      expect(calls.some((call) => call.sql.includes(PG_NET_CREATE_FINGERPRINT))).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(BunServices.layer, mockOutput().layer, mockDockerRun(), mockRuntimeInfo()),
      ),
    );
  });
});

function baseShadowSetup<E = never>(
  overrides: Partial<LegacyShadowDbSetupInput<E>> = {},
): LegacyShadowDbSetupInput<E> {
  return {
    majorVersion: 17,
    config: defaultConfig,
    dbUrl: "postgresql://postgres:postgrespassword@127.0.0.1:54322/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: Effect.succeed('{"keys":[]}') as Effect.Effect<string, E>,
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
    apiAutoExposeNewTables: Option.some(true),
    vault: [],
    ...overrides,
  };
}

describe("legacyBuildShadowSetupDatabaseInput", () => {
  it.effect(
    "derives dbHost from the container's own 12-char short id and threads every field through",
    () => {
      const { session } = fakeSession();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const built = legacyBuildShadowSetupDatabaseInput(
          {
            fs,
            path,
            workdir: "/proj",
            projectId: "proj",
            container: "shadow-container-id-0123456789abcdef",
            networkId: "supabase_network_proj",
            connConfig: {
              host: "127.0.0.1",
              port: 54320,
              user: "postgres",
              password: "postgres",
              database: "postgres",
            },
            setup: baseShadowSetup(),
          },
          session,
          {
            jwks: '{"keys":[]}',
            images: {
              realtime: "public.ecr.aws/supabase/realtime:v2.34.7",
              storage: "public.ecr.aws/supabase/storage-api:v1.0.0",
              auth: "public.ecr.aws/supabase/gotrue:v2.170.0",
            },
          },
        );
        // Go's `container[:12]` — the future callers this was exported for (`migration
        // squash`) need this exact same derivation, not a re-implementation.
        expect(built.dbHost).toBe("shadow-conta");
        expect(built.session).toBe(session);
        expect(built.workdir).toBe("/proj");
        expect(built.networkId).toBe("supabase_network_proj");
        expect(built.majorVersion).toBe(17);
        expect(built.jwks).toBe('{"keys":[]}');
        expect(built.images.realtime).toBe("public.ecr.aws/supabase/realtime:v2.34.7");
        expect(built.apiAutoExposeNewTables).toEqual(Option.some(true));
        expect(built.vault).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});

describe("legacySetupShadowDatabase / legacyMigrateShadowDatabase", () => {
  it.effect(
    "legacySetupShadowDatabase connects, sets up the platform baseline, and creates the template database",
    () => {
      const { session, calls } = fakeSession();
      const workdir = tempRoot.current;
      const mock = mockSpawner();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacySetupShadowDatabase(mock.spawner, {
          fs,
          path,
          workdir,
          projectId: "proj",
          container: "shadow-container-id-0123456789abcdef",
          networkId: "supabase_network_proj",
          connConfig: {
            host: "127.0.0.1",
            port: 54320,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          setup: baseShadowSetup(),
        });
        expect(calls.some((c) => c.sql === LEGACY_SHADOW_CREATE_TEMPLATE_SQL)).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            mockDockerRun(),
            mockRuntimeInfo(),
            mockDbConnection(session),
          ),
        ),
      );
    },
  );

  it.effect(
    "legacyMigrateShadowDatabase applies pending local migrations after the platform baseline",
    () => {
      const { session, calls } = fakeSession();
      const workdir = tempRoot.current;
      const mock = mockSpawner();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "migrations"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "migrations", "20240101000000_init.sql"),
          "create table t ();",
        );
        yield* legacyMigrateShadowDatabase(mock.spawner, {
          fs,
          path,
          workdir,
          projectId: "proj",
          container: "shadow-container-id-0123456789abcdef",
          networkId: "supabase_network_proj",
          connConfig: {
            host: "127.0.0.1",
            port: 54320,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          setup: baseShadowSetup(),
        });
        expect(calls.some((c) => c.sql === LEGACY_SHADOW_CREATE_TEMPLATE_SQL)).toBe(true);
        expect(calls.some((c) => c.sql.includes(PG_NET_CREATE_FINGERPRINT))).toBe(true);
        expect(calls.some((c) => c.sql.includes("create table t ()"))).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            mockDockerRun(),
            mockRuntimeInfo(),
            mockDbConnection(session),
          ),
        ),
      );
    },
  );

  it.effect("next migrated shadows keep pg_net activation config-gated", () => {
    const { session, calls } = fakeSession();
    const workdir = tempRoot.current;
    const mock = mockSpawner();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase", "migrations"), { recursive: true });
      yield* legacyMigrateNextShadowDatabase(mock.spawner, {
        fs,
        path,
        workdir,
        projectId: "proj",
        container: "shadow-container-id-0123456789abcdef",
        networkId: "supabase_network_proj",
        connConfig: {
          host: "127.0.0.1",
          port: 54320,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        setup: baseShadowSetup(),
      });
      expect(calls.some((call) => call.sql.includes(PG_NET_CREATE_FINGERPRINT))).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          mockOutput().layer,
          mockDockerRun(),
          mockRuntimeInfo(),
          mockDbConnection(session),
        ),
      ),
    );
  });

  it.effect(
    "supports the extension-free declarative baseline on PG14 without resolving JWKS",
    () => {
      const { session } = fakeSession();
      const workdir = tempRoot.current;
      const mock = mockSpawner();
      let jwksEvaluated = false;
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacySetupShadowDatabase(
          mock.spawner,
          {
            fs,
            path,
            workdir,
            projectId: "proj",
            container: "shadow-container-id-0123456789abcdef",
            networkId: "supabase_network_proj",
            connConfig: {
              host: "127.0.0.1",
              port: 54320,
              user: "postgres",
              password: "postgres",
              database: "postgres",
            },
            setup: baseShadowSetup({
              majorVersion: 14,
              realtimeEnabledForSetup: true,
              jwks: Effect.sync(() => {
                jwksEvaluated = true;
                return '{"keys":[]}';
              }),
            }),
          },
          { activateUserExtensions: false },
        );
        expect(jwksEvaluated).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            mockDockerRun(),
            mockRuntimeInfo(),
            mockDbConnection(session),
          ),
        ),
      );
    },
  );

  it.effect("resolves JWKS on PG15+ when realtime is enabled", () => {
    const { session } = fakeSession();
    const workdir = tempRoot.current;
    const mock = mockSpawner();
    let jwksEvaluated = false;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySetupShadowDatabase(mock.spawner, {
        fs,
        path,
        workdir,
        projectId: "proj",
        container: "shadow-container-id-0123456789abcdef",
        networkId: "supabase_network_proj",
        connConfig: {
          host: "127.0.0.1",
          port: 54320,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        setup: baseShadowSetup({
          majorVersion: 17,
          realtimeEnabledForSetup: true,
          jwks: Effect.sync(() => {
            jwksEvaluated = true;
            return '{"keys":[]}';
          }),
        }),
      });
      expect(jwksEvaluated).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          mockOutput().layer,
          mockDockerRun(),
          mockRuntimeInfo(),
          mockDbConnection(session),
        ),
      ),
    );
  });

  it.effect(
    "legacyMigrateShadowDatabase lists local migrations BEFORE connecting, tolerating a missing migrations directory as an empty list rather than a failure",
    () => {
      const workdir = tempRoot.current;
      const mock = mockSpawner();
      // One shared, ordered log — recording both events into separate booleans (the prior
      // version of this test) would still pass if the two steps were swapped, since both
      // would still end up `true`; only an ordered log actually proves the sequence.
      const events: Array<string> = [];
      const dbConnection = Layer.succeed(LegacyDbConnection, {
        connect: () =>
          Effect.sync(() => {
            events.push("connect");
            return fakeSession().session;
          }),
      });
      return Effect.gen(function* () {
        const realFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migrationsDir = path.join(workdir, "supabase", "migrations");
        const fs = FileSystem.FileSystem.of({
          ...realFs,
          readDirectory: (dir, opts) => {
            if (dir === migrationsDir) events.push("list");
            return realFs.readDirectory(dir, opts);
          },
        });
        // No `supabase/migrations` directory exists — Go's `ListLocalMigrations` on a
        // missing dir resolves to an empty list (not an error), so this exercises the
        // ordering guarantee (list BEFORE connect) rather than a failure path.
        yield* legacyMigrateShadowDatabase(mock.spawner, {
          fs,
          path,
          workdir,
          projectId: "proj",
          container: "shadow-container-id-0123456789abcdef",
          networkId: "supabase_network_proj",
          connConfig: {
            host: "127.0.0.1",
            port: 54320,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          setup: baseShadowSetup(),
        });
        expect(events).toEqual(["list", "connect"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            mockDockerRun(),
            mockRuntimeInfo(),
            dbConnection,
          ),
        ),
      );
    },
  );
});
