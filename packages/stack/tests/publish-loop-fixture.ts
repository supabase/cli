import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer } from "effect";
import * as StackNamespace from "../src/StackNamespace.ts";

const [root, id] = process.argv.slice(2);
if (root === undefined || id === undefined) throw new Error("Registry root or stack id missing");

/**
 * Publishes one revision of the saved stack, announcing readiness on stdout the instant it is
 * about to replace the target document (the real staging-to-publish boundary Publication.publish
 * uses), then hangs so a caller can kill this process exactly there on every run.
 */
const barrierFs = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      ...fs,
      rename: () => Console.log("about-to-publish").pipe(Effect.andThen(Effect.never)),
    };
  }),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const state = yield* StackNamespace.Service;
    const saved = yield* state.read(id);
    if (saved === undefined) return yield* Effect.die(`Stack ${id} is not registered`);
    yield* state.save({ ...saved, identity: { ...saved.identity, stackName: "revision-1" } });
  }),
).pipe(
  Effect.provide(
    StackNamespace.layer({ root }).pipe(
      Layer.provide(barrierFs),
      Layer.provide(NodeServices.layer),
    ),
  ),
);

await Effect.runPromise(program);
