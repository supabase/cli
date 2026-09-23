import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { postgresVersion, resolveArtifact } from "../Artifacts.ts";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { makeDatabaseSnapshots } from "../services/DatabaseSnapshot.ts";
import { makeDockerDatabaseStorage } from "./DockerDatabaseStorage.ts";

const postgresImage = (version: string) =>
  resolveArtifact({ service: "database", version: postgresVersion(version) }).pipe(
    Effect.map(({ image }) => image),
  );
const Marker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  volume: Schema.optionalKey(Schema.String),
  namespace: Schema.String,
  cacheNamespace: Schema.String,
  daemonId: Schema.optionalKey(Schema.String),
  initialized: Schema.Boolean,
});

class DockerTestError extends Data.TaggedError("DockerTestError")<{
  readonly message: string;
}> {}

const docker = Effect.fn("DockerStorageTest.docker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("docker", args, { stdin: "ignore" }));
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
        return yield* new DockerTestError({
          message: `docker ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`,
        });
      return stdout.trim();
    }),
  ),
);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("Docker database storage", { timeout: 120_000 }, () => {
  it.live("round-trips PostgreSQL 15 data with its catalog image", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("15");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-pg15-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const sourceRoot = path.join(storageRoot, "source");
        const targetRoot = path.join(storageRoot, "target");
        yield* fs.makeDirectory(sourceRoot, { recursive: true });
        yield* fs.makeDirectory(targetRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const stackId = `storage-pg15-${yield* crypto.randomUUIDv4}`;
        const makeStorage = (instanceId: string, instanceRoot: string) =>
          makeDockerDatabaseStorage({
            runtime: "docker",
            stackId,
            instanceId,
            instanceRoot,
            root: storageRoot,
            cacheRoot,
            fs,
            path,
            crypto,
            container,
            spawner,
          });
        const source = yield* makeStorage("source", sourceRoot);
        const target = yield* makeStorage("target", targetRoot);
        const ownerScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(
          ownerScope,
          Effect.gen(function* () {
            yield* source.destroyData("15").pipe(Effect.ignore);
            yield* target.destroyData("15").pipe(Effect.ignore);
            const marker = yield* fs
              .readFileString(path.join(sourceRoot, ".supabase-database-storage.json"))
              .pipe(Effect.option);
            if (Option.isSome(marker)) {
              const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
                marker.value,
              ).pipe(Effect.option);
              if (Option.isSome(parsed) && parsed.value.volume !== undefined)
                yield* docker(["volume", "rm", parsed.value.volume]).pipe(Effect.ignore);
            }
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.ignore,
          ),
        );

        yield* source.prepare("15");
        const sourceMarker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(sourceRoot, ".supabase-database-storage.json")),
        );
        if (sourceMarker.backend !== "docker" || sourceMarker.volume === undefined)
          return yield* new DockerTestError({ message: "Docker test selected host fallback" });
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          `set -eu; printf 15 > ${quote(`/store/${sourceMarker.namespace}/data/PG_VERSION`)}; printf pg15-source > ${quote(`/store/${sourceMarker.namespace}/data/fixture`)}`,
        ]);
        yield* source.markInitialized("15");
        yield* fs.writeFileString(
          path.join(sourceRoot, ".supabase-database-ready.json"),
          '{"version":"15","runtime":"docker","profile":"supabase"}',
        );
        yield* source.saveSnapshot("15", "restore-me");

        yield* target.prepare("15");
        expect(yield* target.restoreSnapshot("15", "restore-me")).toBe(true);
        const targetMarker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(targetRoot, ".supabase-database-storage.json")),
        );
        expect(targetMarker.volume).toBe(sourceMarker.volume);
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store,volume-subpath=${targetMarker.namespace}/data`,
          helperImage,
          "/bin/sh",
          "-c",
          'test "$(cat /store/PG_VERSION)" = 15 && test "$(cat /store/fixture)" = pg15-source',
        ]);
        yield* target.destroyData("15");
        yield* source.destroyData("15");
        yield* docker(["volume", "rm", sourceMarker.volume]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("round-trips stopped data and protects managed namespaces", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-" });
        const stateRoot = path.join(root, "state");
        const storageRoot = path.join(stateRoot, "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const sourceRoot = path.join(storageRoot, "source");
        const targetRoot = path.join(storageRoot, "target");
        yield* fs.makeDirectory(sourceRoot, { recursive: true });
        yield* fs.makeDirectory(targetRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const makeStorageAt = (
          instanceId: string,
          instanceRoot: string,
          storageRootValue: string,
          cacheRootValue: string,
        ) =>
          makeDockerDatabaseStorage({
            runtime: "docker",
            stackId: "storage-test",
            instanceId,
            instanceRoot,
            root: storageRootValue,
            cacheRoot: cacheRootValue,
            fs,
            path,
            crypto,
            container,
            spawner,
          });
        const makeStorage = (instanceId: string, instanceRoot: string) =>
          makeStorageAt(instanceId, instanceRoot, storageRoot, cacheRoot);
        const source = yield* makeStorage("source", sourceRoot);
        const target = yield* makeStorage("target", targetRoot);
        const ownerScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(
          ownerScope,
          Effect.gen(function* () {
            yield* source.destroyData("17").pipe(Effect.ignore);
            yield* target.destroyData("17").pipe(Effect.ignore);
            const marker = yield* fs
              .readFileString(path.join(sourceRoot, ".supabase-database-storage.json"))
              .pipe(Effect.option);
            if (Option.isSome(marker)) {
              const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
                marker.value,
              ).pipe(Effect.option);
              if (Option.isSome(parsed) && parsed.value.volume !== undefined)
                yield* docker(["volume", "rm", parsed.value.volume]).pipe(Effect.ignore);
            }
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.ignore,
          ),
        );
        yield* source.prepare("17");
        const sourceMarker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(sourceRoot, ".supabase-database-storage.json")),
        );
        if (sourceMarker.backend !== "docker" || sourceMarker.volume === undefined)
          return yield* new DockerTestError({ message: "Docker test selected host fallback" });
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          `set -eu; printf 17 > ${quote(`/store/${sourceMarker.namespace}/data/PG_VERSION`)}; printf source > ${quote(`/store/${sourceMarker.namespace}/data/fixture`)}; /usr/bin/busybox setfattr -n user.storage-smoke -v preserved ${quote(`/store/${sourceMarker.namespace}/data/fixture`)}`,
        ]);
        yield* source.markInitialized("17");
        yield* fs.writeFileString(
          path.join(sourceRoot, ".supabase-database-ready.json"),
          '{"version":"17","runtime":"docker","profile":"supabase"}',
        );
        yield* source.saveSnapshot("17", "roundtrip");

        const copiedRoot = path.join(root, "copied-state", "stack", "data", "source");
        const copiedStorageRoot = path.join(root, "copied-state", "stack", "data");
        const copiedCacheRoot = path.join(root, "copied-cache");
        yield* fs.makeDirectory(copiedRoot, { recursive: true });
        yield* fs.makeDirectory(copiedCacheRoot, { recursive: true });
        yield* fs.writeFileString(
          path.join(copiedRoot, ".supabase-database-storage.json"),
          yield* fs.readFileString(path.join(sourceRoot, ".supabase-database-storage.json")),
        );
        const copied = yield* makeStorageAt(
          "source",
          copiedRoot,
          copiedStorageRoot,
          copiedCacheRoot,
        );
        const mountError = yield* copied.mount("17").pipe(Effect.flip);
        expect(mountError.message).toContain("another state directory");
        const removeError = yield* copied.removeData("17").pipe(Effect.flip);
        expect(removeError.message).toContain("another state directory");
        const destroyError = yield* copied.destroyData("17").pipe(Effect.flip);
        expect(destroyError.message).toContain("another state directory");
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          `test "$(cat /store/${sourceMarker.namespace}/data/fixture)" = source`,
        ]);

        yield* target.prepare("17");
        expect(yield* target.restoreSnapshot("17", "roundtrip")).toBe(true);
        const targetMarker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(targetRoot, ".supabase-database-storage.json")),
        );
        expect(targetMarker.volume).toBe(sourceMarker.volume);
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store,volume-subpath=${targetMarker.namespace}/data`,
          helperImage,
          "/bin/sh",
          "-c",
          `set -eu; test "$(cat /store/fixture)" = source; /usr/bin/busybox setfattr -x user.storage-smoke /store/fixture`,
        ]);

        yield* target.removeData("unsupported");
        const resetMarker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(targetRoot, ".supabase-database-storage.json")),
        );
        expect(resetMarker.volume).toBe(sourceMarker.volume);
        expect(resetMarker.initialized).toBe(false);

        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          'descriptor=$(/usr/bin/busybox find /store -name descriptor.json -print -quit); printf corrupt > "$descriptor"',
        ]);
        const corrupt = yield* target.restoreSnapshot("17", "roundtrip").pipe(
          Effect.matchEffect({
            onFailure: () => Effect.succeed(true),
            onSuccess: () => Effect.succeed(false),
          }),
        );
        expect(corrupt).toBe(true);
        yield* source.saveSnapshot("17", "roundtrip");

        yield* target.restoreSnapshot("17", "roundtrip");
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          `rm -rf ${quote(`/store/${targetMarker.namespace}/data`)}`,
        ]);
        const missing = yield* target.prepare("17").pipe(Effect.exit);
        expect(missing).toSatisfy((exit) => Exit.isFailure(exit));

        yield* target.removeData("17");
        yield* source.saveSnapshot("17", "retention-first");
        yield* source.saveSnapshot("17", "retention-second");
        yield* source.saveSnapshot("17", "retention-third");
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${sourceMarker.volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          `test "$(/usr/bin/busybox find ${quote(`/store/${sourceMarker.cacheNamespace}/entries`)} -mindepth 1 -maxdepth 1 -type d | /usr/bin/busybox wc -l)" -eq 3`,
        ]);
        expect(yield* target.restoreSnapshot("17", "roundtrip")).toBe(false);
        yield* source.saveSnapshot("17", "roundtrip");
        yield* source.destroyData("17");
        expect(yield* target.restoreSnapshot("17", "roundtrip")).toBe(true);
        yield* target.destroyData("17");
        yield* docker(["volume", "rm", sourceMarker.volume]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("removes an unprepared storage without requiring Docker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-empty-" });
        const instanceRoot = path.join(root, "state", "stack", "data", "empty");
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "docker",
          stackId: "storage-empty-test",
          instanceId: "empty",
          instanceRoot,
          root: path.join(root, "state", "stack", "data"),
          cacheRoot: path.join(root, "cache"),
          fs,
          path,
          crypto,
          container: undefined,
          spawner,
        });
        yield* storage.removeData("17");
        yield* storage.destroyData("17");
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-storage.json"))).toBe(
          false,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("destroys legacy host data without a storage marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-legacy-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "legacy");
        const dataRoot = path.join(instanceRoot, "data");
        yield* fs.makeDirectory(dataRoot, { recursive: true });
        yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
        yield* fs.writeFileString(path.join(dataRoot, "fixture"), "legacy");
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-ready.json"),
          '{"version":"17","runtime":"docker","profile":"supabase"}',
        );
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=bind,src=${instanceRoot},dst=/instance`,
          helperImage,
          "/bin/sh",
          "-c",
          "chown -R 100:101 /instance/data; chmod 700 /instance/data",
        ]);
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "docker",
          stackId: `storage-legacy-${yield* crypto.randomUUIDv4}`,
          instanceId: "legacy",
          instanceRoot,
          root: storageRoot,
          cacheRoot,
          fs,
          path,
          crypto,
          container,
          spawner,
        });
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-storage.json"))).toBe(
          false,
        );
        yield* storage.destroyData("17");
        expect(yield* fs.exists(dataRoot)).toBe(false);
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-ready.json"))).toBe(
          false,
        );
        yield* fs.remove(cacheRoot, { recursive: true, force: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("recovers after an owned helper is removed externally", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-helper-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "recovery");
        yield* fs.makeDirectory(instanceRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const stackId = `storage-helper-recovery-${yield* crypto.randomUUIDv4}`;
        const instanceId = "recovery";
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "docker",
          stackId,
          instanceId,
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
        const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(instanceRoot, ".supabase-database-storage.json")),
        );
        const volume = marker.volume;
        if (volume === undefined)
          return yield* new DockerTestError({ message: "Docker storage volume missing" });
        const helpers = yield* docker([
          "ps",
          "--filter",
          "label=com.supabase.stack=" + stackId,
          "--filter",
          "label=com.supabase.instance=" + instanceId,
          "--format",
          "{{.Names}}",
        ]);
        const helper = helpers.split("\n").find((name) => name.length > 0);
        if (helper === undefined)
          return yield* new DockerTestError({ message: "Owned helper was not discoverable" });
        yield* docker(["rm", "-f", helper]);
        const failed = yield* storage.prepare("17").pipe(Effect.exit);
        expect(failed).toSatisfy((exit) => Exit.isFailure(exit));
        yield* storage.prepare("17");
        yield* storage.destroyData("17");
        yield* docker(["volume", "rm", volume]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("destroys an initialized storage after its volume is removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-missing-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "missing");
        yield* fs.makeDirectory(instanceRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const stackId = `storage-missing-${yield* crypto.randomUUIDv4}`;
        const makeStorage = () =>
          makeDockerDatabaseStorage({
            runtime: "docker",
            stackId,
            instanceId: "missing",
            instanceRoot,
            root: storageRoot,
            cacheRoot,
            fs,
            path,
            crypto,
            container,
            spawner,
          });
        let volume: string | undefined;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* makeStorage();
            yield* storage.prepare("17");
            const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(path.join(instanceRoot, ".supabase-database-storage.json")),
            );
            volume = marker.volume;
            if (volume === undefined)
              return yield* new DockerTestError({ message: "Docker storage volume missing" });
            const mount = yield* storage.mount("17");
            if (mount.type !== "volume" || mount.volumeSubpath === undefined)
              return yield* new DockerTestError({ message: "Docker volume backend unavailable" });
            yield* docker([
              "run",
              "--rm",
              "--mount",
              `type=volume,src=${volume},dst=/data,volume-subpath=${mount.volumeSubpath}`,
              helperImage,
              "/bin/sh",
              "-c",
              "printf 17 > /data/PG_VERSION",
            ]);
            yield* storage.markInitialized("17");
          }),
        );
        if (volume === undefined) return yield* new DockerTestError({ message: "Missing volume" });
        const removedVolume = volume;
        yield* docker(["volume", "rm", removedVolume]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* makeStorage();
            const prepare = yield* storage.prepare("17").pipe(Effect.exit);
            expect(prepare).toSatisfy((exit) => Exit.isFailure(exit));
            const removeError = yield* storage.removeData("17").pipe(Effect.flip);
            expect(removeError.message).toMatch(/no such volume/iu);
            expect(yield* docker(["volume", "inspect", removedVolume]).pipe(Effect.exit)).toSatisfy(
              (exit) => Exit.isFailure(exit),
            );
            expect(yield* storage.destroyData("17").pipe(Effect.exit)).toSatisfy((exit) =>
              Exit.isSuccess(exit),
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("adopts root-owned host data through helper operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-host-" });
        const stateRoot = path.join(root, "state");
        const storageRoot = path.join(stateRoot, "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "adopted");
        const dataRoot = path.join(instanceRoot, "data");
        yield* fs.makeDirectory(dataRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
        yield* fs.writeFileString(path.join(dataRoot, "fixture"), "adopted");
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-ready.json"),
          '{"version":"17","runtime":"docker","profile":"supabase"}',
        );
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=bind,src=${instanceRoot},dst=/instance`,
          helperImage,
          "/bin/sh",
          "-c",
          "chown -R 100:101 /instance/data; chmod 700 /instance/data",
        ]);
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "docker",
          stackId: "storage-host-test",
          instanceId: "adopted",
          instanceRoot,
          root: storageRoot,
          cacheRoot,
          fs,
          path,
          crypto,
          container,
          spawner,
        });
        const ownerScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(
          ownerScope,
          storage.destroyData("17").pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.catchCause((cause) => Effect.die(cause)),
          ),
        );
        yield* storage.prepare("17");
        const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(instanceRoot, ".supabase-database-storage.json")),
        );
        expect(marker.backend).toBe("host");
        expect(marker.initialized).toBe(true);
        const expectedOwnership = yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=bind,src=${instanceRoot},dst=/instance`,
          helperImage,
          "/bin/sh",
          "-c",
          "stat -c '%u:%g' /instance/data/PG_VERSION",
        ]);
        if (process.platform === "linux") expect(expectedOwnership).toBe("100:101");
        yield* storage.saveSnapshot("17", "adopted");
        const nativeRoot = path.join(root, "native");
        yield* fs.makeDirectory(path.join(nativeRoot, "data"), { recursive: true });
        yield* fs.writeFileString(path.join(nativeRoot, "data", "PG_VERSION"), "17\n");
        yield* fs.writeFileString(
          path.join(nativeRoot, ".supabase-database-ready.json"),
          '{"version":"17.6.1.173","runtime":"native","profile":"supabase"}',
        );
        const nativeSnapshots = yield* makeDatabaseSnapshots({
          instanceRoot: nativeRoot,
          cacheRoot,
          runtime: "native",
          version: "17",
          stackId: "native-interoperability",
          instanceId: "database",
        });
        yield* nativeSnapshots.saveSnapshot("native");
        yield* fs.remove(path.join(nativeRoot, "data"), { recursive: true });
        expect(yield* nativeSnapshots.restoreSnapshot("native")).toBe(true);
        yield* storage.removeData("17");
        expect(yield* storage.restoreSnapshot("17", "adopted")).toBe(true);
        expect(
          yield* docker([
            "run",
            "--rm",
            "--mount",
            `type=bind,src=${instanceRoot},dst=/instance`,
            helperImage,
            "/bin/sh",
            "-c",
            "stat -c '%u:%g' /instance/data/PG_VERSION",
          ]),
        ).toBe(expectedOwnership);
        yield* storage.removeData("17");
        yield* storage.destroyData("unsupported");
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-storage.json"))).toBe(
          true,
        );
        expect(yield* fs.exists(dataRoot)).toBe(false);
        yield* fs.remove(cacheRoot, { recursive: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reopens managed storage and preserves snapshots after source destruction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-reopen-" });
        const stateRoot = path.join(root, "state");
        const storageRoot = path.join(stateRoot, "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const sourceRoot = path.join(storageRoot, "source");
        const targetRoot = path.join(storageRoot, "target");
        yield* fs.makeDirectory(sourceRoot, { recursive: true });
        yield* fs.makeDirectory(targetRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const container = yield* makeContainerRuntime({ engine: "docker" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const makeStorageWithCache = (
          instanceId: string,
          instanceRoot: string,
          cacheRootValue: string,
        ) =>
          makeDockerDatabaseStorage({
            runtime: "docker",
            stackId: "storage-reopen-test",
            instanceId,
            instanceRoot,
            root: storageRoot,
            cacheRoot: cacheRootValue,
            fs,
            path,
            crypto,
            container,
            spawner,
          });
        const makeStorage = (instanceId: string, instanceRoot: string) =>
          makeStorageWithCache(instanceId, instanceRoot, cacheRoot);
        let sourceVolume: string | undefined;
        const ownerScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(
          ownerScope,
          Effect.gen(function* () {
            if (sourceVolume !== undefined) yield* docker(["volume", "rm", sourceVolume]);
            yield* fs.remove(cacheRoot, { recursive: true, force: true });
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.catchCause((cause) => Effect.die(cause)),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const source = yield* makeStorage("source", sourceRoot);
            yield* source.prepare("17");
            const mount = yield* source.mount("17");
            if (mount.type !== "volume" || mount.volumeSubpath === undefined)
              return yield* new DockerTestError({ message: "Docker volume backend unavailable" });
            const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(path.join(sourceRoot, ".supabase-database-storage.json")),
            );
            sourceVolume = marker.volume;
            if (sourceVolume === undefined)
              return yield* new DockerTestError({ message: "Docker storage volume missing" });
            yield* docker([
              "run",
              "--rm",
              "--mount",
              `type=volume,src=${sourceVolume},dst=/data,volume-subpath=${mount.volumeSubpath}`,
              helperImage,
              "/bin/sh",
              "-c",
              "printf 17 > /data/PG_VERSION; printf reopened > /data/fixture",
            ]);
            yield* source.markInitialized("17");
            yield* fs.writeFileString(
              path.join(sourceRoot, ".supabase-database-ready.json"),
              '{"version":"17","runtime":"docker","profile":"supabase"}',
            );
            yield* source.saveSnapshot("17", "reopened");
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const changedCacheRoot = path.join(root, "changed-cache");
            yield* fs.makeDirectory(changedCacheRoot, { recursive: true });
            const changedCache = yield* makeStorageWithCache(
              "source",
              sourceRoot,
              changedCacheRoot,
            );
            yield* changedCache.prepare("17");
            yield* changedCache.removeData("17");
            expect(yield* changedCache.restoreSnapshot("17", "reopened")).toBe(false);
            const source = yield* makeStorage("source", sourceRoot);
            yield* source.prepare("17");
            yield* source.removeData("17");
            expect(yield* source.restoreSnapshot("17", "reopened")).toBe(true);
            yield* source.saveSnapshot("17", "reopened-again");
            yield* source.destroyData("17");
            const target = yield* makeStorage("target", targetRoot);
            yield* target.prepare("17");
            expect(yield* target.restoreSnapshot("17", "reopened-again")).toBe(true);
            const targetMount = yield* target.mount("17");
            if (targetMount.type !== "volume" || targetMount.volumeSubpath === undefined)
              return yield* new DockerTestError({ message: "Docker target volume unavailable" });
            yield* docker([
              "run",
              "--rm",
              "--mount",
              `type=volume,src=${sourceVolume ?? ""},dst=/data,volume-subpath=${targetMount.volumeSubpath}`,
              helperImage,
              "/bin/sh",
              "-c",
              'test "$(cat /data/fixture)" = reopened',
            ]);
            yield* target.destroyData("17");
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
