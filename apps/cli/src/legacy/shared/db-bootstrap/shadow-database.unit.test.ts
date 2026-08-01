import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@supabase/config";
import { ProjectConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "../legacy-db-connection.service.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "../legacy-docker-run.service.ts";
import type { LegacySetupDatabaseInput } from "./db-setup.ts";
import {
  LEGACY_SHADOW_CONNECT_TIMEOUT_SECONDS,
  LEGACY_SHADOW_CREATE_TEMPLATE_SQL,
  LEGACY_SHADOW_ENTRYPOINT_ARGS,
  legacyBuildShadowSetupDatabaseInput,
  legacyConnectShadowDatabase,
  legacyCreateShadowDatabase,
  legacyMigrateShadowDatabase,
  legacyRemoveShadowDatabase,
  legacySetupShadowConn,
  legacySetupShadowDatabase,
  type LegacyCreateShadowDatabaseInput,
  type LegacyShadowDbSetupInput,
} from "./shadow-database.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const defaultConfig: ProjectConfig = decodeConfig({});

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

function mockDockerRun() {
  const runs: Array<LegacyDockerRunOpts> = [];
  return Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(0),
    runCapture: (runOpts) => {
      runs.push(runOpts);
      return Effect.succeed({ exitCode: 0, stdout: new Uint8Array(), stderr: "" });
    },
    runStream: () => Effect.die("runStream unused"),
  });
}

/** Fakes `docker image inspect` (always cached), `network create`, `create` (returns a fixed id), `start`, and `rm`. */
function mockSpawner() {
  const spawned: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const stdout = args[0] === "create" ? "shadow-container-id-0123456789abcdef" : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(stdout.length > 0 ? [encoder.encode(`${stdout}\n`)] : []),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
    workdir: mkdtempSync(join(tmpdir(), "legacy-shadow-database-")),
    extraHosts: [],
    ...overrides,
  };
}

describe("legacyCreateShadowDatabase / legacyRemoveShadowDatabase", () => {
  it.effect(
    "creates the network then the container with no --name, and returns the created id + a fresh secretDirId",
    () => {
      const mock = mockSpawner();
      return legacyCreateShadowDatabase(mock.spawner, baseCreateInput()).pipe(
        Effect.map(({ containerId, secretDirId }) => {
          expect(containerId).toBe("shadow-container-id-0123456789abcdef");
          expect(secretDirId).toMatch(/^shadow-/);
          const networkCreateIdx = mock.spawned.findIndex((a) => a[0] === "network");
          const createIdx = mock.spawned.findIndex((a) => a[0] === "create");
          expect(networkCreateIdx).toBeGreaterThanOrEqual(0);
          expect(networkCreateIdx).toBeLessThan(createIdx);
          expect(mock.spawned[createIdx]).not.toContain("--name");
          expect(mock.spawned[createIdx]).toContain("--rm");
        }),
      );
    },
  );

  it.effect("legacyRemoveShadowDatabase issues docker rm -f -v against the given id", () => {
    const mock = mockSpawner();
    return legacyRemoveShadowDatabase(mock.spawner, {
      containerId: "shadow-container-id-0123456789abcdef",
      secretDirId: "",
      workdir: "/proj",
    }).pipe(
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
      return legacyRemoveShadowDatabase(mock.spawner, {
        containerId: "",
        secretDirId: "",
        workdir: "/proj",
      }).pipe(
        Effect.map(() => {
          expect(mock.spawned).toEqual([]);
        }),
        Effect.provide(mockOutput().layer),
      );
    },
  );

  it.effect(
    "legacyRemoveShadowDatabase rm -rf's the staged secret directory keyed off secretDirId",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
      const mock = mockSpawner();
      const secretDir = join(workdir, "supabase", ".temp", "start-secrets", "shadow-abc123");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "root-key");
        yield* legacyRemoveShadowDatabase(mock.spawner, {
          containerId: "shadow-container-id-0123456789abcdef",
          secretDirId: "shadow-abc123",
          workdir,
        });
        const stillExists = yield* fs.exists(secretDir);
        expect(stillExists).toBe(false);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer)));
    },
  );
});

describe("legacyConnectShadowDatabase", () => {
  it.effect(
    "dials the shadow's own connect config and returns the session on the first successful attempt",
    () => {
      const { session } = fakeSession();
      return legacyConnectShadowDatabase({
        host: "127.0.0.1",
        port: 54320,
        user: "postgres",
        password: "postgres",
        database: "postgres",
      }).pipe(
        Effect.scoped,
        Effect.map((resolvedSession) => {
          expect(resolvedSession).toBe(session);
        }),
        Effect.provide(mockDbConnection(session)),
      );
    },
  );

  it("the retry timeout constant matches Go's fixed 10-second ConnectShadowDatabase literal", () => {
    expect(LEGACY_SHADOW_CONNECT_TIMEOUT_SECONDS).toBe(10);
  });
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
    apiAutoExposeNewTables: Option.some(true),
    vault: [],
  };
}

describe("legacySetupShadowConn", () => {
  it.effect("runs SetupDatabase, then execs CREATE_TEMPLATE when withTemplate is true", () => {
    const { session, calls } = fakeSession();
    const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySetupShadowConn(baseSetupDatabaseInput(session, fs, path, workdir), true);
      expect(calls.some((c) => c.sql === LEGACY_SHADOW_CREATE_TEMPLATE_SQL)).toBe(true);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(BunServices.layer, mockOutput().layer, mockDockerRun(), mockRuntimeInfo()),
      ),
    );
  });

  it.effect("skips CREATE_TEMPLATE when withTemplate is false", () => {
    const { session, calls } = fakeSession();
    const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySetupShadowConn(baseSetupDatabaseInput(session, fs, path, workdir), false);
      expect(calls.some((c) => c.sql === LEGACY_SHADOW_CREATE_TEMPLATE_SQL)).toBe(false);
      rmSync(workdir, { recursive: true, force: true });
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
      const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
      const mock = mockSpawner();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacySetupShadowDatabase(mock.spawner, {
          fs,
          path,
          workdir,
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
        rmSync(workdir, { recursive: true, force: true });
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
      const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
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
        expect(calls.some((c) => c.sql.includes("create table t ()"))).toBe(true);
        rmSync(workdir, { recursive: true, force: true });
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
    "does not resolve JWKS on PG14 even when realtime is enabled (Go's initSchema never reaches ResolveJWKS for MajorVersion <= 14)",
    () => {
      const { session } = fakeSession();
      const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
      const mock = mockSpawner();
      let jwksEvaluated = false;
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* legacySetupShadowDatabase(mock.spawner, {
          fs,
          path,
          workdir,
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
        });
        expect(jwksEvaluated).toBe(false);
        rmSync(workdir, { recursive: true, force: true });
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
    const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
    const mock = mockSpawner();
    let jwksEvaluated = false;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* legacySetupShadowDatabase(mock.spawner, {
        fs,
        path,
        workdir,
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
      rmSync(workdir, { recursive: true, force: true });
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
      const workdir = mkdtempSync(join(tmpdir(), "legacy-shadow-database-"));
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
        rmSync(workdir, { recursive: true, force: true });
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

describe("LEGACY_SHADOW_ENTRYPOINT_ARGS", () => {
  it("matches Go's -c max_worker_processes=0 args exactly", () => {
    expect(LEGACY_SHADOW_ENTRYPOINT_ARGS).toBe("-c max_worker_processes=0");
  });
});
