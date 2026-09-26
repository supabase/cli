import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Data, Effect, Exit, FileSystem, Path, Ref, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveArtifact } from "../Artifacts.ts";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { makeDockerDatabaseStorage } from "../storage/DockerDatabaseStorage.ts";
import { makeDockerHelperRegistry } from "../storage/DockerHelperRegistry.ts";
import { shellQuote } from "../storage/DockerSnapshotBackend.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { makeDatabaseSnapshots, type SnapshotScope } from "./DatabaseSnapshot.ts";

const version = "17.6.1.173";

class ShellError extends Data.TaggedError("ShellError")<{ readonly message: string }> {}

type Services =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;
type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const run = (spawner: Spawner, command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" }));
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* new ShellError({ message: `${command} failed: ${stderr.trim()}` });
      return stdout.trim();
    }),
  ).pipe(
    Effect.mapError((cause) => new ShellError({ message: String(cause) })),
    Effect.orDie,
  );

/** Rewrites one spawned command; other commands pass through. */
const rewriting = (
  spawner: Spawner,
  rewrite: (command: string, args: ReadonlyArray<string>) => ReadonlyArray<string> | undefined,
): Spawner =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return spawner.spawn(command);
    const replaced = rewrite(command.command, command.args);
    if (replaced === undefined) return spawner.spawn(command);
    const [executable = "", ...args] = replaced;
    return spawner.spawn(ChildProcess.make(executable, args, command.options));
  });

interface Overrides {
  readonly fs?: FileSystem.FileSystem;
  /** Makes the copy tool leave a partial tree and fail. */
  readonly partialCopy?: boolean;
  /** Leaves the instance without a data directory or its parent. */
  readonly fresh?: boolean;
}

interface SnapshotError {
  readonly operation: string;
}

interface Instance {
  readonly root: string;
  readonly data: string;
  readonly entries: string;
  readonly stages: string;
  readonly restoreStages: string;
  readonly saveSnapshot: (key: string, scope?: SnapshotScope) => Effect.Effect<void, SnapshotError>;
  readonly restoreSnapshot: (
    key: string,
    scope?: SnapshotScope,
  ) => Effect.Effect<boolean, SnapshotError>;
  /** Writes a stopped, ready database whose fixture files hold `value`. */
  readonly seed: (value: string) => Effect.Effect<void>;
  /** Removes the database data the way a database reset does. */
  readonly clear: Effect.Effect<void>;
  readonly destroy: Effect.Effect<void>;
}

interface Engine {
  readonly runtime: "native" | "docker";
  /** Runs a script where the instance paths above resolve; `tool` prefixes file tools. */
  readonly shell: (script: string) => Effect.Effect<string>;
  readonly tool: string;
  readonly instance: (name: string, overrides?: Overrides) => Effect.Effect<Instance>;
}

const readyMarker = (runtime: string) =>
  `{"version":"${version}","runtime":"${runtime}","profile":"supabase"}`;

