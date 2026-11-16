import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import * as StackNamespace from "../StackNamespace.ts";

const RETENTION_SECONDS = 11 * 60;

it.effect(
  "pruning a destroyed shell cannot remove directories while its id is being registered",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-registry-prune-" });
        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root })),
          StackNamespace.Service,
        );
        const id = "recreated";
        const directory = path.join(root, id);
        yield* fs.makeDirectory(path.join(directory, "data"), { recursive: true });
        const destroyedAtSeconds = 1_767_225_600;
        yield* fs.utimes(directory, destroyedAtSeconds, destroyedAtSeconds);
        yield* TestClock.setTime((destroyedAtSeconds + RETENTION_SECONDS) * 1000);

        const scope = yield* Effect.scope;
        yield* state.withLock(
          Effect.gen(function* () {
            const pruning = yield* state.pruneDestroyed("other").pipe(Effect.forkIn(scope));
            // The controlled clock moves the prune's lock retries along until it finishes, whether
            // by pruning or by giving up on the busy lock.
            yield* Fiber.await(pruning).pipe(
              Effect.race(TestClock.adjust("50 millis").pipe(Effect.forever)),
            );
            expect(yield* fs.exists(path.join(directory, "data"))).toBe(true);
            yield* state.save({
              id,
              runtime: "native",
              identity: { projectRoot: root, branchContext: "test", stackName: id },
              instances: [],
              lifetime: "detached",
              composition: { members: [], dependencies: [] },
            });
          }),
        );

        expect(yield* fs.exists(path.join(directory, "data"))).toBe(true);
        expect((yield* state.read(id))?.id).toBe(id);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
