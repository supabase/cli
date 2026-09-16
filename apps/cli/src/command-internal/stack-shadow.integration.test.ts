import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import {
  ContainerEngineResolver,
  EphemeralPostgresError,
  databaseBootstrapIdentity,
  schemaInitArtifactIdentity,
  type CreateEphemeralPostgresOptions,
  type EffectEphemeralPostgres,
  type StackConfig,
} from "@supabase/stack/effect";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import {
  mockCommandSettings,
  useTempWorkdir,
  withEnvVar,
} from "../../tests/helpers/command-mocks.ts";
import { SHADOW_CACHE_ENV } from "./db-bootstrap/shadow-cache.ts";
import { DbConnection } from "./db-connection.service.ts";
import { loadLocalProjectContext } from "./local-project-context.ts";
import { stackBackendLayer } from "./stack-backend.ts";
import {
  StackEphemeralPostgres,
  stackAcquireShadowDatabase,
  stackShadowBaselineTarFileName,
  stackShadowCacheKey,
} from "./stack-shadow.ts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";
import {
  noopStackCatalogSetupLayer,
  recordingStackCatalogSetup,
  StackCatalogSetup,
} from "./stack-catalog-setup.ts";

const tmp = useTempWorkdir("stack-shadow-");
const defaultConfig: CliConfig = Schema.decodeSync(CliConfigSchema)({});
const nativeRuntime = { kind: "native" as const };
const nativeAcquire = { runtime: nativeRuntime };

const mockEphemeral = () => {
  const restores: Array<string | undefined> = [];
  const exports: Array<string> = [];
  const runtimes: Array<CreateEphemeralPostgresOptions["runtime"]> = [];
  const create = (
    options: CreateEphemeralPostgresOptions,
  ): Effect.Effect<EffectEphemeralPostgres> =>
    Effect.sync(() => {
      restores.push(options.restoreFrom);
      runtimes.push(options.runtime);
      return {
        host: "127.0.0.1",
        port: 59999,
        version: "17.6.1",
        runtime: { kind: "native" as const },
        artifactIdentity: "native:17.6.1",
        url: Redacted.make("postgresql://postgres:postgres@127.0.0.1:59999/postgres"),
        start: Effect.void,
        stop: Effect.void,
        exportPgData: (tarPath: string) =>
          Effect.gen(function* () {
            exports.push(tarPath);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(tarPath, "pgdata").pipe(Effect.ignore);
          }),
      };
    });
  return {
    restores,
    exports,
    runtimes,
    layer: Layer.succeed(StackEphemeralPostgres, {
      create,
      resolveRelease: () => Effect.succeed({ version: "17.6.1", image: "postgres:17.6.1" }),
    }),
  };
};

const db = Layer.succeed(DbConnection, {
  connect: () =>
    Effect.succeed({
      exec: () => Effect.void,
      query: () => Effect.succeed([]),
      execBatch: () => Effect.void,
      extensionExists: () => Effect.succeed(false),
      copyToCsv: () => Effect.succeed(new Uint8Array()),
      queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
    }),
});

const input = (fs: FileSystem.FileSystem, path: Path.Path): ShadowSetupInput<never> => ({
  db: { major_version: 17, settings: {} },
  experimental: defaultConfig.experimental,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  networkId: "n",
  image: "stack-ephemeral",
  configImage: "stack-ephemeral",
  shadowPort: 54320,
  password: "postgres",
  projectId: "proj",
  isBitbucketPipeline: false,
  workdir: tmp.current,
  extraHosts: [],
  fs,
  path,
  hostname: "127.0.0.1",
  healthTimeoutSeconds: 2,
  setup: {
    majorVersion: 17,
    config: defaultConfig,
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54320/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: Effect.succeed("{}"),
    apiUrl: "http://127.0.0.1:54321",
    authExternalUrl: undefined,
    siteUrl: "http://127.0.0.1:3000",
    anonKey: "anon",
    serviceRoleKey: "service",
    storageTargetMigration: "",
    realtimeEnabledForSetup: false,
    storageEnabledForSetup: false,
    authEnabledForSetup: false,
    serviceVersionOverrides: {},
    projectEnvValues: undefined,
    debug: false,
    webhooksEnabled: false,
    apiAutoExposeNewTables: Option.none(),
    vault: [],
  },
});

