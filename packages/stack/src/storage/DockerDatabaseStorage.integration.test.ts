import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import {
  Clock,
  ConfigProvider,
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
import * as TestClock from "effect/testing/TestClock";
import { postgresVersion, resolveArtifact } from "../Artifacts.ts";
import { makeContainerRuntime, type EngineTarget } from "../runtime/Container.ts";
import { makeDatabaseSnapshots } from "../services/DatabaseSnapshot.ts";
import { makeDockerDatabaseStorage } from "./DockerDatabaseStorage.ts";
import { makeDockerHelperRegistry } from "./DockerHelperRegistry.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { removeTestRunVolumes } from "../../tests/docker-volume-run.ts";
import type { DockerHelperRegistry } from "./DockerHelperRegistry.ts";

// An unpinned target: these tests exercise storage marker/volume logic, not endpoint pinning.
const dockerTarget: EngineTarget = { engine: "docker", argv: [], daemonId: "test-daemon-id" };
const containerTarget: EngineTarget = { ...engineTarget, argv: [] };
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
  line: Schema.optionalKey(Schema.String),
});

class DockerTestError extends Data.TaggedError("DockerTestError")<{
  readonly message: string;
}> {}
class PublishBarrierError extends Data.TaggedError("PublishBarrierError")<{
  readonly message: string;
}> {}

const dockerStoragePublishLoopFixture = fileURLToPath(
  new URL("../../tests/docker-storage-publish-loop-fixture.ts", import.meta.url),
);

const helperMirror = "registry.test/supabase/postgres:17";
const fakeHelperEngine = (
  onRun: () => Effect.Effect<void> = () => Effect.void,
  { volumePresent = false }: { readonly volumePresent?: boolean } = {},
) => {
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
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command))
        return yield* Effect.die("unexpected piped command");
      const args = [...command.args];
      commands.push(args);
      if (args[0] === "info") return handle(0, "fake-daemon-id");
      if (args[0] === "version") return handle(0, "27.0.0|27.0.0");
      if (args[0] === "volume" && args[1] === "inspect")
        return volumePresent ? handle(0) : handle(1, "", "no such volume");
      if (args[0] === "volume" && args[1] === "create") return handle(0);
      if (args[0] === "image") return handle(0, local.has(args.at(-1) ?? "") ? "sha256:1" : "");
      if (args[0] === "pull") {
        if (args.at(-1) !== helperMirror) return handle(1, "", `denied: ${args.at(-1)}`);
        local.add(helperMirror);
        return handle(0);
      }
      if (args[0] === "inspect") return handle(1, "", "no such container");
      if (args[0] === "run") {
        const shellIndex = args.indexOf("/bin/sh");
        const image = args[shellIndex - 1];
        if (image === undefined || !local.has(image))
          return handle(1, "", `Unable to find image '${image ?? ""}' locally`);
        // Fires once the create command the claim must precede is observed, so the claim's
        // presence at this exact point is a deterministic fact, not a timing guess.
        yield* onRun();
        return handle(0, args.includes("-i") ? "supabase-helper-ready\n" : "abcdef0123456789");
      }
      if (args[0] === "exec") return handle(0);
      if (args[0] === "rm") return handle(0, "done");
      return handle(1, "", `unexpected engine command: ${args[0] ?? ""}`);
    }),
  );
  return { commands, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

const engine = Effect.fn("StorageTest.engine")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make(testEngine, args, { stdin: "ignore" }));
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
          message: `${testEngine} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`,
        });
      return stdout.trim();
    }),
  ),
);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const awaitDestroyed = Effect.fn("DockerStorageTest.awaitDestroyed")((id: string, since: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const events = yield* spawner.spawn(
        ChildProcess.make(
          "docker",
          [
            "events",
            "--since",
            String(since),
            "--filter",
            `container=${id}`,
            "--filter",
            "event=destroy",
            "--format",
            "{{.Actor.ID}}",
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
        ),
      );
      const destroyed = yield* events.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.trim() === id),
        Stream.runHead,
      );
      if (Option.isNone(destroyed))
        return yield* new DockerTestError({ message: "Docker event stream ended" });
    }),
  ),
);

