import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Latch,
  Path,
  PlatformError,
  PubSub,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import type { LaunchOutput } from "../runtime/Session.ts";
import { segmentName, type LogRecord } from "./LogRecord.ts";
import * as LogStore from "./LogStore.ts";

const encoder = new TextEncoder();

const fakeInstance = (
  instanceId: string,
  options: { readonly service?: string; readonly capacity?: number } = {},
) =>
  Effect.gen(function* () {
    const logs =
      options.capacity === undefined
        ? yield* PubSub.unbounded<LaunchOutput>()
        : yield* PubSub.sliding<LaunchOutput>(options.capacity);
    const launch = yield* SubscriptionRef.make<{ readonly launchId: number | undefined }>({
      launchId: undefined,
    });
    const seq = { stdout: 0, stderr: 0 };
    const chunk = (launchId: number, text: string, stream: "stdout" | "stderr" = "stdout") => {
      const next: LaunchOutput = {
        stream,
        bytes: encoder.encode(text),
        launchId,
        part: 0,
        seq: seq[stream],
        time: 0,
      };
      seq[stream] += 1;
      return next;
    };
    return {
      service: options.service ?? "auth",
      instanceId,
      logs: PubSub.subscribe(logs),
      observation: SubscriptionRef.changes(launch),
      publish: (...chunks: ReadonlyArray<LaunchOutput>) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((time) =>
            PubSub.publishAll(
              logs,
              chunks.map((chunk) => ({ ...chunk, time })),
            ),
          ),
        ),
      chunk,
      setLaunch: (launchId: number | undefined) => SubscriptionRef.set(launch, { launchId }),
    };
  });

/** Opens a store in its own scope so a test can close it like an owner stop. */
const openStore = (root: string, options: Omit<LogStore.LogStoreOptions, "root"> = {}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const store = yield* LogStore.make({ root, ...options }).pipe(Scope.provide(scope));
    return { store, close: Scope.close(scope, Exit.void) };
  });

/** Takes `count` items; `Queue.takeN` returns fewer once it has waited for the first. */
const takeExactly = <A>(queue: Queue.Dequeue<A>, count: number) =>
  Effect.gen(function* () {
    const taken: Array<A> = [];
    while (taken.length < count)
      taken.push(...(yield* Queue.takeBetween(queue, 1, count - taken.length)));
    return taken;
  });

/** Collects records from a stream into a queue for incremental assertions. */
const collect = (
  opened: Effect.Effect<
    Stream.Stream<LogRecord, LogStore.LogStoreError>,
    LogStore.LogStoreError,
    Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const stream = yield* opened;
    const records = yield* Queue.unbounded<LogRecord>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((record) => Queue.offer(records, record)),
      Effect.forkScoped,
    );
    return { records, fiber, take: (count: number) => takeExactly(records, count) };
  });

/** Takes records until one carries `text`, returning every record taken. */
const untilLast = (
  reader: { readonly take: (count: number) => Effect.Effect<Iterable<LogRecord>> },
  text: string,
) =>
  Effect.gen(function* () {
    const taken: Array<LogRecord> = [];
    while (taken.at(-1)?.text !== text) taken.push(...(yield* reader.take(1)));
    return taken;
  });

const texts = (records: Iterable<LogRecord>) =>
  Array.from(records).flatMap((record) =>
    record.kind === "stdout" || record.kind === "stderr" ? [record.text ?? ""] : [],
  );

const tempRoot = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix });
  });

