import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer, Path } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { ChildProcessSpawner } from "effect/process";
import { slimImageMirrors } from "../src/Artifacts.ts";
import { makeContainerRuntime } from "../src/runtime/Container.ts";
import { makeDockerDatabaseStorage } from "../src/storage/DockerDatabaseStorage.ts";
import { selection } from "./pins.ts";

const [instanceRoot, root, cacheRoot] = process.argv.slice(2);
if (instanceRoot === undefined || root === undefined || cacheRoot === undefined)
  throw new Error("instanceRoot, root or cacheRoot missing");

/**
 * Announces readiness on stdout the instant it is about to replace the storage marker (the real
 * staging-to-publish boundary Publication.publish uses), then hangs so a caller can kill this
 * process exactly there on every run.
 */
const barrierFs = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      ...fs,
      rename: (from: string, to: string) =>
        to.endsWith(".supabase-database-storage.json")
          ? Console.log("about-to-publish").pipe(Effect.andThen(Effect.never))
          : fs.rename(from, to),
    };
  }),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* SecureRandom.SecureRandom;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Matches the caller's own target exactly, so this fixture's identity agrees with the
    // marker the caller's `prepare` already published through it.
    const target = { engine: "docker" as const, argv: [], daemonId: "test-daemon-id" };
    const container = yield* makeContainerRuntime({
      target,
      root: instanceRoot,
      imageMirrors: slimImageMirrors,
    });
    const storage = yield* makeDockerDatabaseStorage({
      runtime: "docker",
      target,
      stackId: "storage-crash-test",
      instanceId: "crash",
      instanceRoot,
      root,
      cacheRoot,
      fs,
      path,
      crypto,
      digest: yield* Digest.Digest,
      container,
      spawner,
    });
    yield* storage.markInitialized(selection.database);
  }),
).pipe(
  Effect.provide(
    barrierFs.pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  ),
);

await Effect.runPromise(program);
