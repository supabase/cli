import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { StackApi, stackApiLayer } from "../../src/command-internal/stack-api.ts";
import { destroyTestStacks } from "./stack-cleanup.ts";

const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

describe("test stack cleanup", () => {
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