describe("LogStore", () => {
  it.effect("follows a burst larger than the live buffer and sees every record exactly once", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-burst-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("burst");
      yield* store.attach(instance);
      const release = yield* Latch.make();
      const seen: Array<LogRecord> = [];
      const follower = yield* (yield* store.read("burst", { from: "oldest", follow: true })).pipe(
        Stream.tap((record) => (record.kind === "launch" ? release.await : Effect.void)),
        Stream.take(1_001),
        Stream.runForEach((record) => Effect.sync(() => seen.push(record))),
        Effect.forkScoped,
      );

      yield* instance.publish(
        ...Array.from({ length: 1_000 }, (_, index) => instance.chunk(1, `line ${index}\n`)),
      );
      yield* release.open;
      yield* Fiber.join(follower);

      expect(texts(seen)).toEqual(Array.from({ length: 1_000 }, (_, index) => `line ${index}`));
      const offline = yield* LogStore.readStackLogs({ root });
      expect(offline.map(({ position }) => position)).toEqual(seen.map(({ position }) => position));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("records chunks the upstream buffer dropped as lost", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-overflow-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("overflow", { capacity: 4 });
      yield* store.attach(instance);
      const reader = yield* collect(store.read("overflow", { from: "oldest", follow: true }));

      yield* instance.publish(
        ...Array.from({ length: 10 }, (_, index) => instance.chunk(1, `line ${index}\n`)),
      );
      const [launch, lost] = yield* reader.take(2);
      const lines = yield* reader.take(10 - (lost?.count ?? 0));

      expect(launch?.kind).toBe("launch");
      expect(lost).toMatchObject({ kind: "lost", launchId: 1, stream: "stdout" });
      expect(lost?.count).toBeGreaterThan(0);
      expect(texts(lines).at(-1)).toBe("line 9");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes a late chunk of a failed launch to that launch", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-late-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("late");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("late", { from: "oldest", follow: true }));

      yield* instance.publish(instance.chunk(1, "starting\nbo"));
      yield* instance.publish({ ...instance.chunk(2, "second\n"), seq: 0 });
      yield* instance.publish({ ...instance.chunk(1, "om\n"), seq: 1 });
      const records = yield* reader.take(6);

      expect(Array.from(records, ({ kind, launchId, text }) => ({ kind, launchId, text }))).toEqual(
        [
          { kind: "launch", launchId: 1, text: undefined },
          { kind: "stdout", launchId: 1, text: "starting" },
          { kind: "stdout", launchId: 1, text: "bo" },
          { kind: "launch", launchId: 2, text: undefined },
          { kind: "stdout", launchId: 2, text: "second" },
          { kind: "stdout", launchId: 1, text: "om" },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes a launch's partial line when its observation leaves the launch", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-partial-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("partial");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("partial", { from: "oldest", follow: true }));
      yield* instance.setLaunch(1);

      yield* instance.publish(instance.chunk(1, "no trailing newline"));
      yield* reader.take(1);
      yield* instance.setLaunch(undefined);
      const [flushed] = yield* reader.take(1);

      expect(flushed).toMatchObject({ kind: "stdout", launchId: 1, text: "no trailing newline" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rotates segments while a follower reads and keeps its order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-rotate-");
      const { store } = yield* openStore(root, { rotateBytes: 300 });
      const instance = yield* fakeInstance("rotate");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("rotate", { from: "oldest", follow: true }));

      for (let index = 0; index < 40; index++) {
        yield* instance.publish(instance.chunk(1, `rotating line ${index}\n`));
        if (index % 10 === 0) yield* reader.take(index === 0 ? 2 : 10);
      }
      const rest = yield* reader.take(9);

      const segments = yield* fs.readDirectory(path.join(root, "auth", "rotate"));
      expect(segments.length).toBeGreaterThan(3);
      expect(texts(rest).at(-1)).toBe("rotating line 39");
      const all = yield* LogStore.readStackLogs({ root });
      expect(texts(all)).toEqual(
        Array.from({ length: 40 }, (_, index) => `rotating line ${index}`),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deletes the oldest segments beyond retention and reports the gap to a reader", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-retention-");
      const { store } = yield* openStore(root, { rotateBytes: 200, retainBytes: 400 });
      const instance = yield* fakeInstance("retention");
      yield* store.attach(instance);
      const release = yield* Latch.make();
      const reader = yield* collect(
        store
          .read("retention", { from: "oldest", follow: true })
          .pipe(
            Effect.map(
              Stream.tap((record) => (record.kind === "launch" ? release.await : Effect.void)),
            ),
          ),
      );
      const progress = yield* collect(store.read("retention", { from: "oldest", follow: true }));

      for (let index = 0; index < 60; index++) {
        yield* instance.publish(instance.chunk(1, `retained line ${index}\n`));
        yield* untilLast(progress, `retained line ${index}`);
      }
      // Opening an end reader takes the writer lock, so the last rotation's retention finished.
      yield* store.read("retention", { from: "end", follow: false }).pipe(Effect.asVoid);

      const directory = path.join(root, "auth", "retention");
      const sizes = yield* Effect.forEach(yield* fs.readDirectory(directory), (name) =>
        fs.stat(path.join(directory, name)).pipe(Effect.map((info) => Number(info.size))),
      );
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(400 + 200);
      yield* release.open;
      const records = yield* untilLast(reader, "retained line 59");
      const gap = records.find((record) => record.kind === "lost");
      expect(gap).toBeDefined();
      expect(gap?.launchId).toBeUndefined();
      expect(gap?.position).toBeUndefined();
      expect(gap?.resumeAt?.generation).toBeGreaterThan(1);
      expect(texts(records).length).toBeLessThan(60);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("caps the number of retained segments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-count-");
      const { store } = yield* openStore(root, { rotateBytes: 1, retainSegments: 3 });
      const instance = yield* fakeInstance("count");
      yield* store.attach(instance);
      const progress = yield* collect(store.read("count", { from: "oldest", follow: true }));

      for (let index = 0; index < 10; index++) {
        yield* instance.publish(instance.chunk(1, `counted line ${index}\n`));
        yield* untilLast(progress, `counted line ${index}`);
      }
      // Opening an end reader takes the writer lock, so the last rotation's retention finished.
      yield* store.read("count", { from: "end", follow: false }).pipe(Effect.asVoid);

      const segments = yield* fs.readDirectory(path.join(root, "auth", "count"));
      expect(segments.length).toBeLessThanOrEqual(3);
      expect(texts(yield* LogStore.readStackLogs({ root })).at(-1)).toBe("counted line 9");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("creates no segment for an instance that wrote nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-idle-");
      const opened = yield* openStore(root);
      yield* opened.store.attach(yield* fakeInstance("idle"));
      yield* opened.close;

      expect(yield* fs.exists(path.join(root, "auth", "idle"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tails the newest records across segments and then follows", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-tail-");
      const { store } = yield* openStore(root, { rotateBytes: 120 });
      const instance = yield* fakeInstance("tail");
      yield* store.attach(instance);
      const progress = yield* collect(store.read("tail", { from: "oldest", follow: true }));
      for (let index = 0; index < 20; index++) {
        yield* instance.publish(instance.chunk(1, `tailed line ${index}\n`));
        yield* untilLast(progress, `tailed line ${index}`);
      }

      const tailed = yield* collect(store.read("tail", { from: "oldest", tail: 3, follow: true }));
      const history = yield* tailed.take(3);
      yield* instance.publish(instance.chunk(1, "after tail\n"));
      const [followed] = yield* tailed.take(1);

      expect(texts(history)).toEqual(["tailed line 17", "tailed line 18", "tailed line 19"]);
      expect(followed?.text).toBe("after tail");
      expect(texts(yield* LogStore.readStackLogs({ root, tail: 2 }))).toEqual([
        "tailed line 19",
        "after tail",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips files that are not service or instance directories when reading offline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-stray-");
      const opened = yield* openStore(root);
      const instance = yield* fakeInstance("kept");
      yield* opened.store.attach(instance);
      const reader = yield* collect(opened.store.read("kept", { from: "oldest", follow: true }));
      yield* instance.publish(instance.chunk(1, "kept line\n"));
      yield* reader.take(2);
      yield* opened.close;
      yield* fs.writeFileString(path.join(root, ".DS_Store"), "");
      yield* fs.writeFileString(path.join(root, "auth", ".DS_Store"), "");

      const records = yield* LogStore.readStackLogs({ root });

      expect(texts(records)).toEqual(["kept line"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the newest records of one batch larger than the retention limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-big-batch-");
      const { store } = yield* openStore(root, { rotateBytes: 200, retainBytes: 400 });
      const instance = yield* fakeInstance("big");
      yield* store.attach(instance);
      const progress = yield* collect(store.read("big", { from: "oldest", follow: true }));

      yield* instance.publish(
        ...Array.from({ length: 60 }, (_, index) => instance.chunk(1, `batched line ${index}\n`)),
      );
      yield* untilLast(progress, "batched line 59");
      // Opening an end reader takes the writer lock, so the last rotation's retention finished.
      yield* store.read("big", { from: "end", follow: false }).pipe(Effect.asVoid);

      const directory = path.join(root, "auth", "big");
      const sizes = yield* Effect.forEach(yield* fs.readDirectory(directory), (name) =>
        fs.stat(path.join(directory, name)).pipe(Effect.map((info) => Number(info.size))),
      );
      expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
      const kept = texts(yield* LogStore.readStackLogs({ root }));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.at(-1)).toBe("batched line 59");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes output still queued when the store closes", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-drain-");
      const opened = yield* openStore(root);
      const instance = yield* fakeInstance("drain");
      yield* opened.store.attach(instance);

      yield* instance.publish(
        ...Array.from({ length: 1_000 }, (_, index) => instance.chunk(1, `queued line ${index}\n`)),
      );
      yield* opened.close;

      const records = yield* LogStore.readStackLogs({ root });
      expect(texts(records)).toEqual(
        Array.from({ length: 1_000 }, (_, index) => `queued line ${index}`),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tails with since past a newer segment that holds an older flushed line", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-late-flush-");
      const { store } = yield* openStore(root, { rotateBytes: 1 });
      const instance = yield* fakeInstance("flushed");
      yield* store.attach(instance);
      const progress = yield* collect(store.read("flushed", { from: "oldest", follow: true }));
      yield* instance.setLaunch(1);

      yield* TestClock.setTime(1_000);
      yield* instance.publish(instance.chunk(1, "early partial", "stderr"));
      yield* TestClock.setTime(2_000);
      yield* instance.publish(instance.chunk(1, "later line\n"));
      yield* untilLast(progress, "later line");
      yield* TestClock.setTime(3_000);
      yield* instance.setLaunch(undefined);
      yield* untilLast(progress, "early partial");

      const since = { since: 1_500, tail: 10 };
      const offline = yield* LogStore.readStackLogs({ root, ...since });
      const live = yield* (yield* store.read("flushed", {
        from: "oldest",
        follow: false,
        ...since,
      })).pipe(Stream.runCollect);

      expect(texts(offline)).toEqual(["later line"]);
      expect(texts(live)).toEqual(["later line"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps sweeping older segments past one it cannot delete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-stuck-segment-");
      const held = segmentName(1);
      const injected: FileSystem.FileSystem = {
        ...fs,
        remove: (target, options) =>
          target.endsWith(held)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                }),
              )
            : fs.remove(target, options),
      };
      const { store } = yield* openStore(root, { rotateBytes: 1, retainSegments: 3 }).pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
      );
      const instance = yield* fakeInstance("stuck");
      yield* store.attach(instance);
      const progress = yield* collect(store.read("stuck", { from: "oldest", follow: true }));

      for (let index = 0; index < 10; index++) {
        yield* instance.publish(instance.chunk(1, `stuck line ${index}\n`));
        yield* untilLast(progress, `stuck line ${index}`);
      }
      // Opening an end reader takes the writer lock, so the last rotation's retention finished.
      yield* store.read("stuck", { from: "end", follow: false }).pipe(Effect.asVoid);

      const segments = yield* fs.readDirectory(path.join(root, "auth", "stuck"));
      expect(segments).toContain(held);
      expect(segments.length).toBeLessThanOrEqual(4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("continues after existing generations when the first listing fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-listing-");
      const directory = path.join(root, "auth", "listing");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, segmentName(1)),
        "1970-01-01T00:00:00.000Z stdout 1 | before\n",
      );
      let failures = 1;
      const injected: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (target, options) =>
          target === directory && failures-- > 0
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readDirectory",
                  pathOrDescriptor: target,
                }),
              )
            : fs.readDirectory(target, options),
      };
      const { store } = yield* openStore(root).pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
      );
      const instance = yield* fakeInstance("listing");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("listing", { from: "oldest", follow: true }));

      yield* instance.publish(instance.chunk(1, "after\n"));
      yield* untilLast(reader, "after");

      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        segmentName(1),
        segmentName(2),
      ]);
      expect(texts(yield* LogStore.readStackLogs({ root }))).toEqual(["before", "after"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes log directories of instances that are no longer attached", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-orphans-");
      const orphan = path.join(root, "rest", "ghost");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, segmentName(1)), "");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("kept");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("kept", { from: "oldest", follow: true }));
      yield* instance.publish(instance.chunk(1, "kept line\n"));
      yield* untilLast(reader, "kept line");

      yield* store.removeOrphans;

      expect(yield* fs.exists(orphan)).toBe(false);
      expect(yield* fs.exists(path.join(root, "auth", "kept", segmentName(1)))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads persisted records offline after the store closes, merged and tailed", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-offline-");
      const opened = yield* openStore(root);
      const auth = yield* fakeInstance("auth-1", { service: "auth" });
      const rest = yield* fakeInstance("rest-1", { service: "rest" });
      yield* opened.store.attach(auth);
      yield* opened.store.attach(rest);
      const authReader = yield* collect(
        opened.store.read("auth-1", { from: "oldest", follow: true }),
      );
      const restReader = yield* collect(
        opened.store.read("rest-1", { from: "oldest", follow: true }),
      );

      yield* TestClock.setTime(1_000);
      yield* rest.publish(rest.chunk(1, "rest first\n"));
      yield* restReader.take(2);
      yield* TestClock.setTime(2_000);
      yield* auth.publish(auth.chunk(1, "auth second\n"));
      yield* authReader.take(2);
      yield* TestClock.setTime(3_000);
      yield* rest.publish(rest.chunk(1, "rest third\n"));
      yield* restReader.take(1);
      yield* opened.close;

      const all = yield* LogStore.readStackLogs({ root });
      const tailed = yield* LogStore.readStackLogs({ root, tail: 2 });
      const recent = yield* LogStore.readStackLogs({ root, since: 2_000, instances: ["rest-1"] });
      const streamed = yield* LogStore.streamStackLogs({ root, instances: ["rest-1"] }).pipe(
        Stream.runCollect,
      );

      expect(Array.from(streamed)).toEqual(all.filter(({ service }) => service === "rest"));
      expect(all.map(({ service, kind }) => `${service}:${kind}`)).toEqual([
        "rest:launch",
        "rest:stdout",
        "auth:launch",
        "auth:stdout",
        "rest:stdout",
      ]);
      expect(texts(all)).toEqual(["rest first", "auth second", "rest third"]);
      expect(texts(tailed)).toEqual(["auth second", "rest third"]);
      expect(texts(recent)).toEqual(["rest third"]);
      expect(recent[0]).toMatchObject({ service: "rest", instanceId: "rest-1" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("opens a new generation for each owner start without touching earlier ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-restart-");
      for (const text of ["before restart", "after restart"]) {
        const opened = yield* openStore(root);
        const instance = yield* fakeInstance("restart");
        yield* opened.store.attach(instance);
        const reader = yield* collect(opened.store.read("restart", { from: "end", follow: true }));
        yield* instance.publish(instance.chunk(1, `${text}\n`));
        yield* reader.take(2);
        yield* opened.close;
      }

      const directory = path.join(root, "auth", "restart");
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        "0000000001.log",
        "0000000002.log",
      ]);
      const records = yield* LogStore.readStackLogs({ root });
      expect(texts(records)).toEqual(["before restart", "after restart"]);
      expect(records.map(({ position }) => position?.generation)).toEqual([1, 1, 2, 2]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tails only records written after an end reader subscribes", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-end-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("end");
      yield* store.attach(instance);
      const history = yield* collect(store.read("end", { from: "oldest", follow: true }));
      yield* instance.publish(instance.chunk(1, "old\n"));
      yield* history.take(2);

      const reader = yield* collect(store.read("end", { from: "end", follow: true }));
      yield* instance.publish(instance.chunk(1, "new\n"));
      const [record] = yield* reader.take(1);

      expect(record).toMatchObject({ kind: "stdout", text: "new" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a tailed read that also sets a start position", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-tail-from-");
      const { store } = yield* openStore(root);
      yield* store.attach(yield* fakeInstance("tail-from"));

      const error = yield* store
        .read("tail-from", { from: { generation: 1, byteOffset: 0 }, tail: 5, follow: false })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(LogStore.LogStoreError);
      expect(error.message).toContain("cannot also set a start position");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes an instance by ending its readers and deleting its segments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-remove-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("removed");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("removed", { from: "oldest", follow: true }));
      yield* instance.publish(instance.chunk(1, "doomed\n"));
      yield* reader.take(2);

      yield* store.remove({ service: "auth", instanceId: "removed" });
      yield* Fiber.join(reader.fiber);

      expect(yield* fs.exists(path.join(root, "auth", "removed"))).toBe(false);
      const failure = yield* store
        .read("removed", { from: "oldest", follow: false })
        .pipe(Effect.flip);
      expect(failure.message).toContain("has no logs");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
