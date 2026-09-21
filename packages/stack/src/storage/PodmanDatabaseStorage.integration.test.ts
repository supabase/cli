import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Data, Effect, Exit, FileSystem, Path, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { makeDockerDatabaseStorage } from "./DockerDatabaseStorage.ts";

const helperImage =
  "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const Marker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  namespace: Schema.String,
  cacheNamespace: Schema.String,
  initialized: Schema.Boolean,
});

class PodmanTestError extends Data.TaggedError("PodmanTestError")<{
  readonly message: string;
}> {}

const podman = Effect.fn("PodmanStorageTest.podman")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("podman", args, { stdin: "ignore" }));
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (all, chunk) => all + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (all, chunk) => all + chunk,
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* new PodmanTestError({ message: stderr.trim() || `podman exited ${code}` });
      return stdout.trim();
    }),
  ),
);

describe("Podman database storage", { timeout: 120_000 }, () => {
  it.live("round-trips fresh host-backed data without a PostgreSQL server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "podman-storage-" });
        const stateRoot = path.join(root, "state");
        const storageRoot = path.join(stateRoot, "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "podman");
        const dataRoot = path.join(instanceRoot, "data");
        const secondInstanceRoot = path.join(storageRoot, "secondinstance");
        const secondDataRoot = path.join(secondInstanceRoot, "data");
        yield* fs.makeDirectory(dataRoot, { recursive: true });
        yield* fs.makeDirectory(secondDataRoot, { recursive: true });
        yield* fs.writeFileString(path.join(secondDataRoot, "PG_VERSION"), "17\n");
        yield* fs.writeFileString(path.join(secondDataRoot, "fixture"), "adopted");
        yield* fs.writeFileString(
          path.join(secondInstanceRoot, ".supabase-database-ready.json"),
          '{"version":"17","runtime":"podman","profile":"supabase"}',
        );
        expect(yield* fs.exists(cacheRoot)).toBe(false);
        const container = yield* makeContainerRuntime({ engine: "podman" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const makeStorage = (instanceId: string, rootPath: string) =>
          makeDockerDatabaseStorage({
            runtime: "podman",
            stackId: "podman-storage-test",
            instanceId,
            instanceRoot: rootPath,
            root: storageRoot,
            cacheRoot,
            fs,
            path,
            crypto,
            container,
            spawner,
          });
        const storage = yield* makeStorage("podman", instanceRoot);
        const secondStorage = yield* makeStorage("second", secondInstanceRoot);

        yield* storage.prepare("17");
        expect(
          yield* fs.exists(path.join(secondInstanceRoot, ".supabase-database-storage.json")),
        ).toBe(false);
        yield* secondStorage.prepare("17");
        const secondMarker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(
            path.join(secondInstanceRoot, ".supabase-database-storage.json"),
          ),
        );
        expect(secondMarker.backend).toBe("host");
        expect(secondMarker.initialized).toBe(true);
        yield* secondStorage.saveSnapshot("17", "adopted");
        const markerPath = path.join(instanceRoot, ".supabase-database-storage.json");
        const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(markerPath),
        );
        expect(marker.backend).toBe("host");
        expect(marker.cacheNamespace).toMatch(/^cache-[a-f0-9]{32}$/u);
        yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
        yield* fs.writeFileString(path.join(dataRoot, "fixture"), "podman");
        yield* storage.markInitialized("17");
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-ready.json"),
          '{"version":"17","runtime":"podman","profile":"supabase"}',
        );

        yield* storage.saveSnapshot("17", "podman");
        yield* storage.removeData("17");
        expect(yield* fs.exists(path.join(dataRoot, "fixture"))).toBe(false);
        expect(yield* storage.restoreSnapshot("17", "podman")).toBe(true);
        yield* storage.saveSnapshot("17", "podman-after-restore");
        expect(yield* fs.readFileString(path.join(dataRoot, "fixture"))).toBe("podman");
        expect(yield* fs.readFileString(path.join(dataRoot, "PG_VERSION"))).toBe("17\n");

        yield* storage.removeData("17");
        yield* storage.destroyData("17");
        expect(yield* fs.exists(dataRoot)).toBe(false);
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-ready.json"))).toBe(
          false,
        );
        yield* secondStorage.destroyData("17");
        expect(yield* fs.exists(secondDataRoot)).toBe(false);
        yield* podman([
          "run",
          "--rm",
          "--mount",
          `type=bind,src=${cacheRoot},dst=/cache`,
          helperImage,
          "/bin/sh",
          "-c",
          "rm -rf /cache/*",
        ]);
        yield* fs.remove(cacheRoot, { recursive: true, force: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reopens host data after its cache root is purged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const owner = yield* Scope.Scope;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "podman-storage-reopen-" });
        const stateRoot = path.join(root, "state");
        const storageRoot = path.join(stateRoot, "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "reopen");
        const dataRoot = path.join(instanceRoot, "data");
        const readyPath = path.join(instanceRoot, ".supabase-database-ready.json");
        yield* fs.makeDirectory(dataRoot, { recursive: true });
        expect(yield* fs.exists(cacheRoot)).toBe(false);
        const container = yield* makeContainerRuntime({ engine: "podman" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const makeStorage = () =>
          makeDockerDatabaseStorage({
            runtime: "podman",
            stackId: "podman-storage-reopen-test",
            instanceId: "reopen",
            instanceRoot,
            root: storageRoot,
            cacheRoot,
            fs,
            path,
            crypto,
            container,
            spawner,
          });

        const initialScope = yield* Scope.fork(owner, "sequential");
        yield* Scope.provide(initialScope)(
          Effect.gen(function* () {
            const storage = yield* makeStorage();
            yield* storage.prepare("17");
            yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
            yield* fs.writeFileString(path.join(dataRoot, "fixture"), "reopen");
            yield* storage.markInitialized("17");
            yield* fs.writeFileString(
              readyPath,
              '{"version":"17","runtime":"podman","profile":"supabase"}',
            );
            yield* storage.saveSnapshot("17", "reopen");
          }),
        );
        yield* Scope.close(initialScope, Exit.void);
        yield* fs.remove(cacheRoot, { recursive: true, force: true });
        expect(yield* fs.exists(cacheRoot)).toBe(false);

        const reopenedScope = yield* Scope.fork(owner, "sequential");
        yield* Scope.provide(reopenedScope)(
          Effect.gen(function* () {
            const storage = yield* makeStorage();
            yield* storage.prepare("17");
            yield* storage.destroyData("17");
          }),
        );
        yield* Scope.close(reopenedScope, Exit.void);
        expect(yield* fs.exists(dataRoot)).toBe(false);
        expect(yield* fs.exists(readyPath)).toBe(false);
        yield* podman([
          "run",
          "--rm",
          "--mount",
          `type=bind,src=${cacheRoot},dst=/cache`,
          helperImage,
          "/bin/sh",
          "-c",
          "rm -rf /cache/*",
        ]);
        yield* fs.remove(cacheRoot, { recursive: true, force: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