const withShadowCacheHome = <A, E, R>(
  home: string,
  value: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  withEnvVar("SUPABASE_HOME", home, withEnvVar(SHADOW_CACHE_ENV, value, body));

const expectedCacheKey = (
  overrides: Partial<Parameters<typeof stackShadowCacheKey>[0]> = {},
): string =>
  stackShadowCacheKey({
    artifactIdentity: "native:17.6.1",
    majorVersion: 17,
    runtimeKind: "native",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwtExpiry: 3600,
    dbPassword: "postgres",
    dbSettings: {},
    rolesSql: "",
    bootstrapIdentity: databaseBootstrapIdentity,
    webhooksEnabled: false,
    apiGrantsKept: true,
    vault: [],
    jwks: "",
    storageTargetMigration: "",
    authEnabled: false,
    storageEnabled: false,
    realtimeEnabled: false,
    authArtifact: "",
    storageArtifact: "",
    realtimeArtifact: "",
    ...overrides,
  });

const catalogAuthEnabled = (config: StackConfig): boolean => {
  const cap = config.capabilities?.auth;
  return cap === undefined || cap.enabled !== false;
};

const engineResolver = (installed: boolean) =>
  Layer.succeed(ContainerEngineResolver, {
    isInstalled: () => Effect.succeed(installed),
    resolve: () => Effect.die("unused"),
  });

describe("stackAcquireShadowDatabase", () => {
  it.live(
    "exports a stack-shadow-baseline tar on a cold miss and restores it on a warm hit",
    () => {
      const ephemeral = mockEphemeral();
      const out = mockOutput();
      const catalog = recordingStackCatalogSetup((input) => input.target.kind);
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped();
          return yield* withShadowCacheHome(
            home,
            "1",
            Effect.gen(function* () {
              const first = yield* stackAcquireShadowDatabase(input(fs, path), nativeAcquire);
              expect(first.baselinePresent).toBe(false);
              expect(catalog.applied).toEqual(["ephemeral"]);
              expect(first.artifactIdentity).toBe("native:17.6.1");
              expect(ephemeral.restores).toEqual([undefined]);
              expect(ephemeral.exports).toHaveLength(1);
              expect(ephemeral.exports[0]?.endsWith(`.${String(process.pid)}.partial`)).toBe(true);
              const names = (yield* fs.readDirectory(
                path.join(home, "cache", "shadow-baseline"),
              )).filter((name) => name.endsWith(".tar") && !name.includes(".partial"));
              expect(names).toHaveLength(1);
              const info = yield* fs.stat(path.join(home, "cache", "shadow-baseline", names[0]!));
              expect((Number(info.mode) & 0o777).toString(8)).toBe("600");
              expect(names[0]?.startsWith("stack-shadow-baseline-")).toBe(true);
              expect(names[0]).toBe(stackShadowBaselineTarFileName(expectedCacheKey()));

              const warm = yield* stackAcquireShadowDatabase(input(fs, path), nativeAcquire);
              expect(warm.baselinePresent).toBe(true);
              expect(ephemeral.restores[1]?.endsWith(names[0] ?? "")).toBe(true);
              expect(catalog.applied).toEqual(["ephemeral"]);
            }),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            runtimeInfoLayer,
            out.layer,
            db,
            mockCommandSettings({ workdir: tmp.current }),
            stackBackendLayer("stack"),
            ephemeral.layer,
            catalog.layer,
          ),
        ),
      );
    },
  );

  it.live("skips the cache when SUPABASE_SHADOW_CACHE is 0", () => {
    const ephemeral = mockEphemeral();
    const out = mockOutput();
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        return yield* withShadowCacheHome(
          home,
          "0",
          Effect.gen(function* () {
            const handle = yield* stackAcquireShadowDatabase(input(fs, path), nativeAcquire);
            expect(handle.baselinePresent).toBe(false);
            expect(ephemeral.exports).toHaveLength(0);
            const names = yield* fs
              .readDirectory(path.join(home, "cache", "shadow-baseline"))
              .pipe(Effect.orElseSucceed(() => []));
            expect(names.filter((name) => name.endsWith(".tar"))).toEqual([]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          ephemeral.layer,
          noopStackCatalogSetupLayer,
        ),
      ),
    );
  });

  it.live("keeps the cluster uncached when the baseline export fails", () => {
    const restores: Array<string | undefined> = [];
    const out = mockOutput();
    const layer = Layer.succeed(StackEphemeralPostgres, {
      create: (options) =>
        Effect.sync(() => {
          restores.push(options.restoreFrom);
          return {
            host: "127.0.0.1",
            port: 59999,
            version: "17.6.1",
            runtime: { kind: "native" as const },
            artifactIdentity: "native:17.6.1",
            url: Redacted.make("postgresql://postgres:postgres@127.0.0.1:59999/postgres"),
            start: Effect.void,
            stop: Effect.void,
            exportPgData: () =>
              Effect.fail(
                new EphemeralPostgresError({ message: "export failed", reason: "snapshot" }),
              ),
          };
        }),
      resolveRelease: () => Effect.succeed({ version: "17.6.1", image: "postgres:17.6.1" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        return yield* withShadowCacheHome(
          home,
          "1",
          Effect.gen(function* () {
            const handle = yield* stackAcquireShadowDatabase(input(fs, path), nativeAcquire);
            expect(handle.baselinePresent).toBe(false);
            expect(handle.snapshotKey).toBeUndefined();
            expect(restores).toEqual([undefined]);
            expect(out.stderrText).toContain("Warning: shadow baseline not cached:");
            const names = yield* fs
              .readDirectory(path.join(home, "cache", "shadow-baseline"))
              .pipe(Effect.orElseSucceed(() => []));
            expect(
              names.filter((name) => name.endsWith(".tar") && !name.includes(".partial")),
            ).toEqual([]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          layer,
          noopStackCatalogSetupLayer,
        ),
      ),
    );
  });

  it.live("warns and cold-provisions when a cached baseline restore fails", () => {
    const restores: Array<string | undefined> = [];
    const out = mockOutput();
    const layer = Layer.succeed(StackEphemeralPostgres, {
      create: (options) => {
        restores.push(options.restoreFrom);
        if (options.restoreFrom !== undefined)
          return Effect.fail(
            new EphemeralPostgresError({
              message: "restore failed",
              reason: "restore-mismatch",
            }),
          );
        return Effect.succeed({
          host: "127.0.0.1",
          port: 59999,
          version: "17.6.1",
          runtime: { kind: "native" as const },
          artifactIdentity: "native:17.6.1",
          url: Redacted.make("postgresql://postgres:postgres@127.0.0.1:59999/postgres"),
          start: Effect.void,
          stop: Effect.void,
          exportPgData: () => Effect.void,
        });
      },
      resolveRelease: () => Effect.succeed({ version: "17.6.1", image: "postgres:17.6.1" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const cacheDir = path.join(home, "cache", "shadow-baseline");
        yield* fs.makeDirectory(cacheDir, { recursive: true });
        const tarName = stackShadowBaselineTarFileName(expectedCacheKey());
        yield* fs.writeFileString(path.join(cacheDir, tarName), "corrupt");
        return yield* withShadowCacheHome(
          home,
          "1",
          Effect.gen(function* () {
            const handle = yield* stackAcquireShadowDatabase(input(fs, path), nativeAcquire);
            expect(handle.baselinePresent).toBe(false);
            expect(restores).toHaveLength(2);
            expect(restores[0]?.endsWith(tarName)).toBe(true);
            expect(restores[1]).toBeUndefined();
            expect(out.stderrText).toContain("Warning: shadow baseline not cached: restore failed");
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          layer,
          noopStackCatalogSetupLayer,
        ),
      ),
    );
  });

  it.live("stops the cluster when acquire is interrupted during catalog overlay", () => {
    const out = mockOutput();
    return Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let stopped = false;
        const ephemeral = Layer.succeed(StackEphemeralPostgres, {
          create: () =>
            Effect.sync(() => ({
              host: "127.0.0.1",
              port: 59999,
              version: "17.6.1",
              runtime: { kind: "native" as const },
              artifactIdentity: "native:17.6.1",
              url: Redacted.make("postgresql://postgres:postgres@127.0.0.1:59999/postgres"),
              start: Effect.void,
              stop: Effect.sync(() => {
                stopped = true;
              }),
              exportPgData: () => Effect.die("export should not run"),
            })),
          resolveRelease: () => Effect.succeed({ version: "17.6.1", image: "postgres:17.6.1" }),
        });
        const catalog = Layer.succeed(StackCatalogSetup, {
          apply: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const fiber = yield* Effect.forkChild(
          withShadowCacheHome(
            home,
            "0",
            stackAcquireShadowDatabase(input(fs, path), nativeAcquire),
          ).pipe(
            Effect.scoped,
            Effect.provide(
              Layer.mergeAll(
                BunServices.layer,
                runtimeInfoLayer,
                out.layer,
                db,
                mockCommandSettings({ workdir: tmp.current }),
                stackBackendLayer("stack"),
                ephemeral,
                catalog,
              ),
            ),
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(stopped).toBe(true);
      }),
    ).pipe(Effect.provide(BunServices.layer));
  });

  it.live("hashes and creates a docker runtime when Docker is installed", () => {
    const ephemeral = mockEphemeral();
    const out = mockOutput();
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        return yield* withShadowCacheHome(
          home,
          "1",
          Effect.gen(function* () {
            yield* stackAcquireShadowDatabase(input(fs, path));
            expect(ephemeral.runtimes[0]).toEqual({ kind: "container", engine: "docker" });
            const names = (yield* fs.readDirectory(
              path.join(home, "cache", "shadow-baseline"),
            )).filter((name) => name.endsWith(".tar") && !name.includes(".partial"));
            expect(names).toEqual([
              stackShadowBaselineTarFileName(
                expectedCacheKey({
                  artifactIdentity: "container:docker:postgres:17.6.1",
                  runtimeKind: "container:docker",
                }),
              ),
            ]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          ephemeral.layer,
          noopStackCatalogSetupLayer,
          engineResolver(true),
        ),
      ),
    );
  });

  it.live("hashes and creates a native runtime when Docker is not installed", () => {
    const ephemeral = mockEphemeral();
    const out = mockOutput();
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        return yield* withShadowCacheHome(
          home,
          "1",
          Effect.gen(function* () {
            yield* stackAcquireShadowDatabase(input(fs, path));
            expect(ephemeral.runtimes[0]).toEqual({ kind: "native" });
            const names = (yield* fs.readDirectory(
              path.join(home, "cache", "shadow-baseline"),
            )).filter((name) => name.endsWith(".tar") && !name.includes(".partial"));
            expect(names).toEqual([stackShadowBaselineTarFileName(expectedCacheKey())]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          ephemeral.layer,
          noopStackCatalogSetupLayer,
          engineResolver(false),
        ),
      ),
    );
  });

  it.live("overlays remotes-disabled auth onto ephemeral catalog and the cache key", () => {
    const ephemeral = mockEphemeral();
    const out = mockOutput();
    const catalog = recordingStackCatalogSetup((applied) => applied.target.config);
    const remoteRef = "abcdefghijklmnopqrst";
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const scratch = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(scratch, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(scratch, "supabase", "config.toml"),
          [
            'project_id = "stack-shadow-remotes"',
            "[auth]",
            "enabled = true",
            'jwt_secret = "super-secret-jwt-token-with-at-least-32-characters-long"',
            "",
            "[remotes.prod]",
            `project_id = "${remoteRef}"`,
            "[remotes.prod.auth]",
            "enabled = false",
            "",
          ].join("\n"),
        );
        const context = yield* loadLocalProjectContext(
          scratch,
          (message) => new Error(message),
          remoteRef,
        );
        const setup = input(fs, path);
        const remotesInput = {
          ...setup,
          workdir: scratch,
          context,
          setup: { ...setup.setup, authEnabledForSetup: false },
        };
        return yield* withShadowCacheHome(
          home,
          "1",
          Effect.gen(function* () {
            yield* stackAcquireShadowDatabase(remotesInput, nativeAcquire);
            expect(catalog.applied).toHaveLength(1);
            const applied = catalog.applied[0];
            expect(applied).toBeDefined();
            if (applied === undefined) return;
            expect(catalogAuthEnabled(applied)).toBe(false);
            const names = (yield* fs.readDirectory(
              path.join(home, "cache", "shadow-baseline"),
            )).filter((name) => name.endsWith(".tar") && !name.includes(".partial"));
            expect(names).toEqual([
              stackShadowBaselineTarFileName(
                expectedCacheKey({ authEnabled: catalogAuthEnabled(applied) }),
              ),
            ]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          ephemeral.layer,
          catalog.layer,
        ),
      ),
    );
  });

  it.live(
    "still schema-inits auth when remotes enable it and SUPABASE_AUTH_ENABLED is false",
    () => {
      const ephemeral = mockEphemeral();
      const out = mockOutput();
      const catalog = recordingStackCatalogSetup((applied) => applied.target.config);
      const remoteRef = "abcdefghijklmnopqrst";
      const authArtifact = schemaInitArtifactIdentity("auth") ?? "missing";
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped();
          const scratch = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(scratch, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            path.join(scratch, "supabase", "config.toml"),
            [
              'project_id = "stack-shadow-remotes-on"',
              "[auth]",
              "enabled = true",
              'jwt_secret = "super-secret-jwt-token-with-at-least-32-characters-long"',
              "",
              "[remotes.prod]",
              `project_id = "${remoteRef}"`,
              "[remotes.prod.auth]",
              "enabled = true",
              "",
            ].join("\n"),
          );
          yield* fs.writeFileString(
            path.join(scratch, "supabase", ".env"),
            "SUPABASE_AUTH_ENABLED=false\n",
          );
          const context = yield* loadLocalProjectContext(
            scratch,
            (message) => new Error(message),
            remoteRef,
          );
          const setup = input(fs, path);
          const remotesInput = {
            ...setup,
            workdir: scratch,
            context,
            setup: { ...setup.setup, authEnabledForSetup: true },
          };
          return yield* withShadowCacheHome(
            home,
            "1",
            Effect.gen(function* () {
              yield* stackAcquireShadowDatabase(remotesInput, nativeAcquire);
              expect(catalog.applied).toHaveLength(1);
              const applied = catalog.applied[0];
              expect(applied).toBeDefined();
              if (applied === undefined) return;
              expect(catalogAuthEnabled(applied)).toBe(true);
              const names = (yield* fs.readDirectory(
                path.join(home, "cache", "shadow-baseline"),
              )).filter((name) => name.endsWith(".tar") && !name.includes(".partial"));
              expect(names).toEqual([
                stackShadowBaselineTarFileName(
                  expectedCacheKey({
                    authEnabled: catalogAuthEnabled(applied),
                    authArtifact,
                  }),
                ),
              ]);
            }),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            runtimeInfoLayer,
            out.layer,
            db,
            mockCommandSettings({ workdir: tmp.current }),
            stackBackendLayer("stack"),
            ephemeral.layer,
            catalog.layer,
          ),
        ),
      );
    },
  );
});