const ownerDeathScenario = (shared: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-helper-owner-death-" });
      const stackId = `storage-owner-death-${yield* crypto.randomUUIDv4}`;
      const filter = `label=com.supabase.stack=${stackId}`;
      // Pull before spawning so a cold image cache does not consume the owner's readiness timeout.
      const container = yield* makeContainerRuntime({ target: dockerTarget, root });
      yield* container.prepareImage(yield* postgresImage("17"));
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            fileURLToPath(new URL("../../tests/helper-owner-fixture.ts", import.meta.url)),
            stackId,
            root,
            ...(shared ? ["shared"] : []),
          ],
          { stdin: "ignore" },
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const ids = yield* engine(["ps", "-aq", "--filter", filter]);
          if (ids.length > 0) yield* engine(["rm", "-f", ...ids.split("\n")]);
          if (!shared) return;
          const markerText = yield* fs
            .readFileString(`${root}/state/stack/data/database/.supabase-database-storage.json`)
            .pipe(Effect.option);
          if (Option.isNone(markerText)) return;
          const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
            markerText.value,
          ).pipe(Effect.option);
          if (Option.isSome(marker) && marker.value.volume !== undefined)
            yield* engine(["volume", "rm", marker.value.volume]);
        }).pipe(Effect.ignore),
      );
      const stderrOutput = yield* child.stderr.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const ready = yield* child.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.timeout("60 seconds"),
        Effect.exit,
      );
      if (
        Exit.isFailure(ready) ||
        Option.isNone(ready.value) ||
        ready.value.value !== "HELPER_READY"
      ) {
        yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
        const [stderr, exited] = yield* Effect.all(
          [Fiber.join(stderrOutput), Effect.exit(child.exitCode)],
          { concurrency: "unbounded" },
        );
        return yield* new DockerTestError({
          message: `Owner exited before helper was ready (stdout: ${Exit.isSuccess(ready) && Option.isSome(ready.value) ? ready.value.value : "<empty>"}, stderr: ${stderr.trim() || "<empty>"}, exit: ${Exit.isSuccess(exited) ? exited.value : "killed by signal"}${Exit.isFailure(ready) ? `, cause: ${ready.cause}` : ""})`,
        });
      }
      const id = yield* engine([
        "ps",
        "--filter",
        filter,
        "--no-trunc",
        "--format",
        "{{.ID}}",
      ]).pipe(
        Effect.flatMap((value) =>
          value.length > 0
            ? Effect.succeed(value)
            : new DockerTestError({ message: "Owner helper was not running" }),
        ),
      );
      if (shared)
        expect(
          yield* engine([
            "inspect",
            "--format",
            '{{index .Config.Labels "com.supabase.stack-helper"}}',
            id,
          ]),
        ).toBe("volume");
      const since = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1;
      const destroyed = yield* awaitDestroyed(id, since).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      expect(yield* child.isRunning).toBe(true);
      yield* child.kill({ killSignal: "SIGKILL" });
      yield* Fiber.join(destroyed).pipe(
        Effect.timeoutOrElse({
          duration: "1 minute",
          orElse: () => new DockerTestError({ message: `Orphaned database helper: ${id}` }),
        }),
      );
      expect(yield* engine(["ps", "-aq", "--filter", filter])).toBe("");
    }),
  ).pipe(Effect.provide(NodeServices.layer));

