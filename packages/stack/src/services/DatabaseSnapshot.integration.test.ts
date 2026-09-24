import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Crypto, Effect, Exit, FileSystem, Option, Path, Schema, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeDatabaseSnapshots } from "./DatabaseSnapshot.ts";

const version = "17.6.1.173";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "database-snapshot-" });
  const path = yield* Path.Path;
  const cache = path.join(root, "cache");

  const makeInstance = (name: string) =>
    Effect.gen(function* () {
      const instance = path.join(root, name);
      yield* fs.makeDirectory(path.join(instance, "data"), { recursive: true });
      yield* fs.writeFileString(path.join(instance, "data", "PG_VERSION"), "17\n");
      yield* fs.writeFileString(
        path.join(instance, ".supabase-database-ready.json"),
        '{"version":"17.6.1.173","runtime":"native","profile":"supabase"}',
      );
      return instance;
    });

  return { fs, path, root, cache, makeInstance };
});

const store = (instance: string, cache: string) =>
  makeDatabaseSnapshots({
    instanceRoot: instance,
    cacheRoot: cache,
    runtime: "native",
    version,
    stackId: "test",
    instanceId: "database",
  });

const entries = (fs: FileSystem.FileSystem, path: Path.Path, cache: string) =>
  Effect.gen(function* () {
    const root = path.join(cache, "stack-database-snapshots", "entries");
    const names = yield* fs.readDirectory(root);
    const result: Array<{ readonly name: string; readonly key: string }> = [];
    for (const name of names) {
      const descriptor = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ logicalKey: Schema.String })),
      )(yield* fs.readFileString(path.join(root, name, "descriptor.json"))).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (descriptor !== undefined) result.push({ name, key: descriptor.logicalKey });
    }
    return result;
  });

const entryPath = (path: Path.Path, cache: string, name: string) =>
  path.join(cache, "stack-database-snapshots", "entries", name);