const native = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const services = yield* Effect.context<Services>();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "database-snapshot-contract-" });
  const cacheRoot = `${root}/cache`;
  const shell = (script: string) => run(spawner, "/bin/sh", ["-c", script]);
  const partialCopy = rewriting(spawner, (command, args) =>
    command === "cp"
      ? [
          "/bin/sh",
          "-c",
          'mkdir -p "$1/nested" && printf partial > "$1/nested/fixture"; exit 1',
          "sh",
          args.at(-1) ?? "",
        ]
      : undefined,
  );
  const instance = (name: string, overrides: Overrides = {}) =>
    Effect.gen(function* () {
      const instanceRoot = `${root}/${name}`;
      const data = `${instanceRoot}/data`;
      if (overrides.fresh !== true) yield* fs.makeDirectory(data, { recursive: true });
      const store = yield* makeDatabaseSnapshots({
        instanceRoot,
        cacheRoot,
        runtime: "native",
        version,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, overrides.fs ?? fs),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          overrides.partialCopy === true ? partialCopy : spawner,
        ),
      );
      const instance: Instance = {
        root: instanceRoot,
        data,
        entries: `${cacheRoot}/stack-database-snapshots/entries`,
        stages: `${cacheRoot}/stack-database-snapshots/stages`,
        restoreStages: `${instanceRoot}/.supabase-restore`,
        saveSnapshot: store.saveSnapshot,
        restoreSnapshot: store.restoreSnapshot,
        seed: (value) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(`${data}/nested`, { recursive: true });
            yield* fs.writeFileString(`${data}/PG_VERSION`, "17\n");
            yield* fs.writeFileString(`${data}/fixture`, value);
            yield* fs.writeFileString(`${data}/nested/fixture`, value);
            yield* fs.writeFileString(
              `${instanceRoot}/.supabase-database-ready.json`,
              readyMarker("native"),
            );
          }).pipe(Effect.orDie),
        clear: Effect.all([
          fs.remove(data, { recursive: true, force: true }),
          fs.remove(`${instanceRoot}/.supabase-database-ready.json`, { force: true }),
        ]).pipe(Effect.asVoid, Effect.orDie),
        destroy: fs.remove(instanceRoot, { recursive: true }).pipe(Effect.orDie),
      };
      return instance;
    }).pipe(Effect.orDie, Effect.provideContext(services));
  const engine: Engine = { runtime: "native", shell, tool: "", instance };
  return engine;
});

const StorageMarker = Schema.fromJsonString(
  Schema.Struct({
    volume: Schema.String,
    namespace: Schema.String,
    cacheNamespace: Schema.String,
  }),
);

