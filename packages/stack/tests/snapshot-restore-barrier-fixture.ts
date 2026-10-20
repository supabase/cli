import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer, Path, Ref } from "effect";
import { schemaWritersFile } from "../src/internal/schema-writers.ts";
import { makeDatabaseSnapshots } from "../src/services/DatabaseSnapshot.ts";
import { selection } from "./pins.ts";

const [instanceRoot, cacheRoot, key, window] = process.argv.slice(2);
if (
  instanceRoot === undefined ||
  cacheRoot === undefined ||
  key === undefined ||
  (window !== "before-data" && window !== "before-record")
)
  throw new Error("instanceRoot, cacheRoot, key or a before-data/before-record window missing");

/**
 * Restores a snapshot with the production store. It announces `barrier` on stdout the instant it
 * is about to cross the restore step named by `window` (publishing the data, or setting the record
 * to the snapshot's), then hangs so a caller can kill this process at that boundary on every run.
 */
const barrierFs = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recordPublications = yield* Ref.make(0);
    const data = path.join(instanceRoot, "data");
    const record = path.join(instanceRoot, schemaWritersFile);
    const atBarrier = (to: string) =>
      window === "before-data"
        ? Effect.succeed(to === data)
        : to === record
          ? Ref.updateAndGet(recordPublications, (count) => count + 1).pipe(
              // The first publication raises the record, the second sets it to the snapshot's.
              Effect.map((count) => count === 2),
            )
          : Effect.succeed(false);
    return {
      ...fs,
      rename: (from: string, to: string) =>
        atBarrier(to).pipe(
          Effect.flatMap((reached) =>
            reached
              ? Console.log("barrier").pipe(Effect.andThen(Effect.never))
              : fs.rename(from, to),
          ),
        ),
    };
  }),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const snapshots = yield* makeDatabaseSnapshots({
      instanceRoot,
      cacheRoot,
      runtime: "native",
      pin: selection.database,
    });
    yield* snapshots.restoreSnapshot(key);
  }),
).pipe(Effect.provide(barrierFs.pipe(Layer.provideMerge(NodeServices.layer))));

await Effect.runPromise(program);
