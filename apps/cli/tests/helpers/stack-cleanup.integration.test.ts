import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Redacted } from "effect";
import { tmpdir } from "node:os";
import { StackApi, stackApiLayer } from "../../src/command-internal/stack-api.ts";
import { destroyTestStacks } from "./stack-cleanup.ts";
import { destroyTestStack } from "../../../../packages/stack/tests/stack-cleanup.ts";

const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

const database = {
  service: "database" as const,
  config: {
    version: "17",
    databasePassword: Redacted.make("stack-cleanup-password"),
    jwtSecret: Redacted.make("stack-cleanup-jwt-secret-at-least-thirty-two-characters"),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: "auto" as const } },
};

describe("test stack cleanup", () => {
  it.live(
    "stops the owner when destroy fails after a real service exists",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-cleanup-" });
          const stateRoot = path.join(root, "stacks");
          const cacheRoot = path.join(tmpdir(), "supabase-stack-artifacts");
          const api = yield* StackApi;
          const stack = yield* api.create({
            projectRoot: root,
            stateRoot,
            cacheRoot,
            runtime: "native",
          });
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const remaining = yield* api.discover({ stateRoot });
              yield* Effect.forEach(
                remaining.filter(({ host }) => host !== undefined),
                ({ definition }) =>
                  api
                    .open({ id: definition.id, stateRoot, cacheRoot })
                    .pipe(Effect.flatMap((owned) => owned.stop)),
                { discard: true },
              );
            }).pipe(Effect.orDie),
          );
          const result = yield* Effect.exit(
            Effect.acquireUseRelease(
              Effect.succeed(stack),
              (owned) =>
                Effect.gen(function* () {
                  const [instance] = yield* owned.composition.supabase([database]);
                  if (instance === undefined) return yield* Effect.die("database was not composed");
                  const marker = path.join(
                    stateRoot,
                    owned.id,
                    "data",
                    instance.id,
                    ".supabase-database-owner.json",
                  );
                  yield* fs.makeDirectory(path.dirname(marker), { recursive: true });
                  yield* fs.writeFileString(
                    marker,
                    JSON.stringify({ stackId: "wrong", instanceId: instance.id }),
                  );
                  const before = yield* api.discover({ stateRoot });
                  expect(before).toHaveLength(1);
                  expect(before[0]?.host).toBeDefined();
                }),
              destroyTestStack,
            ),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              "Database root belongs to another instance",
            );
          const discovered = yield* api.discover({ stateRoot });
          expect(discovered).toHaveLength(1);
          expect(discovered[0]?.host).toBeUndefined();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, liveStackApi))),
    { timeout: 30_000 },
  );

  it.live(
    "cleans a host after the first startup operation fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-cleanup-startup-" });
          const stateRoot = path.join(root, "stacks");
          const cacheRoot = path.join(root, "cache");
          const api = yield* StackApi;
          const stack = yield* api.create({
            projectRoot: root,
            stateRoot,
            cacheRoot,
            runtime: "native",
          });
          const result = yield* Effect.exit(
            Effect.acquireUseRelease(
              Effect.succeed(undefined),
              () =>
                Effect.gen(function* () {
                  yield* stack.services.create({ service: "mail", config: {}, endpoints: {} });
                  const before = yield* api.discover({ stateRoot });
                  expect(before).toHaveLength(1);
                  expect(before[0]?.host).toBeDefined();
                  return yield* Effect.die("startup failed");
                }),
              () => destroyTestStacks(api, stateRoot, cacheRoot),
            ),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("startup failed");
          const discovered = yield* api.discover({ stateRoot });
          expect(discovered).toHaveLength(0);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, liveStackApi))),
    { timeout: 30_000 },
  );
});
