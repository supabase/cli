import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Sink,
  Scope,
  Ref,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { postgresVersion, resolveArtifact } from "../Artifacts.ts";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { makeDatabaseSnapshots } from "../services/DatabaseSnapshot.ts";
import { makeDockerDatabaseStorage } from "./DockerDatabaseStorage.ts";
import { makeDockerHelperRegistry } from "./DockerHelperRegistry.ts";
import type { DockerHelperRegistry } from "./DockerHelperRegistry.ts";

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

const helperMirror = "registry.test/supabase/postgres:17";
const fakeHelperEngine = () => {
  const commands: string[][] = [];
  const local = new Set<string>();
  const handle = (exitCode: number, stdout = "", stderr = "") =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.succeed(new TextEncoder().encode(stdout)),
      stderr: Stream.succeed(new TextEncoder().encode(stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
    const args = [...command.args];
    commands.push(args);
    if (args[0] === "image")
      return Effect.succeed(handle(0, local.has(args.at(-1) ?? "") ? "sha256:1" : ""));
    if (args[0] === "pull") {
      if (args.at(-1) !== helperMirror)
        return Effect.succeed(handle(1, "", `denied: ${args.at(-1)}`));
      local.add(helperMirror);
      return Effect.succeed(handle(0));
    }
    if (args[0] === "inspect") return Effect.succeed(handle(1, "", "no such container"));
    if (args[0] === "run") {
      const shellIndex = args.indexOf("/bin/sh");
      const image = args[shellIndex - 1];
      return image !== undefined && local.has(image)
        ? Effect.succeed(handle(0, "abcdef0123456789"))
        : Effect.succeed(handle(1, "", `Unable to find image '${image ?? ""}' locally`));
    }
    if (args[0] === "exec" || args[0] === "rm") return Effect.succeed(handle(0, "done"));
    return Effect.succeed(handle(1, "", `unexpected engine command: ${args[0] ?? ""}`));
  });
  return { commands, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

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
  it.live("waits for helper creation to settle before cleaning up an interrupted operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-helper-create-cancel-" });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const present = yield* Ref.make(false);
        const removals = yield* Ref.make(0);
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command))
              return yield* Effect.die("Unexpected command");
            const creating = command.args[0] === "run";
            if (creating) yield* Deferred.succeed(started, undefined);
            if (command.args[0] === "rm") {
              yield* Ref.update(removals, (count) => count + 1);
              yield* Ref.set(present, false);
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: (creating
                ? Deferred.await(release).pipe(Effect.andThen(Ref.set(present, true)))
                : Effect.void
              ).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: creating
                ? Stream.succeed(new TextEncoder().encode("a".repeat(64)))
                : Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        );
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "podman",
          stackId: "helper-create-cancel",
          instanceId: "database",
          instanceRoot: root,
          root,
          cacheRoot: path.join(root, "cache"),
          fs,
          path,
          crypto,
          spawner,
          container: {
            prepare: () => Effect.void,
            prepareImage: (image) => Effect.succeed(image),
            launch: () => Effect.die("unused"),
            launchTool: () => Effect.die("unused"),
          },
        });
        yield* storage.prepare("17");
        const operation = yield* storage.removeData("17").pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Effect.sync(() => operation.interruptUnsafe());
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(operation);
        expect(yield* Ref.get(removals)).toBe(1);
        expect(yield* Ref.get(present)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("starts a storage helper with the mirror image selected during preparation", () => {
    const engine = fakeHelperEngine();
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "storage-helper-mirror-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "database");
        yield* fs.makeDirectory(instanceRoot, { recursive: true });
        const container = yield* makeContainerRuntime({
          engine: "podman",
          root,
          imageMirrors: () => [helperMirror],
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "podman",
          stackId: "storage-helper-mirror",
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

        const run = engine.commands.find((args) => args[0] === "run");
        const shellIndex = run?.indexOf("/bin/sh") ?? -1;
        expect(run?.[shellIndex - 1]).toBe(helperMirror);
        expect(
          engine.commands.filter((args) => args[0] === "pull").map((args) => args.at(-1)),
        ).toEqual([expect.stringContaining("ghcr.io/supabase/cli/postgres:"), helperMirror]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("starts a shared volume helper with the mirror image selected during preparation", () => {
    const engine = fakeHelperEngine();
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "storage-shared-helper-mirror-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "database");
        yield* fs.makeDirectory(instanceRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const stackId = "shared-helper-mirror";
        const instanceId = "database";
        const cachePath = yield* fs.realPath(cacheRoot);
        const cacheHash = yield* crypto.digest("SHA-256", new TextEncoder().encode(cachePath));
        const cacheNamespace = `cache-${Array.from(cacheHash, (byte) =>
          byte.toString(16).padStart(2, "0"),
        )
          .join("")
          .slice(0, 32)}`;
        const marker = yield* Schema.encodeEffect(Schema.fromJsonString(Marker))({
          backend: "docker",
          volume: "database-volume",
          namespace: `instance-${stackId}-${instanceId}`,
          cacheNamespace,
          initialized: false,
        });
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-storage.json"),
          marker,
        );
        const container = yield* makeContainerRuntime({
          engine: "podman",
          root,
          imageMirrors: () => [helperMirror],
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const helpers = yield* makeDockerHelperRegistry("mirror-test");
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "podman",
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
          helpers,
        });

        yield* storage.prepare("17");

        const run = engine.commands.find((args) => args[0] === "run");
        const shellIndex = run?.indexOf("/bin/sh") ?? -1;
        expect(run?.[shellIndex - 1]).toBe(helperMirror);
        expect(
          engine.commands.filter((args) => args[0] === "pull").map((args) => args.at(-1)),
        ).toEqual([expect.stringContaining("ghcr.io/supabase/cli/postgres:"), helperMirror]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

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
        const container = yield* makeContainerRuntime({ engine: "docker", root });
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
        const container = yield* makeContainerRuntime({ engine: "docker", root });
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

  it.live("refuses to start unmarked data and removes it through the helper on destroy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-unmarked-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "unmarked");
        const dataRoot = path.join(instanceRoot, "data");
        yield* fs.makeDirectory(path.join(dataRoot, "base"), { recursive: true });
        yield* fs.writeFileString(path.join(dataRoot, "base", "fixture"), "unmarked");
        yield* docker([
          "run",
          "--rm",
          "--mount",
          `type=bind,src=${instanceRoot},dst=/instance`,
          helperImage,
          "/bin/sh",
          "-c",
          "chown -R 100:101 /instance/data; chmod -R 700 /instance/data",
        ]);
        const container = yield* makeContainerRuntime({ engine: "docker", root });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "docker",
          stackId: `storage-unmarked-${yield* crypto.randomUUIDv4}`,
          instanceId: "unmarked",
          instanceRoot,
          root: storageRoot,
          cacheRoot,
          fs,
          path,
          crypto,
          container,
          spawner,
        });
        const markerPath = path.join(instanceRoot, ".supabase-database-storage.json");

        const failure = yield* storage.prepare("17").pipe(Effect.flip);
        expect(failure.message).toContain("without a storage marker");
        expect(yield* fs.exists(markerPath)).toBe(false);

        yield* storage.destroyData("17");
        expect(yield* fs.exists(dataRoot)).toBe(false);
        expect(yield* fs.exists(markerPath)).toBe(false);
        yield* fs.remove(cacheRoot, { recursive: true, force: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses to adopt unmarked Podman data at startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "podman-storage-unmarked-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const instanceRoot = path.join(storageRoot, "unmarked");
        const dataRoot = path.join(instanceRoot, "data");
        yield* fs.makeDirectory(dataRoot, { recursive: true });
        yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
        const storage = yield* makeDockerDatabaseStorage({
          runtime: "podman",
          stackId: "storage-podman-unmarked",
          instanceId: "unmarked",
          instanceRoot,
          root: storageRoot,
          cacheRoot: path.join(root, "cache"),
          fs,
          path,
          crypto,
          container: yield* makeContainerRuntime({ engine: "podman", root }),
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        });

        const failure = yield* storage.prepare("17").pipe(Effect.flip);
        expect(failure.message).toContain("without a storage marker");
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-storage.json"))).toBe(
          false,
        );
        expect(yield* fs.readFileString(path.join(dataRoot, "PG_VERSION"))).toBe("17\n");
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
        const container = yield* makeContainerRuntime({ engine: "docker", root });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const stackId = `storage-helper-recovery-${yield* crypto.randomUUIDv4}`;
        const instanceId = "recovery";
        const helperScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(helperScope, Exit.void));
        const helperRegistry = yield* makeDockerHelperRegistry(yield* crypto.randomUUIDv4).pipe(
          Effect.provideService(Scope.Scope, helperScope),
        );
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
          helpers: helperRegistry,
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
          "--format",
          "{{.Names}}",
        ]);
        const helper = helpers.split("\n").find((name) => name.length > 0);
        if (helper === undefined)
          return yield* new DockerTestError({ message: "Owned helper was not discoverable" });
        yield* docker(["rm", "-f", helper]);
        yield* storage.prepare("17");
        yield* storage.destroyData("17");
        yield* Scope.close(helperScope, Exit.void);
        yield* docker(["volume", "rm", volume]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps another owner's volume helper running when one owner closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-helper-owner-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "database");
        yield* fs.makeDirectory(instanceRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const container = yield* makeContainerRuntime({ engine: "docker", root });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const stackId = `storage-helper-owner-${yield* crypto.randomUUIDv4}`;
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Scope.close(secondScope, Exit.void);
            yield* Scope.close(firstScope, Exit.void);
            const markerText = yield* fs
              .readFileString(path.join(instanceRoot, ".supabase-database-storage.json"))
              .pipe(Effect.option);
            if (Option.isNone(markerText)) return;
            const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              markerText.value,
            ).pipe(Effect.option);
            if (Option.isSome(marker) && marker.value.volume !== undefined)
              yield* docker(["volume", "rm", marker.value.volume]).pipe(Effect.ignore);
          }).pipe(Effect.ignore),
        );
        const firstHelpers = yield* makeDockerHelperRegistry("first-owner").pipe(
          Effect.provideService(Scope.Scope, firstScope),
        );
        const secondHelpers = yield* makeDockerHelperRegistry("second-owner").pipe(
          Effect.provideService(Scope.Scope, secondScope),
        );
        const makeStorage = (helpers: DockerHelperRegistry) =>
          makeDockerDatabaseStorage({
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
            helpers,
          });
        const firstStorage = yield* makeStorage(firstHelpers).pipe(
          Effect.provideService(Scope.Scope, firstScope),
        );
        const secondStorage = yield* makeStorage(secondHelpers).pipe(
          Effect.provideService(Scope.Scope, secondScope),
        );
        yield* firstStorage.prepare("17");
        yield* secondStorage.prepare("17");
        const runningHelpers = (yield* docker([
          "ps",
          "--filter",
          `label=com.supabase.stack=${stackId}`,
          "--format",
          "{{.Names}}",
        ]))
          .split("\n")
          .filter((name) => name.length > 0);
        expect(runningHelpers).toHaveLength(2);

        yield* Scope.close(firstScope, Exit.void);
        const remainingHelpers = (yield* docker([
          "ps",
          "--filter",
          `label=com.supabase.stack=${stackId}`,
          "--format",
          "{{.Names}}",
        ]))
          .split("\n")
          .filter((name) => name.length > 0);
        expect(remainingHelpers).toHaveLength(1);
        expect(runningHelpers).toContain(remainingHelpers[0]);
        yield* secondStorage.prepare("17");
        yield* secondStorage.destroyData("17");
        yield* Scope.close(secondScope, Exit.void);
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
        const container = yield* makeContainerRuntime({ engine: "docker", root });
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

  it.live("handles root-owned host data through helper operations", () =>
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
        // A storage marker always precedes data on disk; write it directly here to set up
        // a host-backed, initialized instance without going through that normal sequence.
        const initialMarker = yield* Schema.encodeEffect(Schema.fromJsonString(Marker))({
          backend: "host",
          namespace: "instance-storage-host-test-adopted",
          cacheNamespace: `cache-${"0".repeat(32)}`,
          initialized: true,
        });
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-storage.json"),
          initialMarker,
          { mode: 0o600 },
        );
        yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
        yield* fs.writeFileString(path.join(dataRoot, "fixture"), "adopted");
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-ready.json"),
          '{"version":"17","runtime":"docker","profile":"supabase"}',
        );
        const container = yield* makeContainerRuntime({ engine: "docker", root });
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
        yield* storage.saveSnapshot("17", "checkpoint", "instance");
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
        expect(yield* storage.restoreSnapshot("17", "checkpoint", "instance")).toBe(true);
        yield* storage.removeData("17");
        yield* storage.destroyData("unsupported");
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-database-storage.json"))).toBe(
          true,
        );
        expect(yield* fs.exists(dataRoot)).toBe(false);
        expect(yield* fs.exists(path.join(instanceRoot, ".supabase-snapshots"))).toBe(false);
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
        const container = yield* makeContainerRuntime({ engine: "docker", root });
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
