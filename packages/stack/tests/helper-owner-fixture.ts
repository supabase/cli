import { NodeServices } from "@effect/platform-node";
import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeContainerRuntime } from "../src/runtime/Container.ts";
import { makeDockerDatabaseStorage } from "../src/storage/DockerDatabaseStorage.ts";
import { makeDockerHelperRegistry } from "../src/storage/DockerHelperRegistry.ts";

const stackId = process.argv[2];
const root = process.argv[3];
const shared = process.argv[4] === "shared";
// "stall-before-start" reports the created helper and then never attaches to it, so a test can
// kill this owner in the window between `create` and `start`.
const stallBeforeStart = process.argv[4] === "stall-before-start";
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
  const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawner = stallBeforeStart
    ? ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.args[0] === "start"
          ? Effect.sync(() => process.stdout.write("HELPER_CREATED\n")).pipe(
              Effect.andThen(Effect.never),
            )
          : realSpawner.spawn(command),
      )
    : realSpawner;
  const storageRoot = path.join(root, "state", "stack", "data");
  const instanceRoot = path.join(storageRoot, "database");
  const cacheRoot = path.join(root, "cache");
  yield* fs.makeDirectory(instanceRoot, { recursive: true });
  yield* fs.makeDirectory(cacheRoot, { recursive: true });
  if (!shared)
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
  const target = { engine: "docker" as const, argv: [], daemonId: "test-daemon-id" };
  const container = yield* makeContainerRuntime({ target, root });
  const helpers = shared ? yield* makeDockerHelperRegistry(yield* crypto.randomUUIDv4) : undefined;
  const storage = yield* makeDockerDatabaseStorage({
    runtime: "docker",
    target,
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
    helpers,
  });
  yield* storage.prepare("17");
  if (!shared) yield* storage.removeData("17");
  yield* Effect.sync(() => process.stdout.write("HELPER_READY\n"));
  return yield* Effect.never;
});

await Effect.runPromise(run.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
