import { StackError, type Stack } from "@supabase/stack/effect";
import { CliConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { DbConnection } from "./db-connection.service.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { StackCatalogSetup, stackCatalogSetupLayer } from "./stack-catalog-setup.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import {
  stackAcquireShadowDatabase,
  stackMigrateShadow,
  stackWithShadowDatabase,
} from "./stack-shadow.ts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";

const defaultConfig = Schema.decodeUnknownSync(CliConfigSchema)({});

const recordingApi = (
  roots: string[],
  handles: Stack[],
  restoreFailures = 0,
  warmReadyFailures = 0,
) =>
  Layer.effect(
    StackApi,
    Effect.gen(function* () {
      const api = yield* StackApi;
      const failures = yield* Ref.make(restoreFailures);
      const readyFailures = yield* Ref.make(warmReadyFailures);
      return StackApi.of({
        ...api,
        create: Effect.fn("ShadowTest.create")((options) =>
          Effect.sync(() => roots.push(options.projectRoot)).pipe(
            Effect.andThen(api.create(options)),
            Effect.map((stack) => ({
              ...stack,
              services: {
                ...stack.services,
                create: Effect.fn("ShadowTest.createService")((creation) =>
                  stack.services.create(creation).pipe(
                    Effect.flatMap((instance) => {
                      if (instance.service !== "database") return Effect.succeed(instance);
                      return Effect.gen(function* () {
                        const restored = yield* Ref.make(false);
                        return {
                          ...instance,
                          ready: Effect.gen(function* () {
                            if (yield* Ref.get(restored)) {
                              const remaining = yield* Ref.getAndUpdate(readyFailures, (value) =>
                                Math.max(0, value - 1),
                              );
                              if (remaining > 0)
                                return yield* new StackError({
                                  operation: "ready",
                                  message: "injected ready failure",
                                });
                            }
                            yield* instance.ready;
                          }),
                          restoreSnapshot: (key: string) =>
                            Effect.gen(function* () {
                              const remaining = yield* Ref.getAndUpdate(failures, (value) =>
                                Math.max(0, value - 1),
                              );
                              if (remaining > 0)
                                return yield* new StackError({
                                  operation: "restoreSnapshot",
                                  message: "injected restore failure",
                                });
                              const restoredSnapshot = yield* instance.restoreSnapshot(key);
                              yield* Ref.set(restored, restoredSnapshot);
                              return restoredSnapshot;
                            }),
                        };
                      });
                    }),
                  ),
                ),
              },
            })),
            Effect.tap((stack) =>
              Effect.sync(() => {
                handles.push(stack);
              }),
            ),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(stackApiLayer), Layer.provide(BunServices.layer));
const input = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  setupOverrides: Partial<ShadowSetupInput<never>["setup"]> = {},
): ShadowSetupInput<never> => ({
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
  workdir,
  extraHosts: [],
  fs,
  path,
  hostname: "127.0.0.1",
  healthTimeoutSeconds: 60,
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
    ...setupOverrides,
  },
});

const query = Effect.fn("ShadowTest.query")(function* (url: string, sql: string) {
  const connection = parseConnectionString(url);
  if (connection === undefined) return yield* Effect.die("invalid shadow URL");
  const db = yield* DbConnection;
  const session = yield* db.connect(connection, { isLocal: true, dnsResolver: "native" });
  return yield* session.query(sql);
});

describe("stack shadow databases", () => {
  it.live(
    "publishes and restores a baseline while keeping migrations and ownership isolated",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shadow-test-" });
        yield* fs.makeDirectory(path.join(root, "supabase", "migrations"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "supabase", "migrations", "20260919000000_shadow.sql"),
          "CREATE TABLE public.shadow_probe(value text); INSERT INTO public.shadow_probe VALUES ('migrated');",
        );
        const output = mockOutput();
        const roots: string[] = [];
        const handles: Stack[] = [];
        const layers = Layer.mergeAll(
          recordingApi(roots, handles),
          stackCatalogSetupLayer,
          dbConnectionLayer,
          runtimeInfoLayer,
          mockCommandSettings({ workdir: root, supabaseHome: root }),
          output.layer,
        );
        yield* Effect.gen(function* () {
          const setup = input(fs, path, root);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cold = yield* stackAcquireShadowDatabase(setup, { runtime: "native" });
              expect(cold.restoredFromSnapshot).toBe(false);
              expect(cold.snapshotKey).toMatch(/^[0-9a-f]{16}$/u);
              expect(
                yield* query(cold.url, "SELECT rolname FROM pg_roles WHERE rolname = 'anon'"),
              ).toEqual([{ rolname: "anon" }]);
              expect(
                yield* query(cold.url, "SELECT to_regclass('public.shadow_probe') AS table_name"),
              ).toEqual([{ table_name: null }]);
              yield* stackMigrateShadow(cold, setup);
              expect(yield* query(cold.url, "SELECT value FROM public.shadow_probe")).toEqual([
                { value: "migrated" },
              ]);
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const warm = yield* stackAcquireShadowDatabase(setup, { runtime: "native" });
              expect(warm.restoredFromSnapshot).toBe(true);
              expect(warm.snapshotKey).toMatch(/^[0-9a-f]{16}$/u);
              expect(warm.snapshotKey).toBeDefined();
              expect(
                yield* query(warm.url, "SELECT rolname FROM pg_roles WHERE rolname = 'anon'"),
              ).toEqual([{ rolname: "anon" }]);
              expect(
                yield* query(warm.url, "SELECT to_regclass('public.shadow_probe') AS table_name"),
              ).toEqual([{ table_name: null }]);
              yield* stackMigrateShadow(warm, setup);
              expect(yield* query(warm.url, "SELECT value FROM public.shadow_probe")).toEqual([
                { value: "migrated" },
              ]);
            }),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const concurrentSetup = { ...setup, password: "parallel-postgres" };
              const catalog = yield* StackCatalogSetup;
              const arrivals = yield* Ref.make(0);
              const gate = yield* Deferred.make<void>();
              const barrierCatalog = StackCatalogSetup.of({
                ...catalog,
                apply: (catalogInput) =>
                  Effect.gen(function* () {
                    const count = yield* Ref.updateAndGet(arrivals, (value) => value + 1);
                    if (count === 2) yield* Deferred.succeed(gate, undefined);
                    else yield* Deferred.await(gate);
                    yield* catalog.apply(catalogInput);
                  }),
              });
              const [first, second] = yield* Effect.all(
                [
                  stackAcquireShadowDatabase(concurrentSetup, { runtime: "native" }).pipe(
                    Effect.provideService(StackCatalogSetup, barrierCatalog),
                  ),
                  stackAcquireShadowDatabase(concurrentSetup, { runtime: "native" }).pipe(
                    Effect.provideService(StackCatalogSetup, barrierCatalog),
                  ),
                ],
                { concurrency: "unbounded" },
              );
              expect(first.stack.id).not.toBe(second.stack.id);
              expect(first.database.id).not.toBe(second.database.id);
              expect(first.port).not.toBe(second.port);
              for (const handle of [first, second]) {
                const status = yield* handle.database.status;
                const sql = status.endpoints.find((endpoint) => endpoint.name === "sql");
                if (sql === undefined) return yield* Effect.die("missing SQL endpoint");
                const credentials = yield* handle.database.credentials({ from: "host" });
                if (credentials.databaseUrl === undefined)
                  return yield* Effect.die("missing database credentials");
                const connection = parseConnectionString(credentials.databaseUrl);
                if (connection === undefined) return yield* Effect.die("invalid database URL");
                expect(sql.port).toBe(handle.port);
                expect(connection.port).toBe(sql.port);
              }
              expect(first.restoredFromSnapshot).toBe(false);
              expect(second.restoredFromSnapshot).toBe(false);
              const publishedKeys = [first.snapshotKey, second.snapshotKey].filter(
                (key): key is string => key !== undefined,
              );
              expect(publishedKeys).toHaveLength(2);
              expect(publishedKeys[0]).toMatch(/^[0-9a-f]{16}$/u);
              expect(publishedKeys[1]).toBe(publishedKeys[0]);
            }),
          );

          const recoveredKey = yield* Effect.scoped(
            Effect.gen(function* () {
              const recovered = yield* stackAcquireShadowDatabase(setup, { runtime: "native" });
              expect(recovered.restoredFromSnapshot).toBe(true);
              expect(recovered.snapshotKey).toBeDefined();
              expect(
                yield* query(recovered.url, "SELECT rolname FROM pg_roles WHERE rolname = 'anon'"),
              ).toEqual([{ rolname: "anon" }]);
              expect(
                yield* query(
                  recovered.url,
                  "SELECT to_regclass('public.shadow_probe') AS table_name",
                ),
              ).toEqual([{ table_name: null }]);
              return recovered.snapshotKey;
            }),
          );
          if (recoveredKey === undefined) return yield* Effect.die("missing recovery key");

          yield* fs.writeFileString(
            path.join(root, "supabase", "roles.sql"),
            "CREATE ROLE cache_probe;\n",
          );
          const rolesKey = yield* Effect.scoped(
            Effect.gen(function* () {
              const rolesChanged = yield* stackAcquireShadowDatabase(setup, { runtime: "native" });
              expect(rolesChanged.restoredFromSnapshot).toBe(false);
              expect(rolesChanged.snapshotKey).toBeDefined();
              expect(rolesChanged.snapshotKey).not.toBe(recoveredKey);
              expect(
                yield* query(
                  rolesChanged.url,
                  "SELECT rolname FROM pg_roles WHERE rolname = 'cache_probe'",
                ),
              ).toEqual([{ rolname: "cache_probe" }]);
              return rolesChanged.snapshotKey;
            }),
          );
          if (rolesKey === undefined) return yield* Effect.die("missing roles key");
          for (const shadowRoot of roots) expect(yield* fs.exists(shadowRoot)).toBe(false);
          for (const handle of handles)
            expect(yield* Effect.flip(handle.services.list)).toBeInstanceOf(StackError);
          expect(output.stderrText).not.toContain("Failed to destroy");
          const api = yield* StackApi;
          expect(yield* api.discover({ stateRoot: path.join(root, "stacks") })).toEqual([]);
        }).pipe(Effect.provide(layers));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    420_000,
  );

  it.live(
    "bypasses and disables the cache without publication or restoration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shadow-cache-gate-" });
        const output = mockOutput();
        const roots: string[] = [];
        const handles: Stack[] = [];
        const layers = Layer.mergeAll(
          recordingApi(roots, handles),
          stackCatalogSetupLayer,
          dbConnectionLayer,
          runtimeInfoLayer,
          mockCommandSettings({ workdir: root, supabaseHome: root }),
          output.layer,
        );
        yield* Effect.gen(function* () {
          const setup = input(fs, path, root);
          yield* Effect.scoped(stackAcquireShadowDatabase(setup, { runtime: "native" }));

          const bypassed = yield* Effect.scoped(
            stackAcquireShadowDatabase(setup, { runtime: "native", bypassCache: true }),
          );
          expect(bypassed.restoredFromSnapshot).toBe(false);
          expect(bypassed.snapshotKey).toBeUndefined();

          const optOut = input(fs, path, root, {
            projectEnvValues: { SUPABASE_SHADOW_CACHE: "0" },
          });
          const disabled = yield* Effect.scoped(
            stackAcquireShadowDatabase(optOut, { runtime: "native" }),
          );
          expect(disabled.restoredFromSnapshot).toBe(false);
          expect(disabled.snapshotKey).toBeUndefined();
        }).pipe(Effect.provide(layers));
        for (const shadowRoot of roots) expect(yield* fs.exists(shadowRoot)).toBe(false);
        expect(output.stderrText).not.toContain("Failed to destroy");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    180_000,
  );

  it.live(
    "recreates and republishes after a restored database fails readiness",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-shadow-restore-fallback-",
        });
        const output = mockOutput();
        const setup = input(fs, path, root);
        const roots: string[] = [];
        const handles: Stack[] = [];
        const layers = Layer.mergeAll(
          recordingApi(roots, handles, 0, 1),
          stackCatalogSetupLayer,
          dbConnectionLayer,
          runtimeInfoLayer,
          mockCommandSettings({ workdir: root, supabaseHome: root }),
          output.layer,
        );
        yield* Effect.gen(function* () {
          const first = yield* Effect.scoped(
            stackAcquireShadowDatabase(setup, { runtime: "native" }),
          );
          expect(first.restoredFromSnapshot).toBe(false);
          const recoveredKey = yield* Effect.scoped(
            Effect.gen(function* () {
              const recovered = yield* stackAcquireShadowDatabase(setup, { runtime: "native" });
              expect(recovered.restoredFromSnapshot).toBe(false);
              expect(recovered.snapshotKey).toBeDefined();
              const status = yield* recovered.database.status;
              const sql = status.endpoints.find((endpoint) => endpoint.name === "sql");
              if (sql === undefined) return yield* Effect.die("missing SQL endpoint");
              const credentials = yield* recovered.database.credentials({ from: "host" });
              if (credentials.databaseUrl === undefined)
                return yield* Effect.die("missing database credentials");
              const connection = parseConnectionString(credentials.databaseUrl);
              if (connection === undefined) return yield* Effect.die("invalid database URL");
              expect(sql.port).toBe(recovered.port);
              expect(connection.port).toBe(sql.port);
              expect(yield* query(recovered.url, "SELECT 1 AS ready")).toEqual([{ ready: 1 }]);
              return recovered.snapshotKey;
            }),
          );
          expect(output.stderrText).toContain("cached stack shadow baseline unusable");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const warm = yield* stackAcquireShadowDatabase(setup, { runtime: "native" });
              expect(warm.restoredFromSnapshot).toBe(true);
              expect(warm.snapshotKey).toBe(recoveredKey);
              expect(yield* query(warm.url, "SELECT 1 AS ready")).toEqual([{ ready: 1 }]);
            }),
          );
        }).pipe(Effect.provide(layers));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    180_000,
  );

  it.live(
    "destroys a shadow when its consumer fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shadow-failure-" });
        const output = mockOutput();
        const roots: string[] = [];
        const handles: Stack[] = [];
        const result = yield* stackWithShadowDatabase(
          input(fs, path, root),
          (_handle) =>
            Effect.gen(function* () {
              return yield* Effect.fail("consumer failed");
            }),
          { runtime: "native" },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              recordingApi(roots, handles),
              stackCatalogSetupLayer,
              dbConnectionLayer,
              runtimeInfoLayer,
              mockCommandSettings({ workdir: root, supabaseHome: root }),
              output.layer,
            ),
          ),
          Effect.flip,
        );
        expect(result).toBe("consumer failed");
        for (const handle of handles)
          expect(yield* Effect.flip(handle.services.list)).toBeInstanceOf(StackError);
        expect(output.stderrText).not.toContain("Failed to destroy");
        expect(roots).toHaveLength(1);
        for (const root of roots) expect(yield* fs.exists(root)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    120_000,
  );

  it.live("prints the cleanup commands when a shadow's destroy skips its engine", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-shadow-skipped-" });
      const output = mockOutput();
      const cleanupCommand = "docker rm --force $(docker ps --all --quiet)";
      // A real registration whose database creation fails fast and whose destroy reports skipped cleanup.
      const api = Layer.effect(
        StackApi,
        Effect.gen(function* () {
          const real = yield* StackApi;
          return StackApi.of({
            ...real,
            create: (options) =>
              real.create(options).pipe(
                Effect.map((stack) => ({
                  ...stack,
                  services: {
                    ...stack.services,
                    create: () =>
                      Effect.fail(new StackError({ operation: "create", message: "injected" })),
                  },
                  destroy: Effect.succeed({
                    runtimeCleanup: "skipped",
                    engine: "docker",
                    cleanupCommands: [cleanupCommand],
                  } as const),
                })),
              ),
          });
        }),
      ).pipe(Layer.provide(stackApiLayer), Layer.provide(BunServices.layer));

      yield* stackWithShadowDatabase(input(fs, path, root), () => Effect.void, {
        runtime: "native",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            api,
            stackCatalogSetupLayer,
            dbConnectionLayer,
            runtimeInfoLayer,
            mockCommandSettings({ workdir: root, supabaseHome: root }),
            output.layer,
          ),
        ),
        Effect.flip,
      );

      expect(output.stderrText).toMatch(
        /Warning: Docker was unavailable, so Docker resources for shadow stack [0-9a-f]{64} were not removed\. Once it is running, remove them with:\n {2}docker rm --force \$\(docker ps --all --quiet\)\n/u,
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
