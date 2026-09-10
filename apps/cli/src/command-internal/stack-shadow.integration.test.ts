import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import {
  EphemeralPostgresError,
  type CreateEphemeralPostgresOptions,
  type EffectEphemeralPostgres,
} from "@supabase/stack/effect";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  useTempWorkdir,
  withEnvVar,
} from "../../tests/helpers/command-mocks.ts";
import { SHADOW_CACHE_ENV } from "./db-bootstrap/shadow-cache.ts";
import { DbConnection } from "./db-connection.service.ts";
import { stackBackendLayer } from "../commands/experimental/stack/stack-backend.ts";
import {
  StackEphemeralPostgres,
  stackAcquireShadowDatabase,
  stackShadowBaselineTarFileName,
  stackShadowCacheKey,
} from "./stack-shadow.ts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";

const tmp = useTempWorkdir("stack-shadow-");
const defaultConfig: CliConfig = Schema.decodeSync(CliConfigSchema)({});

const mockEphemeral = () => {
  const restores: Array<string | undefined> = [];
  const exports: Array<string> = [];
  const create = (
    options: CreateEphemeralPostgresOptions,
  ): Effect.Effect<EffectEphemeralPostgres> =>
    Effect.sync(() => {
      restores.push(options.restoreFrom);
      return {
        host: "127.0.0.1",
        port: 59999,
        version: "17.6.1",
        runtime: { kind: "native" as const },
        artifactIdentity: "native:17.6.1",
        url: Redacted.make("postgresql://postgres:postgres@127.0.0.1:59999/postgres"),
        start: () => Effect.void,
        stop: () => Effect.void,
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

describe("stackAcquireShadowDatabase", () => {
  it.live(
    "exports a stack-shadow-baseline tar on a cold miss and restores it on a warm hit",
    () => {
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
              const first = yield* stackAcquireShadowDatabase(input(fs, path));
              expect(first.baselinePresent).toBe(false);
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
              expect(names[0]).toBe(
                stackShadowBaselineTarFileName(
                  stackShadowCacheKey({
                    artifactIdentity: "native:17.6.1",
                    majorVersion: 17,
                    runtimeKind: "native",
                    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
                    jwtExpiry: 3600,
                    dbPassword: "postgres",
                    dbSettings: {},
                    rolesSql: "",
                  }),
                ),
              );

              const warm = yield* stackAcquireShadowDatabase(input(fs, path));
              expect(warm.baselinePresent).toBe(true);
              expect(ephemeral.restores[1]?.endsWith(names[0] ?? "")).toBe(true);
            }),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            out.layer,
            db,
            mockCommandSettings({ workdir: tmp.current }),
            stackBackendLayer("stack"),
            ephemeral.layer,
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
            const handle = yield* stackAcquireShadowDatabase(input(fs, path));
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
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          ephemeral.layer,
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
            start: () => Effect.void,
            stop: () => Effect.void,
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
            const handle = yield* stackAcquireShadowDatabase(input(fs, path));
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
          out.layer,
          db,
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          layer,
        ),
      ),
    );
  });
});
