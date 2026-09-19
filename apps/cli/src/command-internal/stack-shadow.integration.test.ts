import { StackError, type Stack } from "@supabase/stack/effect";
import { CliConfigSchema } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { DbConnection } from "./db-connection.service.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { stackCatalogSetupLayer } from "./stack-catalog-setup.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import {
  stackAcquireShadowDatabase,
  stackMigrateShadow,
  stackWithShadowDatabase,
} from "./stack-shadow.ts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";

const defaultConfig = Schema.decodeUnknownSync(CliConfigSchema)({});

const recordingApi = (roots: string[], handles: Stack[]) =>
  Layer.effect(
    StackApi,
    Effect.gen(function* () {
      const api = yield* StackApi;
      return StackApi.of({
        ...api,
        create: Effect.fn("ShadowTest.create")((options) =>
          Effect.sync(() => {
            roots.push(options.projectRoot);
          }).pipe(
            Effect.andThen(api.create(options)),
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

const query = Effect.fn("ShadowTest.query")(function* (url: string, sql: string) {
  const connection = parseConnectionString(url);
  if (connection === undefined) return yield* Effect.die("invalid shadow URL");
  const db = yield* DbConnection;
  const session = yield* db.connect(connection, { isLocal: true, dnsResolver: "native" });
  return yield* session.query(sql);
});

describe("stack shadow databases", () => {
  it.live(
    "isolates two fresh databases, replays migrations, and removes each owned namespace",
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
              const [first, second] = yield* Effect.all(
                [
                  stackAcquireShadowDatabase(setup, { runtime: "native" }),
                  stackAcquireShadowDatabase(setup, { runtime: "native" }),
                ],
                { concurrency: "unbounded" },
              );
              expect(first.stack.id).not.toBe(second.stack.id);
              expect(first.database.id).not.toBe(second.database.id);
              expect(first.port).not.toBe(second.port);

              yield* stackMigrateShadow(first, setup);
              expect(yield* query(first.url, "SELECT value FROM public.shadow_probe")).toEqual([
                { value: "migrated" },
              ]);
              expect(
                yield* query(second.url, "SELECT to_regclass('public.shadow_probe') AS table_name"),
              ).toEqual([{ table_name: null }]);
            }),
          );
          for (const shadowRoot of roots) expect(yield* fs.exists(shadowRoot)).toBe(false);
          for (const handle of handles)
            expect(yield* Effect.flip(handle.services.list)).toBeInstanceOf(StackError);
          expect(output.stderrText).not.toContain("Failed to destroy");
          const api = yield* StackApi;
          expect(yield* api.discover({ stateRoot: path.join(root, "stacks") })).toEqual([]);
        }).pipe(Effect.provide(layers));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    120_000,
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
});
