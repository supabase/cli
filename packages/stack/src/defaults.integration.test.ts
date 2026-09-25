import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { tmpdir } from "node:os";
import { DEFAULT_LOCAL_JWT_SECRET, DEFAULT_POSTGRES_ROOT_KEY } from "./Defaults.ts";
import { create as createEffect, StackError } from "./effect.ts";
import { create as createPromise } from "./index.ts";

const artifactCacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
const effectLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

const effectDatabaseConfig = {
  version: "17",
  databasePassword: Redacted.make("defaults-test-password"),
  jwtExpiry: 3600,
} as const;

const promiseDatabaseConfig = {
  version: "17",
  databasePassword: "defaults-test-password",
  jwtExpiry: 3600,
} as const;

const redactedValue = (value: Redacted.Redacted<string> | undefined) => {
  if (value === undefined) throw new Error("Expected a redacted value");
  return Redacted.value(value);
};

describe("database configuration defaults", { timeout: 180_000 }, () => {
  it.live("normalizes defaults through the Effect API across create, compose, and restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-effect-defaults-" });
        yield* Effect.acquireUseRelease(
          createEffect({
            projectRoot: root,
            stateRoot: `${root}/state`,
            cacheRoot: artifactCacheRoot,
            runtime: "native",
          }),
          (current) =>
            Effect.gen(function* () {
              const database = yield* current.services.create({
                service: "database",
                config: effectDatabaseConfig,
              });
              const initial = yield* database.status;
              if (initial.config.service !== "database")
                return yield* Effect.die("Expected a database status");
              expect(redactedValue(initial.config.config.jwtSecret)).toBe(DEFAULT_LOCAL_JWT_SECRET);
              expect(redactedValue(initial.config.config.rootKey)).toBe(DEFAULT_POSTGRES_ROOT_KEY);

              yield* database.restart({ config: effectDatabaseConfig });
              yield* database.ready;
              const restarted = yield* database.status;
              if (restarted.config.service !== "database")
                return yield* Effect.die("Expected a restarted database status");
              expect(redactedValue(restarted.config.config.jwtSecret)).toBe(
                DEFAULT_LOCAL_JWT_SECRET,
              );
              expect(redactedValue(restarted.config.config.rootKey)).toBe(
                DEFAULT_POSTGRES_ROOT_KEY,
              );

              const customJwt = Redacted.make("custom-defaults-jwt");
              const customRoot = Redacted.make("b".repeat(64));
              const conflict = yield* Effect.flip(
                database.restart({
                  config: { ...effectDatabaseConfig, jwtSecret: customJwt, rootKey: customRoot },
                }),
              );
              expect(conflict.message).toContain("conflicts with the saved stack value");
              yield* database.destroy;
              const composed = yield* current.composition.supabase([
                { service: "database", config: effectDatabaseConfig },
              ]);
              const composedStatus = yield* composed[0]!.status;
              if (composedStatus.config.service !== "database")
                return yield* Effect.die("Expected a composed database status");
              expect(redactedValue(composedStatus.config.config.jwtSecret)).toBe(
                DEFAULT_LOCAL_JWT_SECRET,
              );
              expect(redactedValue(composedStatus.config.config.rootKey)).toBe(
                DEFAULT_POSTGRES_ROOT_KEY,
              );
            }),
          (current) => current.destroy,
        );
      }),
    ).pipe(Effect.provide(effectLayer)),
  );

  it.live("normalizes defaults through the Promise API across create, compose, and restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-promise-defaults-" });
        const promise = <A>(run: () => Promise<A>) =>
          Effect.tryPromise({
            try: run,
            catch: (cause) =>
              new StackError({
                operation: "promise-test",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
        yield* Effect.acquireUseRelease(
          promise(() =>
            createPromise({
              projectRoot: root,
              stateRoot: `${root}/state`,
              cacheRoot: artifactCacheRoot,
              runtime: "native",
            }),
          ),
          (current) =>
            Effect.gen(function* () {
              const database = yield* promise(() =>
                current.services.create({
                  service: "database",
                  config: promiseDatabaseConfig,
                }),
              );
              const initial = yield* promise(() => database.status());
              expect(initial.config.service).toBe("database");
              if (initial.config.service !== "database")
                return yield* Effect.die("Expected a database status");
              expect(redactedValue(initial.config.config.jwtSecret)).toBe(DEFAULT_LOCAL_JWT_SECRET);
              expect(redactedValue(initial.config.config.rootKey)).toBe(DEFAULT_POSTGRES_ROOT_KEY);

              yield* promise(() => database.restart({ config: promiseDatabaseConfig }));
              yield* promise(() => database.ready());
              const restarted = yield* promise(() => database.status());
              expect(restarted.config.service).toBe("database");
              if (restarted.config.service !== "database")
                return yield* Effect.die("Expected a restarted database status");
              expect(redactedValue(restarted.config.config.jwtSecret)).toBe(
                DEFAULT_LOCAL_JWT_SECRET,
              );
              expect(redactedValue(restarted.config.config.rootKey)).toBe(
                DEFAULT_POSTGRES_ROOT_KEY,
              );

              const conflict = yield* Effect.flip(
                promise(() =>
                  database.restart({
                    config: {
                      ...promiseDatabaseConfig,
                      jwtSecret: "custom-defaults-jwt",
                      rootKey: "c".repeat(64),
                    },
                  }),
                ),
              );
              expect(conflict.message).toContain("conflicts with the saved stack value");
              yield* promise(() => database.destroy());
              const composed = yield* promise(() =>
                current.composition.supabase([
                  { service: "database", config: promiseDatabaseConfig },
                ]),
              );
              const composedStatus = yield* promise(() => composed[0]!.status());
              expect(composedStatus.config.service).toBe("database");
              if (composedStatus.config.service !== "database")
                return yield* Effect.die("Expected a composed database status");
              expect(redactedValue(composedStatus.config.config.jwtSecret)).toBe(
                DEFAULT_LOCAL_JWT_SECRET,
              );
              expect(redactedValue(composedStatus.config.config.rootKey)).toBe(
                DEFAULT_POSTGRES_ROOT_KEY,
              );
            }),
          (current) =>
            Effect.acquireUseRelease(
              Effect.succeed(current),
              (stack) => promise(() => stack.destroy()),
              (stack) => promise(() => stack.close()),
            ),
        );
      }),
    ).pipe(Effect.provide(effectLayer)),
  );
});