const docker = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const services = yield* Effect.context<Services>();
  const scope = yield* Scope.Scope;
  const stackId = "snapshot-contract";
  const root = yield* makeDockerDatabaseRoot("database-snapshot-contract-", stackId);
  const cacheRoot = path.resolve(root, "../../../cache");
  const image = (yield* resolveArtifact({ service: "database", version }).pipe(Effect.orDie)).image;
  const container = yield* makeContainerRuntime({ engine: "docker", root });
  const helpers = yield* makeDockerHelperRegistry(
    `snapshot-contract-${yield* crypto.randomUUIDv4}`,
  );
  const inspector = yield* Ref.make<string | undefined>(undefined);
  // The inspector mounts the store volume only after storage has created and labelled it.
  const inspect = (volume: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(inspector);
      if (current !== undefined) return current;
      const id = yield* Effect.acquireRelease(
        run(spawner, "docker", [
          "run",
          "-d",
          "--label",
          "com.supabase.stack-managed=true",
          "--mount",
          `type=volume,src=${volume},dst=/store`,
          "--entrypoint",
          "/bin/sh",
          image,
          "-c",
          "trap : TERM INT; while :; do sleep 3600; done",
        ]),
        (id) => run(spawner, "docker", ["rm", "-f", id]).pipe(Effect.asVoid),
      ).pipe(Scope.provide(scope));
      yield* Ref.set(inspector, id);
      return id;
    });
  const shell = (script: string) =>
    Ref.get(inspector).pipe(
      Effect.flatMap((id) =>
        id === undefined
          ? Effect.die("Docker store is not created yet")
          : run(spawner, "docker", ["exec", id, "/bin/sh", "-c", script]),
      ),
    );
  const partialCopy = rewriting(spawner, (command, args) => {
    const script = args.at(-1) ?? "";
    if (command !== "docker" || args[0] !== "exec" || !script.includes("/usr/local/bin/cp"))
      return undefined;
    return [
      command,
      ...args.slice(0, -1),
      script.replace(
        /\/usr\/local\/bin\/cp -a --reflink=auto (\S+) (\S+)/u,
        (_match, _from: string, to: string) =>
          `/usr/bin/busybox mkdir -p ${to}/nested; printf partial > ${to}/nested/fixture; exit 1`,
      ),
    ];
  });
  const instance = (name: string, overrides: Overrides = {}) =>
    Effect.gen(function* () {
      const instanceRoot = `${root}/${name}`;
      yield* fs.makeDirectory(instanceRoot, { recursive: true });
      const storage = yield* makeDockerDatabaseStorage({
        runtime: "docker",
        stackId,
        instanceId: name,
        instanceRoot,
        root,
        cacheRoot,
        fs: overrides.fs ?? fs,
        path,
        crypto,
        container,
        spawner: overrides.partialCopy === true ? partialCopy : spawner,
        helpers,
      }).pipe(Scope.provide(scope));
      yield* storage.mount(version);
      if (overrides.fresh !== true) yield* storage.prepare(version);
      const marker = yield* fs
        .readFileString(`${instanceRoot}/.supabase-database-storage.json`)
        .pipe(Effect.flatMap(Schema.decodeEffect(StorageMarker)));
      yield* inspect(marker.volume);
      const data = `/store/${marker.namespace}/data`;
      const cache = `/store/${marker.cacheNamespace}`;
      const instance: Instance = {
        root: instanceRoot,
        data,
        entries: `${cache}/entries`,
        stages: `${cache}/stages`,
        restoreStages: `${cache}/stages`,
        saveSnapshot: (key, scope) => storage.saveSnapshot(version, key, scope),
        restoreSnapshot: (key, scope) => storage.restoreSnapshot(version, key, scope),
        seed: (value) =>
          Effect.gen(function* () {
            yield* storage.prepare(version);
            yield* shell(
              `set -eu; /usr/bin/busybox mkdir -p ${shellQuote(`${data}/nested`)}; printf 17 > ${shellQuote(`${data}/PG_VERSION`)}; printf '%s' ${shellQuote(value)} > ${shellQuote(`${data}/fixture`)}; printf '%s' ${shellQuote(value)} > ${shellQuote(`${data}/nested/fixture`)}`,
            );
            yield* storage.markInitialized(version);
            yield* fs.writeFileString(
              `${instanceRoot}/.supabase-database-ready.json`,
              readyMarker("docker"),
            );
          }).pipe(Effect.orDie),
        clear: storage.removeData(version).pipe(Effect.orDie),
        destroy: storage
          .destroyData(version)
          .pipe(Effect.andThen(fs.remove(instanceRoot, { recursive: true })), Effect.orDie),
      };
      return instance;
    }).pipe(Effect.orDie, Effect.provideContext(services));
  const engine: Engine = { runtime: "docker", shell, tool: "/usr/bin/busybox ", instance };
  return engine;
});

const engines = [
  { name: "native", make: native },
  { name: "docker", make: docker },
];

const Descriptor = Schema.fromJsonString(Schema.Struct({ logicalKey: Schema.String }));
const ReadyVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const setup = <E>(make: () => Effect.Effect<Engine, E, Services>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const engine = yield* make();
    const { shell, tool } = engine;
    const fixture = (instance: Instance) =>
      shell(
        `${tool}cat ${shellQuote(`${instance.data}/fixture`)}; echo; ${tool}cat ${shellQuote(`${instance.data}/nested/fixture`)}`,
      );
    const contents = (directory: string) =>
      shell(`if [ -d ${shellQuote(directory)} ]; then ${tool}ls -A ${shellQuote(directory)}; fi`);
    const entries = (instance: Instance) =>
      Effect.gen(function* () {
        const listing = yield* shell(
          `for entry in ${shellQuote(instance.entries)}/*; do [ -d "$entry" ] || continue; printf '%s ' "$entry"; ${tool}cat "$entry/descriptor.json"; echo; done`,
        );
        const result = new Map<string, string>();
        for (const line of listing.split("\n")) {
          const separator = line.indexOf(" ");
          const decoded = yield* Schema.decodeEffect(Descriptor)(line.slice(separator + 1)).pipe(
            Effect.option,
          );
          if (decoded._tag === "Some")
            result.set(decoded.value.logicalKey, line.slice(0, separator));
        }
        return result;
      });
    const entry = (instance: Instance, key: string) =>
      entries(instance).pipe(
        Effect.flatMap((all) => Effect.fromNullishOr(all.get(key))),
        Effect.orDie,
      );
    return { fs, engine, shell, tool, fixture, contents, entries, entry };
  });