// The volume backend, helper registry and volume-labelling contracts exist only on Docker; Podman
// always stores data in host directories, covered by the host storage suite below.
describe.runIf(testEngine === "docker")(
  "Docker volume database storage",
  { timeout: 120_000 },
  () => {
    it.live.skipIf(process.platform === "win32")(
      "removes a database helper when its owner is killed",
      () => ownerDeathScenario(false),
    );

    it.live.skipIf(process.platform === "win32")(
      "removes a shared volume helper when its owner is killed",
      () => ownerDeathScenario(true),
    );

    it.live("waits for helper creation to settle before cleaning up an interrupted operation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "docker-helper-create-cancel-",
          });
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
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: creating
                  ? Stream.fromEffect(
                      Deferred.await(release).pipe(
                        Effect.andThen(Ref.set(present, true)),
                        Effect.as(new TextEncoder().encode("supabase-helper-ready\n")),
                      ),
                    )
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
            runtime: "docker",
            target: dockerTarget,
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
              launchCommand: () => Effect.die("unused"),
            },
          });
          yield* storage.prepare("17");
          const operation = yield* storage.removeData("17").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Effect.sync(() => operation.interruptUnsafe());
          yield* Effect.yieldNow;
          expect(yield* Ref.get(removals)).toBe(0);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(operation);
          expect(yield* Ref.get(removals)).toBe(1);
          expect(yield* Ref.get(present)).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("reports a helper readiness timeout alongside Docker warnings", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-helper-timeout-" });
          const waiting = yield* Deferred.make<void>();
          const warning =
            "WARNING: The requested image's platform does not match the host platform";
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (!ChildProcess.isStandardCommand(command))
                return yield* Effect.die("Unexpected command");
              const creating = command.args[0] === "run";
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(0),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: creating
                  ? Stream.fromEffect(Deferred.succeed(waiting, undefined)).pipe(
                      Stream.drain,
                      Stream.concat(Stream.never),
                    )
                  : Stream.empty,
                stderr: creating
                  ? Stream.succeed(new TextEncoder().encode(`${warning}\n`))
                  : Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              });
            }),
          );
          const storage = yield* makeDockerDatabaseStorage({
            runtime: "docker",
            target: dockerTarget,
            stackId: "helper-timeout",
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
              launchCommand: () => Effect.die("unused"),
            },
          });
          yield* storage.prepare("17");
          const operation = yield* storage.removeData("17").pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(waiting);
          yield* TestClock.adjust("30 seconds");
          const failure = yield* Fiber.join(operation);
          expect(failure.message).toBe(
            `Database helper did not become ready within 30 seconds: ${warning}`,
          );
        }),
      ).pipe(Effect.provide([NodeServices.layer, TestClock.layer()])),
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
            target: dockerTarget,
            root,
            imageMirrors: () => [helperMirror],
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const storage = yield* makeDockerDatabaseStorage({
            runtime: "docker",
            target: dockerTarget,
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
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const stackId = `storage-pg15-${yield* crypto.randomUUIDv4}`;
          const makeStorage = (instanceId: string, instanceRoot: string) =>
            makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
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
                  yield* engine(["volume", "rm", parsed.value.volume]).pipe(Effect.ignore);
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
          yield* engine([
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
          yield* engine([
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
          yield* engine(["volume", "rm", sourceMarker.volume]);
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
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const makeStorageAt = (
            instanceId: string,
            instanceRoot: string,
            storageRootValue: string,
            cacheRootValue: string,
          ) =>
            makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
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
                  yield* engine(["volume", "rm", parsed.value.volume]).pipe(Effect.ignore);
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
          yield* engine([
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
          yield* engine([
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
          yield* engine([
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

          yield* engine([
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
          yield* engine([
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
          yield* engine([
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
          yield* engine(["volume", "rm", sourceMarker.volume]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("labels its volume with the configured test run", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-test-run-" });
          const storageRoot = path.join(root, "state", "stack", "data");
          const cacheRoot = path.join(root, "cache");
          const instanceRoot = path.join(storageRoot, "database");
          yield* fs.makeDirectory(instanceRoot, { recursive: true });
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const stackId = `storage-test-run-${yield* crypto.randomUUIDv4}`;
          const testRunId = `storage-test-run-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
          // This run id overrides the ambient one, so the shared run teardown never sees the volume.
          yield* Effect.addFinalizer(() => removeTestRunVolumes(testRunId).pipe(Effect.orDie));
          const storage = yield* makeDockerDatabaseStorage({
            runtime: "docker",
            target: dockerTarget,
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
          yield* storage
            .prepare("17")
            .pipe(
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromEnvRecord({ SUPABASE_STACK_TEST_RUN: testRunId }),
                ),
              ),
            );
          const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
            yield* fs.readFileString(path.join(instanceRoot, ".supabase-database-storage.json")),
          );
          if (marker.backend !== "docker" || marker.volume === undefined)
            return yield* new DockerTestError({ message: "Docker test selected host fallback" });
          const labels = yield* engine([
            "volume",
            "inspect",
            "--format",
            '{{ index .Labels "com.supabase.stack-test-run" }}',
            marker.volume,
          ]);
          expect(labels).toBe(testRunId);
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
            target: dockerTarget,
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

    it.live(
      "keeps the prior marker decodable when a real kill lands between staging and publishing an update",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const crypto = yield* Crypto.Crypto;
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-crash-" });
            const instanceRoot = path.join(root, "state", "stack", "data", "crash");
            const dataRoot = path.join(root, "state", "stack", "data");
            const cacheRoot = path.join(root, "cache");
            yield* fs.makeDirectory(instanceRoot, { recursive: true });
            const markerPath = path.join(instanceRoot, ".supabase-database-storage.json");
            const helperImage = yield* postgresImage("17");
            const storage = yield* makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
              stackId: "storage-crash-test",
              instanceId: "crash",
              instanceRoot,
              root: dataRoot,
              cacheRoot,
              fs,
              path,
              crypto,
              container: yield* makeContainerRuntime({
                target: dockerTarget,
                root: instanceRoot,
              }),
              spawner,
            });
            // Removes the real volume the seeding step below creates, rather than leaving it for
            // the global test-run teardown, since a container that mounted it may not yet be
            // reaped by the time that teardown runs.
            yield* Effect.addFinalizer(() => storage.destroyData("17").pipe(Effect.ignore));
            yield* storage.prepare("17");
            const before = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(markerPath),
            );
            expect(before.initialized).toBe(false);
            if (before.backend !== "docker" || before.volume === undefined)
              return yield* new DockerTestError({ message: "Docker test selected host fallback" });
            const volume = before.volume;
            // The writer below is killed, not interrupted, so its own one-off helper container (the
            // PG_VERSION check's, and any the killed markInitialized retry below starts) never runs
            // its own cleanup; removed here instead of leaving it attached when `destroyData` above
            // (registered first, so it runs after this) tries to remove the volume.
            yield* Effect.addFinalizer(() =>
              engine(["ps", "--all", "--quiet", "--filter", `volume=${volume}`]).pipe(
                Effect.flatMap((listed) => {
                  const ids = listed
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);
                  return ids.length === 0
                    ? Effect.void
                    : engine(["rm", "--force", ...ids]).pipe(Effect.asVoid);
                }),
                Effect.ignore,
              ),
            );
            // `markInitialized` (below, and inside the killed writer) checks this file through a
            // helper container; this test is about the marker's own crash-safety, not PostgreSQL's,
            // so it is seeded directly rather than through a real database launch.
            yield* engine([
              "run",
              "--rm",
              "--mount",
              `type=volume,src=${before.volume},dst=/store`,
              helperImage,
              "/bin/sh",
              "-c",
              `set -eu; mkdir -p ${quote(`/store/${before.namespace}/data`)}; printf 17 > ${quote(`/store/${before.namespace}/data/PG_VERSION`)}`,
            ]);

            const writer = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [dockerStoragePublishLoopFixture, instanceRoot, dataRoot, cacheRoot],
                { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
              ),
            );
            const ready = yield* Deferred.make<void>();
            const stderr = yield* Ref.make("");
            const diagnostics = yield* writer.stderr.pipe(
              Stream.decodeText,
              Stream.runForEach((chunk) => Ref.update(stderr, (text) => text + chunk)),
              Effect.forkScoped,
            );
            const output = yield* writer.stdout.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.tap((line) =>
                line === "about-to-publish" ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
              Stream.runDrain,
              Effect.forkScoped,
            );
            const writerFailure = (reason: string) =>
              Ref.get(stderr).pipe(
                Effect.flatMap((text) =>
                  Effect.fail(new PublishBarrierError({ message: `${reason}: ${text}` })),
                ),
              );
            // The fixture announces this boundary itself, right before the real rename call;
            // killing here lands in the staging-to-publish gap on every run, not "most of the time".
            yield* Deferred.await(ready).pipe(
              Effect.raceFirst(
                writer.exitCode.pipe(
                  Effect.matchEffect({
                    onFailure: (cause) =>
                      writerFailure(`Writer exited before readiness: ${String(cause)}`),
                    onSuccess: (code) => writerFailure(`Writer exited before readiness (${code})`),
                  }),
                ),
              ),
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => writerFailure("Writer did not reach the publish boundary"),
              }),
            );
            yield* Effect.sync(() => process.kill(Number(writer.pid), "SIGKILL"));
            yield* writer.exitCode.pipe(Effect.ignore);
            yield* Fiber.join(output);
            yield* Fiber.join(diagnostics);

            // The killed writer never reached the rename: the prior marker is untouched, and only
            // its staging file, never a partial target, is left behind.
            const afterKill = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(markerPath),
            );
            expect(afterKill).toEqual(before);
            expect(
              (yield* fs.readDirectory(instanceRoot)).filter((entry) => entry.endsWith(".tmp")),
            ).toHaveLength(1);

            yield* storage.markInitialized("17");
            const afterRetry = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(markerPath),
            );
            expect(afterRetry.initialized).toBe(true);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      20_000,
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
          const checkpointsRoot = path.join(instanceRoot, ".supabase-snapshots");
          yield* fs.makeDirectory(path.join(dataRoot, "base"), { recursive: true });
          yield* fs.writeFileString(path.join(dataRoot, "base", "fixture"), "unmarked");
          yield* fs.makeDirectory(path.join(checkpointsRoot, "entries", "checkpoint", "data"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(checkpointsRoot, "entries", "checkpoint", "data", "PG_VERSION"),
            "17",
          );
          yield* engine([
            "run",
            "--rm",
            "--mount",
            `type=bind,src=${instanceRoot},dst=/instance`,
            helperImage,
            "/bin/sh",
            "-c",
            "chown -R 100:101 /instance/data /instance/.supabase-snapshots; chmod -R 700 /instance/data /instance/.supabase-snapshots",
          ]);
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const storage = yield* makeDockerDatabaseStorage({
            runtime: "docker",
            target: dockerTarget,
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
          expect(yield* fs.exists(checkpointsRoot)).toBe(false);
          expect(yield* fs.exists(markerPath)).toBe(false);
          yield* fs.remove(cacheRoot, { recursive: true, force: true });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("refuses to adopt unmarked Docker data at startup", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-unmarked-" });
          const storageRoot = path.join(root, "state", "stack", "data");
          const instanceRoot = path.join(storageRoot, "unmarked");
          const dataRoot = path.join(instanceRoot, "data");
          yield* fs.makeDirectory(dataRoot, { recursive: true });
          yield* fs.writeFileString(path.join(dataRoot, "PG_VERSION"), "17\n");
          const storage = yield* makeDockerDatabaseStorage({
            runtime: "docker",
            target: dockerTarget,
            stackId: "storage-docker-unmarked",
            instanceId: "unmarked",
            instanceRoot,
            root: storageRoot,
            cacheRoot: path.join(root, "cache"),
            fs,
            path,
            crypto,
            container: yield* makeContainerRuntime({
              target: dockerTarget,
              root,
            }),
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
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
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
            target: dockerTarget,
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
          const helpers = yield* engine([
            "ps",
            "--filter",
            "label=com.supabase.stack=" + stackId,
            "--format",
            "{{.Names}}",
          ]);
          const helper = helpers.split("\n").find((name) => name.length > 0);
          if (helper === undefined)
            return yield* new DockerTestError({ message: "Owned helper was not discoverable" });
          yield* engine(["rm", "-f", helper]);
          yield* storage.prepare("17");
          yield* storage.destroyData("17");
          yield* Scope.close(helperScope, Exit.void);
          yield* engine(["volume", "rm", volume]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("keeps another owner's volume helper running when one owner closes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "docker-storage-helper-owner-",
          });
          const storageRoot = path.join(root, "state", "stack", "data");
          const cacheRoot = path.join(root, "cache");
          const instanceRoot = path.join(storageRoot, "database");
          yield* fs.makeDirectory(instanceRoot, { recursive: true });
          yield* fs.makeDirectory(cacheRoot, { recursive: true });
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
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
                yield* engine(["volume", "rm", marker.value.volume]).pipe(Effect.ignore);
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
              target: dockerTarget,
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
          const runningHelpers = (yield* engine([
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
          const remainingHelpers = (yield* engine([
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
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const stackId = `storage-missing-${yield* crypto.randomUUIDv4}`;
          const makeStorage = () =>
            makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
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
                yield* fs.readFileString(
                  path.join(instanceRoot, ".supabase-database-storage.json"),
                ),
              );
              volume = marker.volume;
              if (volume === undefined)
                return yield* new DockerTestError({ message: "Docker storage volume missing" });
              const mount = yield* storage.mount("17");
              if (mount.type !== "volume" || mount.volumeSubpath === undefined)
                return yield* new DockerTestError({ message: "Docker volume backend unavailable" });
              yield* engine([
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
          if (volume === undefined)
            return yield* new DockerTestError({ message: "Missing volume" });
          const removedVolume = volume;
          yield* engine(["volume", "rm", removedVolume]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const storage = yield* makeStorage();
              const prepare = yield* storage.prepare("17").pipe(Effect.exit);
              expect(prepare).toSatisfy((exit) => Exit.isFailure(exit));
              const removeError = yield* storage.removeData("17").pipe(Effect.flip);
              expect(removeError.message).toMatch(/no such volume/iu);
              expect(
                yield* engine(["volume", "inspect", removedVolume]).pipe(Effect.exit),
              ).toSatisfy((exit) => Exit.isFailure(exit));
              expect(yield* storage.destroyData("17").pipe(Effect.exit)).toSatisfy((exit) =>
                Exit.isSuccess(exit),
              );
            }),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live(
      "destroys the owned namespace in the shared volume after its on-disk marker is deleted, using the identity resolved in memory",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const crypto = yield* Crypto.Crypto;
            const helperImage = yield* postgresImage("17");
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-no-marker-" });
            const storageRoot = path.join(root, "state", "stack", "data");
            const cacheRoot = path.join(root, "cache");
            const instanceRoot = path.join(storageRoot, "sleeping");
            yield* fs.makeDirectory(instanceRoot, { recursive: true });
            yield* fs.makeDirectory(cacheRoot, { recursive: true });
            const container = yield* makeContainerRuntime({
              target: dockerTarget,
              root,
            });
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const stackId = `storage-no-marker-${yield* crypto.randomUUIDv4}`;
            // One storage object spans the whole case, the way an Owner keeps one per instance for
            // the stack's lifetime: its resolved identity stays in memory across the sleep below.
            const storage = yield* makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
              stackId,
              instanceId: "sleeping",
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
            const markerPath = path.join(instanceRoot, ".supabase-database-storage.json");
            const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(markerPath),
            );
            if (marker.backend !== "docker" || marker.volume === undefined)
              return yield* new DockerTestError({ message: "Docker test selected host fallback" });
            const volume = marker.volume;
            const mount = yield* storage.mount("17");
            if (mount.type !== "volume" || mount.volumeSubpath === undefined)
              return yield* new DockerTestError({ message: "Docker volume backend unavailable" });
            yield* engine([
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

            // The database sleeps (the registered instance stays stopped); its storage object keeps
            // running, so this is the only change: the registration's on-disk marker is now gone.
            yield* fs.remove(markerPath);

            yield* storage.destroyData("17");

            const remaining = yield* engine([
              "run",
              "--rm",
              "--mount",
              `type=volume,src=${volume},dst=/store`,
              helperImage,
              "/bin/sh",
              "-c",
              `[ -e ${quote(`/store/${marker.namespace}`)} ] && echo present || echo absent`,
            ]);
            expect(remaining.trim()).toBe("absent");
            yield* engine(["volume", "rm", volume]);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live(
      "destroys the owned namespace after its whole state root is deleted, with no filesystem dependency for an identity already resolved in memory",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const crypto = yield* Crypto.Crypto;
            const helperImage = yield* postgresImage("17");
            // `root` is deleted entirely below; nest it under the scope's own temp dir so the test
            // framework's own cleanup of that outer, still-present directory does not fail.
            const tempDir = yield* fs.makeTempDirectoryScoped({
              prefix: "docker-storage-no-root-",
            });
            const root = path.join(tempDir, "state-root");
            const storageRoot = path.join(root, "state", "stack", "data");
            const cacheRoot = path.join(root, "cache");
            const instanceRoot = path.join(storageRoot, "sleeping");
            yield* fs.makeDirectory(instanceRoot, { recursive: true });
            yield* fs.makeDirectory(cacheRoot, { recursive: true });
            const container = yield* makeContainerRuntime({
              target: dockerTarget,
              root,
            });
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const stackId = `storage-no-root-${yield* crypto.randomUUIDv4}`;
            // One storage object spans the whole case, the way an Owner keeps one per instance for
            // the stack's lifetime: its resolved identity stays in memory across the sleep below.
            const storage = yield* makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
              stackId,
              instanceId: "sleeping",
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
            const markerPath = path.join(instanceRoot, ".supabase-database-storage.json");
            const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
              yield* fs.readFileString(markerPath),
            );
            if (marker.backend !== "docker" || marker.volume === undefined)
              return yield* new DockerTestError({ message: "Docker test selected host fallback" });
            const volume = marker.volume;
            const mount = yield* storage.mount("17");
            if (mount.type !== "volume" || mount.volumeSubpath === undefined)
              return yield* new DockerTestError({ message: "Docker volume backend unavailable" });
            yield* engine([
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

            // The database sleeps; its storage object keeps running (the resolved identity is
            // already in memory), then the whole state root disappears from under the live owner.
            yield* fs.remove(root, { recursive: true, force: true });

            yield* storage.destroyData("17");

            const remaining = yield* engine([
              "run",
              "--rm",
              "--mount",
              `type=volume,src=${volume},dst=/store`,
              helperImage,
              "/bin/sh",
              "-c",
              `[ -e ${quote(`/store/${marker.namespace}`)} ] && echo present || echo absent`,
            ]);
            expect(remaining.trim()).toBe("absent");
            yield* engine(["volume", "rm", volume]);
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
          const container = yield* makeContainerRuntime({
            target: dockerTarget,
            root,
          });
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const makeStorageWithCache = (
            instanceId: string,
            instanceRoot: string,
            cacheRootValue: string,
          ) =>
            makeDockerDatabaseStorage({
              runtime: "docker",
              target: dockerTarget,
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
              if (sourceVolume !== undefined) yield* engine(["volume", "rm", sourceVolume]);
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
              yield* engine([
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
              yield* engine([
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
  },
);

describe("Host database storage", { timeout: 120_000 }, () => {
  it.live("resumes unfinished volume data only on the release line its first start recorded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const helperImage = yield* postgresImage("17");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-line-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "line");
        yield* fs.makeDirectory(instanceRoot, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const storage = yield* makeDockerDatabaseStorage({
          runtime: testEngine,
          target: containerTarget,
          stackId: `storage-line-${yield* crypto.randomUUIDv4}`,
          instanceId: "line",
          instanceRoot,
          root: storageRoot,
          cacheRoot,
          fs,
          path,
          crypto,
          container: yield* makeContainerRuntime({ target: containerTarget, root }),
          spawner,
        });
        let volume: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* storage.destroyData("17").pipe(Effect.ignore);
            if (volume !== undefined) yield* engine(["volume", "rm", volume]).pipe(Effect.ignore);
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        );
        yield* storage.prepare("17");
        const marker = yield* Schema.decodeEffect(Schema.fromJsonString(Marker))(
          yield* fs.readFileString(path.join(instanceRoot, ".supabase-database-storage.json")),
        );
        volume = marker.volume;
        if (marker.backend !== "docker" || volume === undefined)
          return yield* new DockerTestError({ message: "Docker test selected host fallback" });
        // Stands in for initdb output that an interrupted first start leaves without readiness.
        const writePgVersion = engine([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${volume},dst=/store`,
          helperImage,
          "/bin/sh",
          "-c",
          `printf 17 > ${quote(`/store/${marker.namespace}/data/PG_VERSION`)}`,
        ]);
        yield* writePgVersion;

        const oriole = "17.11.0.002-orioledb";
        expect((yield* storage.prepare(oriole).pipe(Effect.flip)).message).toContain(
          "PostgreSQL data from an unfinished first start belongs to release line 17, but 17-orioledb was requested",
        );
        yield* storage.prepare("17");

        yield* storage.removeData("17");
        yield* storage.prepare(oriole);
        yield* writePgVersion;
        expect((yield* storage.prepare("17").pipe(Effect.flip)).message).toContain(
          "PostgreSQL data from an unfinished first start belongs to release line 17-orioledb, but 17 was requested",
        );
        yield* storage.prepare(oriole);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("resumes unfinished host data only on the release line its first start recorded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "docker-storage-host-line-" });
        const storageRoot = path.join(root, "state", "stack", "data");
        const cacheRoot = path.join(root, "cache");
        const instanceRoot = path.join(storageRoot, "line");
        const data = path.join(instanceRoot, "data");
        // Stands in for initdb output that an interrupted first start leaves without readiness.
        const writePgVersion = fs.writeFileString(path.join(data, "PG_VERSION"), "17\n");
        yield* fs.makeDirectory(data, { recursive: true });
        yield* fs.makeDirectory(cacheRoot, { recursive: true });
        // A host marker written before release lines were recorded; it also keeps the bind-mount
        // backend on volume-capable engines.
        yield* fs.writeFileString(
          path.join(instanceRoot, ".supabase-database-storage.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Marker))({
            backend: "host",
            namespace: "instance-storage-host-line-line",
            cacheNamespace: `cache-${"0".repeat(32)}`,
            initialized: false,
          }),
          { mode: 0o600 },
        );
        yield* writePgVersion;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const storage = yield* makeDockerDatabaseStorage({
          runtime: testEngine,
          target: containerTarget,
          stackId: "storage-host-line",
          instanceId: "line",
          instanceRoot,
          root: storageRoot,
          cacheRoot,
          fs,
          path,
          crypto,
          container: yield* makeContainerRuntime({ target: containerTarget, root }),
          spawner,
        });
        yield* Effect.addFinalizer(() =>
          storage
            .destroyData("17")
            .pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.ignore,
            ),
        );

        const oriole = "17.11.0.002-orioledb";
        expect((yield* storage.prepare(oriole).pipe(Effect.flip)).message).toContain(
          "Unmarked PostgreSQL data cannot be verified as OrioleDB data; run `supabase stack destroy --stack-id storage-host-line` to recreate the stack — this permanently deletes its local database data",
        );
        yield* storage.prepare("17");
        expect(yield* fs.readFileString(path.join(data, "PG_VERSION"))).toBe("17\n");

        // A fresh first start records its line, so its unfinished data resumes only on that line.
        yield* fs.remove(data, { recursive: true });
        yield* storage.prepare(oriole);
        yield* writePgVersion;
        expect((yield* storage.prepare("17").pipe(Effect.flip)).message).toContain(
          "PostgreSQL data from an unfinished first start belongs to release line 17-orioledb, but 17 was requested",
        );
        yield* storage.prepare(oriole);
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
          `{"version":"17","runtime":"${testEngine}","profile":"supabase"}`,
        );
        const container = yield* makeContainerRuntime({
          target: containerTarget,
          root,
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* engine([
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
          runtime: testEngine,
          target: containerTarget,
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
        const expectedOwnership = yield* engine([
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
          // `makeDatabaseSnapshots` below resolves `version: "17"` through the real catalog
          // (`postgresVersion`), so the ready marker must carry that same resolved version.
          `{"version":"${postgresVersion("17")}","runtime":"native","profile":"supabase"}`,
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
          yield* engine([
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
});