const live = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | ChildProcessSpawner.ChildProcessSpawner
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("managed native database snapshots", () => {
  it.live("saves, restores, replaces, and isolates source and destination mutations", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const source = yield* makeInstance("source");
        const target = yield* makeInstance("target");
        yield* fs.writeFileString(path.join(source, "data", "fixture"), "first");
        const sourceStore = yield* store(source, cache);
        yield* sourceStore.saveSnapshot("same-key");
        yield* fs.writeFileString(path.join(source, "data", "fixture"), "second");
        yield* sourceStore.saveSnapshot("same-key");
        yield* fs.writeFileString(path.join(source, "data", "fixture"), "mutated-source");
        yield* fs.remove(source, { recursive: true });
        yield* fs.remove(path.join(target, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(target, "data"));
        expect(yield* (yield* store(target, cache)).restoreSnapshot("same-key")).toBe(true);
        expect(yield* fs.readFileString(path.join(target, "data", "fixture"))).toBe("second");

        yield* fs.writeFileString(path.join(target, "data", "fixture"), "destination");
        expect(yield* fs.readFileString(path.join(target, "data", "fixture"))).toBe("destination");
        const secondTarget = yield* makeInstance("second-target");
        yield* fs.remove(path.join(secondTarget, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(secondTarget, "data"));
        expect(yield* (yield* store(secondTarget, cache)).restoreSnapshot("same-key")).toBe(true);
        expect(yield* fs.readFileString(path.join(secondTarget, "data", "fixture"))).toBe("second");
      }),
    ),
  );

  it.live("returns an absent-key miss without changing an empty target", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const target = yield* makeInstance("target");
        yield* fs.remove(path.join(target, "data", "PG_VERSION"));
        const snapshots = yield* store(target, cache);
        expect(yield* snapshots.restoreSnapshot("missing")).toBe(false);
        expect(yield* fs.readDirectory(path.join(target, "data"))).toEqual([]);
      }),
    ),
  );

  it.live("fails a miss on a nonempty target and retains its contents", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const target = yield* makeInstance("target");
        yield* fs.writeFileString(path.join(target, "data", "keep"), "safe");
        const failure = yield* (yield* store(target, cache))
          .restoreSnapshot("missing")
          .pipe(Effect.flip);
        expect(failure.operation).toBe("restore");
        expect(yield* fs.readFileString(path.join(target, "data", "keep"))).toBe("safe");
      }),
    ),
  );

  it.live("evicts the oldest entry by touch time and restore updates the LRU time", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const source = yield* makeInstance("source");
        const snapshots = yield* store(source, cache);
        for (const key of ["one", "two", "three"]) {
          yield* fs.writeFileString(path.join(source, "data", "fixture"), key);
          yield* snapshots.saveSnapshot(key);
        }
        const saved = yield* entries(fs, path, cache);
        for (const [key, seconds] of [
          ["one", 1_000],
          ["two", 2_000],
          ["three", 3_000],
        ] as const) {
          const entry = saved.find((candidate) => candidate.key === key);
          if (entry === undefined) throw new Error(`Missing ${key}`);
          yield* fs.utimes(entryPath(path, cache, entry.name), seconds, seconds);
        }
        yield* fs.remove(path.join(source, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(source, "data"));
        const one = saved.find((entry) => entry.key === "one");
        if (one === undefined) throw new Error("Missing one");
        const beforeRestore = yield* Clock.currentTimeMillis;
        expect(yield* snapshots.restoreSnapshot("one")).toBe(true);
        const afterRestore = yield* Clock.currentTimeMillis;
        const touched = Option.match((yield* fs.stat(entryPath(path, cache, one.name))).mtime, {
          onNone: () => undefined,
          onSome: (mtime) => mtime.getTime(),
        });
        if (touched === undefined) throw new Error("Snapshot touch time is unavailable");
        expect(touched).toBeGreaterThanOrEqual(beforeRestore - 1_000);
        expect(touched).toBeLessThanOrEqual(afterRestore + 1_000);
        yield* fs.writeFileString(path.join(source, "data", "fixture"), "four");
        yield* snapshots.saveSnapshot("four");
        expect((yield* entries(fs, path, cache)).map((entry) => entry.key).sort()).toEqual([
          "four",
          "one",
          "three",
        ]);
      }),
    ),
  );

  it.live("treats an incompatible descriptor as a full-key miss", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const source = yield* makeInstance("source");
        const snapshots = yield* store(source, cache);
        yield* snapshots.saveSnapshot("old-version");
        const saved = yield* entries(fs, path, cache);
        const entry = saved.find((candidate) => candidate.key === "old-version");
        if (entry === undefined) throw new Error("Missing old-version");
        const descriptorPath = path.join(entryPath(path, cache, entry.name), "descriptor.json");
        const descriptor = yield* fs.readFileString(descriptorPath);
        yield* fs.writeFileString(descriptorPath, descriptor.replace(version, "15.14.1.173"));
        yield* fs.remove(path.join(source, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(source, "data"));
        expect(yield* snapshots.restoreSnapshot("old-version")).toBe(false);
        expect(yield* fs.readDirectory(path.join(source, "data"))).toEqual([]);
      }),
    ),
  );

  it.live("rejects corrupt manifests and data before changing the target", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const source = yield* makeInstance("source");
        const snapshots = yield* store(source, cache);
        yield* snapshots.saveSnapshot("corrupt-manifest");
        const saved = yield* entries(fs, path, cache);
        const manifest = saved.find((candidate) => candidate.key === "corrupt-manifest");
        if (manifest === undefined) throw new Error("Missing corrupt-manifest");
        yield* fs.writeFileString(
          path.join(entryPath(path, cache, manifest.name), "descriptor.json"),
          "{}",
        );
        yield* fs.remove(path.join(source, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(source, "data"));
        const manifestFailure = yield* snapshots
          .restoreSnapshot("corrupt-manifest")
          .pipe(Effect.flip);
        expect(manifestFailure.operation).toBe("descriptor");
        expect(yield* fs.readDirectory(path.join(source, "data"))).toEqual([]);

        yield* fs.writeFileString(path.join(source, "data", "PG_VERSION"), "17\n");
        yield* fs.writeFileString(path.join(source, "data", "fixture"), "invalid");
        yield* snapshots.saveSnapshot("corrupt-data");
        const dataEntry = (yield* entries(fs, path, cache)).find(
          (candidate) => candidate.key === "corrupt-data",
        );
        if (dataEntry === undefined) throw new Error("Missing corrupt-data");
        yield* fs.writeFileString(
          path.join(entryPath(path, cache, dataEntry.name), "data", "PG_VERSION"),
          "16\n",
        );
        yield* fs.remove(path.join(source, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(source, "data"));
        const dataFailure = yield* snapshots.restoreSnapshot("corrupt-data").pipe(Effect.flip);
        expect(dataFailure.operation).toBe("validate");
        expect(yield* fs.readDirectory(path.join(source, "data"))).toEqual([]);
      }),
    ),
  );

  it.live("completes concurrent same-key saves with complete generations", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const first = yield* makeInstance("first");
        const second = yield* makeInstance("second");
        for (const [root, value] of [
          [first, "first"],
          [second, "second"],
        ] as const) {
          yield* fs.writeFileString(path.join(root, "data", "generation"), value);
          yield* fs.makeDirectory(path.join(root, "data", "nested"));
          yield* fs.writeFileString(path.join(root, "data", "nested", "generation"), value);
        }
        const results = yield* Effect.all(
          [
            (yield* store(first, cache)).saveSnapshot("same-key"),
            (yield* store(second, cache)).saveSnapshot("same-key"),
          ],
          { concurrency: "unbounded" },
        );
        expect(results).toHaveLength(2);
        const target = yield* makeInstance("target");
        yield* fs.remove(path.join(target, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(target, "data"));
        expect(yield* (yield* store(target, cache)).restoreSnapshot("same-key")).toBe(true);
        const generation = yield* fs.readFileString(path.join(target, "data", "generation"));
        expect(["first", "second"]).toContain(generation);
        expect(yield* fs.readFileString(path.join(target, "data", "nested", "generation"))).toBe(
          generation,
        );
      }),
    ),
  );

  it.live("reclaims stale stages before the next operation", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const source = yield* makeInstance("source");
        const stageRoot = path.join(cache, "stack-database-snapshots", "stages");
        yield* fs.makeDirectory(path.join(stageRoot, "abandoned"), { recursive: true });
        const staleRestore = path.join(source, ".supabase-restore-abandoned", "data");
        yield* fs.makeDirectory(staleRestore, { recursive: true });
        yield* (yield* store(source, cache)).saveSnapshot("cleanup");
        expect(yield* fs.exists(path.join(stageRoot, "abandoned"))).toBe(false);
        expect(yield* fs.exists(path.join(source, ".supabase-restore-abandoned"))).toBe(false);
      }),
    ),
  );

  it.live("rolls back a failed marker publication", () =>
    live(
      Effect.gen(function* () {
        const { fs, path, cache, makeInstance } = yield* setup;
        const source = yield* makeInstance("source");
        const target = yield* makeInstance("target");
        yield* fs.writeFileString(path.join(source, "data", "fixture"), "snapshot");
        yield* (yield* store(source, cache)).saveSnapshot("rollback");
        yield* fs.remove(path.join(target, "data"), { recursive: true });
        yield* fs.makeDirectory(path.join(target, "data"));
        let fail = true;
        const failingFs: FileSystem.FileSystem = {
          ...fs,
          rename: (from, to) => {
            if (
              fail &&
              from.endsWith("/ready.json") &&
              to.endsWith(".supabase-database-ready.json")
            ) {
              fail = false;
              return Effect.die(new Error("injected marker publication failure"));
            }
            return fs.rename(from, to);
          },
        };
        const result = yield* (yield* store(target, cache).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFs),
        ))
          .restoreSnapshot("rollback")
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(
          yield* fs.readFileString(path.join(target, ".supabase-database-ready.json")),
        ).toContain(version);
        expect(yield* fs.readDirectory(path.join(target, "data"))).toEqual([]);
      }),
    ),
  );
});