const live = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

for (const { name, make } of engines)
  describe(`${name} database snapshots`, { timeout: 120_000 }, () => {
    it.live("restores a saved snapshot that is isolated from later source changes", () =>
      live(
        Effect.gen(function* () {
          const { fs, engine, fixture } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* source.saveSnapshot("key");
          yield* source.seed("mutated");

          const target = yield* engine.instance("target");
          yield* fs.writeFileString(`${target.root}/.supabase-database-ready.json`, "stale");
          expect(yield* target.restoreSnapshot("key")).toBe(true);

          expect(yield* fixture(target)).toBe("saved\nsaved");
          expect(
            yield* Schema.decodeEffect(ReadyVersion)(
              yield* fs.readFileString(`${target.root}/.supabase-database-ready.json`),
            ),
          ).toEqual({ version });
        }),
      ),
    );

    it.live("restores into an instance without a data directory or its parent", () =>
      live(
        Effect.gen(function* () {
          const { engine, fixture } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* source.saveSnapshot("key");

          const target = yield* engine.instance("target", { fresh: true });
          expect(yield* target.restoreSnapshot("key")).toBe(true);
          expect(yield* fixture(target)).toBe("saved\nsaved");
        }),
      ),
    );

    it.live("replaces an existing key with the newer generation", () =>
      live(
        Effect.gen(function* () {
          const { engine, fixture, entries } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("first");
          yield* source.saveSnapshot("key");
          yield* source.seed("second");
          yield* source.saveSnapshot("key");

          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("key")).toBe(true);
          expect(yield* fixture(target)).toBe("second\nsecond");
          expect([...(yield* entries(source)).keys()]).toEqual(["key"]);
        }),
      ),
    );

    it.live("misses an absent key and leaves the target empty", () =>
      live(
        Effect.gen(function* () {
          const { engine, contents } = yield* setup(make);
          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("absent")).toBe(false);
          expect(yield* contents(target.data)).toBe("");
        }),
      ),
    );

    it.live("refuses to restore over existing data", () =>
      live(
        Effect.gen(function* () {
          const { engine, fixture } = yield* setup(make);
          const target = yield* engine.instance("target");
          yield* target.seed("existing");
          const failure = yield* target.restoreSnapshot("absent").pipe(Effect.flip);
          expect(failure.operation).toBe("restore");
          expect(yield* fixture(target)).toBe("existing\nexisting");
        }),
      ),
    );

    it.live("refuses to save a running database", () =>
      live(
        Effect.gen(function* () {
          const { engine, entries, shell, tool } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("running");
          yield* shell(`${tool}touch ${shellQuote(`${source.data}/postmaster.pid`)}`);
          const failure = yield* source.saveSnapshot("key").pipe(Effect.flip);
          expect(failure.operation).toBe("data");
          expect((yield* entries(source)).size).toBe(0);
        }),
      ),
    );

    it.live("keeps the previous generation and no stages when a copy fails midway", () =>
      live(
        Effect.gen(function* () {
          const { engine, fixture, contents } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("first");
          yield* source.saveSnapshot("key");
          const failingSource = yield* engine.instance("source", { partialCopy: true });
          yield* failingSource.seed("second");
          expect((yield* failingSource.saveSnapshot("key").pipe(Effect.flip)).operation).toBe(
            "copy",
          );
          expect(yield* contents(source.stages)).toBe("");

          const failingTarget = yield* engine.instance("target", { partialCopy: true });
          expect((yield* failingTarget.restoreSnapshot("key").pipe(Effect.flip)).operation).toBe(
            "copy",
          );
          expect(yield* contents(failingTarget.data)).toBe("");
          expect(yield* contents(failingTarget.restoreStages)).toBe("");

          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("key")).toBe(true);
          expect(yield* fixture(target)).toBe("first\nfirst");
        }),
      ),
    );

    it.live("recovers a generation left retired by an interrupted save", () =>
      live(
        Effect.gen(function* () {
          const { engine, entry, fixture, shell, tool } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* source.saveSnapshot("key");
          const saved = yield* entry(source, "key");
          const digest = saved.slice(saved.lastIndexOf("/") + 1);
          yield* shell(
            `${tool}mv ${shellQuote(saved)} ${shellQuote(`${source.stages}/retired-${digest}-abandoned`)}`,
          );

          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("key")).toBe(true);
          expect(yield* fixture(target)).toBe("saved\nsaved");
        }),
      ),
    );

    it.live("keeps the newest entry and the two most recently used others", () =>
      live(
        Effect.gen(function* () {
          const { engine, entries } = yield* setup(make);
          const source = yield* engine.instance("source");
          for (const key of ["one", "two", "three"]) {
            yield* source.seed(key);
            yield* source.saveSnapshot(key);
          }
          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("one")).toBe(true);
          yield* source.seed("four");
          yield* source.saveSnapshot("four");

          expect([...(yield* entries(source)).keys()].sort()).toEqual(["four", "one", "three"]);
        }),
      ),
    );

    it.live("misses a descriptor for another identity and rejects a corrupt one", () =>
      live(
        Effect.gen(function* () {
          const { engine, entry, shell, tool, contents } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* source.saveSnapshot("key");
          const descriptor = shellQuote(`${yield* entry(source, "key")}/descriptor.json`);
          const saved = yield* shell(`${tool}cat ${descriptor}`);
          const target = yield* engine.instance("target");

          yield* shell(
            `printf '%s' ${shellQuote(saved.replace(version, "15.14.1.173"))} > ${descriptor}`,
          );
          expect(yield* target.restoreSnapshot("key")).toBe(false);
          expect(yield* contents(target.data)).toBe("");

          yield* shell(`printf '{}' > ${descriptor}`);
          expect((yield* target.restoreSnapshot("key").pipe(Effect.flip)).operation).toBe(
            "descriptor",
          );
          expect(yield* contents(target.data)).toBe("");
        }),
      ),
    );

    it.live("rejects snapshot data for another PostgreSQL major", () =>
      live(
        Effect.gen(function* () {
          const { engine, entry, shell, contents } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* source.saveSnapshot("key");
          yield* shell(
            `printf 16 > ${shellQuote(`${yield* entry(source, "key")}/data/PG_VERSION`)}`,
          );
          const target = yield* engine.instance("target");
          expect((yield* target.restoreSnapshot("key").pipe(Effect.flip)).operation).toBe(
            "validate",
          );
          expect(yield* contents(target.data)).toBe("");
        }),
      ),
    );

    it.live("keeps instance snapshots beyond cache retention and outside the cache", () =>
      live(
        Effect.gen(function* () {
          const { engine, entries, fixture } = yield* setup(make);
          const owner = yield* engine.instance("owner");
          for (const key of ["one", "two", "three", "four"]) {
            yield* owner.seed(`checkpoint-${key}`);
            yield* owner.saveSnapshot(key, "instance");
          }
          const other = yield* engine.instance("other");
          for (const key of ["a", "b", "c", "d"]) {
            yield* other.seed(key);
            yield* other.saveSnapshot(key);
          }

          yield* owner.clear;
          expect(yield* owner.restoreSnapshot("one", "instance")).toBe(true);
          expect(yield* fixture(owner)).toBe("checkpoint-one\ncheckpoint-one");
          expect([...(yield* entries(other)).keys()].sort()).toEqual(["b", "c", "d"]);
        }),
      ),
    );

    it.live("restores instance snapshots only into their instance and removes them with it", () =>
      live(
        Effect.gen(function* () {
          const { engine } = yield* setup(make);
          const owner = yield* engine.instance("owner");
          yield* owner.seed("checkpoint");
          yield* owner.saveSnapshot("key", "instance");

          const other = yield* engine.instance("other");
          expect(yield* other.restoreSnapshot("key", "instance")).toBe(false);
          yield* owner.destroy;
          const recreated = yield* engine.instance("owner");
          expect(yield* recreated.restoreSnapshot("key", "instance")).toBe(false);
        }),
      ),
    );

    it.live("restores snapshots after the source instance is destroyed", () =>
      live(
        Effect.gen(function* () {
          const { engine, fixture } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("survivor");
          yield* source.saveSnapshot("key");
          yield* source.destroy;

          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("key")).toBe(true);
          expect(yield* fixture(target)).toBe("survivor\nsurvivor");
        }),
      ),
    );

    it.live("keeps the previous marker and empties the target when marker publication fails", () =>
      live(
        Effect.gen(function* () {
          const { fs, engine, contents } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* source.saveSnapshot("key");
          const failingFs = FileSystem.FileSystem.of({
            ...fs,
            rename: (from, to) =>
              to.endsWith(".supabase-database-ready.json")
                ? Effect.die("Injected marker publication failure")
                : fs.rename(from, to),
          });
          const target = yield* engine.instance("target", { fs: failingFs });
          yield* fs.writeFileString(`${target.root}/.supabase-database-ready.json`, "previous");

          expect(Exit.isFailure(yield* target.restoreSnapshot("key").pipe(Effect.exit))).toBe(true);
          expect(yield* fs.readFileString(`${target.root}/.supabase-database-ready.json`)).toBe(
            "previous",
          );
          expect(yield* contents(target.data)).toBe("");
        }),
      ),
    );

    it.live("publishes one complete generation from concurrent saves of a key", () =>
      live(
        Effect.gen(function* () {
          const { engine, fixture } = yield* setup(make);
          const first = yield* engine.instance("first");
          const second = yield* engine.instance("second");
          yield* first.seed("first");
          yield* second.seed("second");
          yield* Effect.all([first.saveSnapshot("key"), second.saveSnapshot("key")], {
            concurrency: "unbounded",
          });

          const target = yield* engine.instance("target");
          expect(yield* target.restoreSnapshot("key")).toBe(true);
          expect(["first\nfirst", "second\nsecond"]).toContain(yield* fixture(target));
        }),
      ),
    );

    it.live("reclaims stale stages before the next operation", () =>
      live(
        Effect.gen(function* () {
          const { engine, shell, tool, contents } = yield* setup(make);
          const source = yield* engine.instance("source");
          yield* source.seed("saved");
          yield* shell(`${tool}mkdir -p ${shellQuote(`${source.stages}/abandoned`)}`);
          yield* shell(`${tool}mkdir -p ${shellQuote(`${source.restoreStages}/abandoned`)}`);
          yield* source.saveSnapshot("key");
          expect(yield* contents(source.stages)).toBe("");
          expect(yield* contents(source.restoreStages)).toBe("");
        }),
      ),
    );
  });

describe("native database snapshot stages", () => {
  it.live("refuses to clear a restore-stage root that is a symbolic link", () =>
    live(
      Effect.gen(function* () {
        const { fs, engine } = yield* setup(native);
        const target = yield* engine.instance("target");
        const victim = `${target.root}-victim`;
        yield* fs.makeDirectory(victim);
        yield* fs.writeFileString(`${victim}/sentinel`, "kept");
        yield* fs.symlink(victim, target.restoreStages);

        const failure = yield* target.restoreSnapshot("absent").pipe(Effect.flip);
        expect(failure.operation).toBe("clear");
        expect(yield* fs.readFileString(`${victim}/sentinel`)).toBe("kept");
      }),
    ),
  );
});
