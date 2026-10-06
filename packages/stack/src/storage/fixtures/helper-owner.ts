import { NodeServices } from "@effect/platform-node";
import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeContainerRuntime } from "../../runtime/Container.ts";
import { makeDockerDatabaseStorage } from "../DockerDatabaseStorage.ts";

const stackId = process.argv[2];
const root = process.argv[3];
if (stackId === undefined || root === undefined) throw new Error("Expected stack id and root");
const HostMarker = Schema.Struct({
  backend: Schema.Literals(["host"]),
  namespace: Schema.String,
  cacheNamespace: Schema.String,
  initialized: Schema.Boolean,
});

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const storageRoot = path.join(root, "state", "stack", "data");
  const instanceRoot = path.join(storageRoot, "database");
  const cacheRoot = path.join(root, "cache");
  yield* fs.makeDirectory(instanceRoot, { recursive: true });
  yield* fs.makeDirectory(cacheRoot, { recursive: true });
  yield* fs.writeFileString(
    path.join(instanceRoot, ".supabase-database-storage.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(HostMarker))({
      backend: "host",
      namespace: `instance-${stackId}-database`,
      cacheNamespace: `cache-${"0".repeat(32)}`,
      initialized: false,
    }),
    { mode: 0o600 },
  );
  const container = yield* makeContainerRuntime({ engine: "docker", root });
  const storage = yield* makeDockerDatabaseStorage({
    runtime: "docker",
    stackId,
    instanceId: "database",
    instanceRoot,
    root: storageRoot,
    cacheRoot,
    fs,
    path,
    crypto,
    container,
    spawner,
  });
  yield* storage.prepare("17");
  yield* storage.removeData("17");
  yield* Effect.sync(() => process.stdout.write("HELPER_READY\n"));
  return yield* Effect.never;
});

await Effect.runPromise(run.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
