import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Deferred,
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
import {
  endedLineGraceMillis,
  segmentGeneration,
  segmentName,
  type LogRecord,
} from "./LogRecord.ts";
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

/** Opens a store in a child of the test's scope so a test can close it like an owner stop. */
const openStore = (root: string, options: Omit<LogStore.LogStoreOptions, "root"> = {}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const store = yield* LogStore.make({ root, ...options }).pipe(Scope.provide(scope));
    return { store, close: Scope.close(scope, Exit.void) };
  });

/** A file system whose segment writes run `writeAll` in place of the real file's. */
const replaceWrites = (
  fs: FileSystem.FileSystem,
  writeAll: (
    file: FileSystem.File,
    buffer: Uint8Array,
  ) => Effect.Effect<void, PlatformError.PlatformError>,
): FileSystem.FileSystem => ({
  ...fs,
  open: (target, options) =>
    fs.open(target, options).pipe(
      Effect.map((file): FileSystem.File => ({
        [FileSystem.FileTypeId]: FileSystem.FileTypeId,
        stat: file.stat,
        seek: (offset, from) => file.seek(offset, from),
        sync: file.sync,
        read: (buffer) => file.read(buffer),
        readAlloc: (size) => file.readAlloc(size),
        truncate: (length) => file.truncate(length),
        write: (buffer) => file.write(buffer),
        writeAll: (buffer) => writeAll(file, buffer),
      })),
    ),
});

/** Reads persisted records offline, one instance after another in file order. */
const persisted = (options: Parameters<typeof LogStore.streamStackLogs>[0]) =>
  LogStore.streamStackLogs(options).pipe(Stream.runCollect);

const lostCounts = (records: Iterable<LogRecord>) =>
  Array.from(records).flatMap(({ kind, launchId, stream, count }) =>
    kind === "lost" ? [{ launchId, stream, count }] : [],
  );

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
      const offline = yield* persisted({ root });
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

  it.effect("writes a late partial line of an ended launch once it stays quiet for the grace", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-quiet-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("quiet");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("quiet", { from: "oldest", follow: true }));
      yield* instance.setLaunch(1);
      yield* instance.publish(instance.chunk(1, "ending"));
      yield* reader.take(1);
      yield* instance.setLaunch(undefined);
      yield* untilLast(reader, "ending");

      yield* instance.publish(instance.chunk(1, "late"), instance.chunk(1, "written\n", "stderr"));
      yield* untilLast(reader, "written");
      const beforeGrace = yield* Queue.size(reader.records);
      yield* TestClock.adjust(endedLineGraceMillis);
      const [late] = yield* reader.take(1);

      expect(beforeGrace).toBe(0);
      expect(late).toMatchObject({ kind: "stdout", launchId: 1, text: "late" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a late line whole when its newline was published before the grace ran out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot("log-store-late-newline-");
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const injected = replaceWrites(fs, (file, buffer) =>
        new TextDecoder().decode(buffer).includes("busy")
          ? Deferred.succeed(blocked, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(file.writeAll(buffer)),
            )
          : file.writeAll(buffer),
      );
      const armed = yield* Deferred.make<void>();
      const woke = yield* Deferred.make<void>();
      const clock = yield* TestClock.testClockWith(Effect.succeed);
      // The store's only sleep before close is the grace flusher's wait for the deadline.
      const graceClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) =>
          Deferred.succeed(armed, undefined).pipe(
            Effect.andThen(clock.sleep(duration)),
            Effect.andThen(Deferred.succeed(woke, undefined)),
          ),
      };
      const { store } = yield* openStore(root).pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
      );
      const instance = yield* fakeInstance("newline");
      yield* store.attach(instance).pipe(Effect.provideService(Clock.Clock, graceClock));
      const reader = yield* collect(store.read("newline", { from: "oldest", follow: true }));
      yield* instance.setLaunch(1);
      yield* instance.publish(instance.chunk(1, "ending"));
      yield* reader.take(1);
      yield* instance.setLaunch(undefined);
      yield* untilLast(reader, "ending");

      yield* instance.publish(instance.chunk(1, "late "));
      yield* Deferred.await(armed);
      yield* instance.publish(instance.chunk(1, "busy\n", "stderr"));
      yield* Deferred.await(blocked);
      yield* TestClock.adjust(endedLineGraceMillis / 2);
      yield* instance.publish(instance.chunk(1, "line end\n"));
      yield* TestClock.adjust(endedLineGraceMillis / 2);
      yield* Deferred.await(woke);
      yield* Deferred.succeed(release, undefined);
      const records: Array<LogRecord> = [];
      while (!records.some((record) => record.text?.endsWith("line end") === true))
        records.push(...(yield* reader.take(1)));

      expect(texts(records)).toEqual(["busy", "late line end"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("records each failed write as lost once, including a partial-line flush", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot("log-store-failed-write-");
      const failures = yield* Queue.unbounded<string>();
      const failOnce = new Set(["pending", "doomed"]);
      const injected = replaceWrites(fs, (file, buffer) => {
        const text = new TextDecoder().decode(buffer);
        const word = [...failOnce].find((candidate) => text.includes(candidate));
        if (word === undefined) return file.writeAll(buffer);
        failOnce.delete(word);
        // Leaves part of the first record behind, like a write that fails part-way.
        return file.writeAll(buffer.subarray(0, 10)).pipe(
          Effect.andThen(Queue.offer(failures, word)),
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "write",
              }),
            ),
          ),
        );
      });
      const { store } = yield* openStore(root, { rotateBytes: 1 }).pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
      );
      const instance = yield* fakeInstance("failing");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("failing", { from: "oldest", follow: true }));
      yield* instance.setLaunch(1);
      yield* instance.publish(instance.chunk(1, "first\n"));
      yield* untilLast(reader, "first");
      yield* instance.publish(instance.chunk(1, "pending"), instance.chunk(1, "sync\n", "stderr"));
      yield* untilLast(reader, "sync");

      yield* instance.setLaunch(undefined);
      const flushFailure = yield* Queue.take(failures);
      yield* TestClock.adjust(100);
      yield* instance.publish({ ...instance.chunk(2, "doomed\n"), seq: 0 });
      const lineFailure = yield* Queue.take(failures);
      yield* TestClock.adjust(200);
      yield* instance.publish({ ...instance.chunk(2, "after\n"), seq: 1 });
      const followed = yield* untilLast(reader, "after");
      const offline = yield* persisted({ root });

      const expectedLost = [
        { launchId: 1, stream: "stdout", count: 1 },
        { launchId: 2, stream: "stdout", count: 1 },
      ];
      expect([flushFailure, lineFailure]).toEqual(["pending", "doomed"]);
      expect(lostCounts(followed)).toEqual(expectedLost);
      expect(lostCounts(offline)).toEqual(expectedLost);
      expect(texts(offline)).toEqual(["first", "sync", "after"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closes by the shutdown deadline while a segment write hangs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempRoot("log-store-hung-write-");
      const writing = yield* Deferred.make<void>();
      const injected = replaceWrites(fs, () =>
        Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const opened = yield* openStore(root).pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
      );
      const instance = yield* fakeInstance("hung");
      yield* opened.store.attach(instance);
      yield* instance.publish(instance.chunk(1, "never written\n"));
      yield* Deferred.await(writing);

      const closing = yield* Effect.forkChild(opened.close, { startImmediately: true });
      yield* TestClock.adjust(4_999);
      const beforeDeadline = closing.pollUnsafe();
      yield* TestClock.adjust(1);
      yield* Fiber.join(closing);

      expect(beforeDeadline).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads past a partial record a write left at the end of an earlier segment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot("log-store-torn-");
      const directory = path.join(root, "auth", "torn");
      const torn = path.join(directory, segmentName(1));
      const content =
        "1970-01-01T00:00:00.000Z stdout 1 | whole\n1970-01-01T00:00:00.000Z stdout 1 | to";
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(torn, content);
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("torn");
      yield* store.attach(instance);
      const reader = yield* collect(store.read("torn", { from: "oldest", follow: true }));

      yield* instance.publish(instance.chunk(2, "after\n"));
      const followed = yield* untilLast(reader, "after");

      expect(texts(followed)).toEqual(["whole", "after"]);
      expect(texts(yield* persisted({ root }))).toEqual(["whole", "after"]);
      expect(yield* fs.readFileString(torn)).toBe(content);
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
      const all = yield* persisted({ root });
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
      // An empty tailed read takes the writer lock, so the last rotation's retention finished.
      yield* store
        .read("retention", { from: "oldest", tail: 0, follow: false })
        .pipe(Effect.asVoid);

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
      // An empty tailed read takes the writer lock, so the last rotation's retention finished.
      yield* store.read("count", { from: "oldest", tail: 0, follow: false }).pipe(Effect.asVoid);

      const segments = yield* fs.readDirectory(path.join(root, "auth", "count"));
      expect(segments.length).toBeLessThanOrEqual(3);
      expect(texts(yield* persisted({ root })).at(-1)).toBe("counted line 9");
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

      const records = yield* persisted({ root });

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
      // An empty tailed read takes the writer lock, so the last rotation's retention finished.
      yield* store.read("big", { from: "oldest", tail: 0, follow: false }).pipe(Effect.asVoid);

      const directory = path.join(root, "auth", "big");
      const sizes = yield* Effect.forEach(yield* fs.readDirectory(directory), (name) =>
        fs.stat(path.join(directory, name)).pipe(Effect.map((info) => Number(info.size))),
      );
      expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
      const kept = texts(yield* persisted({ root }));
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

      const records = yield* persisted({ root });
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

      const live = yield* (yield* store.read("flushed", {
        from: "oldest",
        follow: false,
        since: 1_500,
        tail: 10,
      })).pipe(Stream.runCollect);

      expect(texts(live)).toEqual(["later line"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tails the newest record when several newer segments hold older flushed lines", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-late-flushes-");
      const { store } = yield* openStore(root, { rotateBytes: 1 });
      const instance = yield* fakeInstance("flushes");
      yield* store.attach(instance);
      const progress = yield* collect(store.read("flushes", { from: "oldest", follow: true }));
      yield* instance.setLaunch(1);

      // Partial lines of a later process part stay open while part 0 writes a newer line.
      yield* TestClock.setTime(1_000);
      yield* instance.publish(
        { ...instance.chunk(1, "early stdout"), part: 1 },
        { ...instance.chunk(1, "early stderr", "stderr"), part: 1 },
      );
      yield* TestClock.setTime(3_000);
      yield* instance.publish(instance.chunk(1, "latest\n"));
      yield* untilLast(progress, "latest");
      yield* TestClock.setTime(4_000);
      yield* instance.setLaunch(undefined);
      yield* untilLast(progress, "early stderr");

      const live = yield* (yield* store.read("flushes", {
        from: "oldest",
        follow: false,
        tail: 1,
      })).pipe(Stream.runCollect);

      expect(texts(live)).toEqual(["latest"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sweeps past a segment it cannot delete and reports the deleted ones to a reader", () =>
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
      // An empty tailed read takes the writer lock, so the last rotation's retention finished.
      yield* store.read("stuck", { from: "oldest", tail: 0, follow: false }).pipe(Effect.asVoid);

      const segments = yield* fs.readDirectory(path.join(root, "auth", "stuck"));
      const resumed = yield* (yield* store.read("stuck", {
        from: { generation: 3, byteOffset: 0 },
        follow: false,
      })).pipe(Stream.runCollect);
      const fromHeld = yield* (yield* store.read("stuck", {
        from: { generation: 1, byteOffset: 0 },
        follow: false,
      })).pipe(Stream.runCollect);
      const afterHeld = segments
        .map(segmentGeneration)
        .filter((generation) => generation !== undefined && generation > 1)
        .toSorted((left, right) => (left ?? 0) - (right ?? 0))[0];

      expect(segments).toContain(held);
      expect(segments).not.toContain(segmentName(2));
      expect(segments).not.toContain(segmentName(3));
      expect(segments.length).toBeLessThanOrEqual(4);
      const [gap] = resumed;
      expect(gap?.kind).toBe("lost");
      expect(gap?.position).toBeUndefined();
      expect(gap?.resumeAt?.generation).toBeGreaterThan(3);
      expect(texts(resumed).at(-1)).toBe("stuck line 9");
      const heldGaps = Array.from(fromHeld).filter((record) => record.kind === "lost");
      expect(heldGaps).toHaveLength(1);
      expect(heldGaps[0]?.resumeAt).toEqual({ generation: afterHeld, byteOffset: 0 });
      expect(fromHeld[0]?.kind).toBe("launch");
      expect(texts(fromHeld).at(-1)).toBe("stuck line 9");
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
      expect(texts(yield* persisted({ root }))).toEqual(["before", "after"]);
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

  it.effect("reads persisted records offline after the store closes, per instance", () =>
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

      const all = yield* persisted({ root });
      const restOnly = yield* persisted({ root, instances: ["rest-1"] });
      const recent = yield* persisted({ root, since: 2_000, instances: ["rest-1"] });

      expect(texts(all).toSorted()).toEqual(["auth second", "rest first", "rest third"]);
      expect(restOnly.map(({ kind, text }) => [kind, text])).toEqual([
        ["launch", undefined],
        ["stdout", "rest first"],
        ["stdout", "rest third"],
      ]);
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
        const reader = yield* collect(
          opened.store.read("restart", { from: "oldest", tail: 0, follow: true }),
        );
        yield* instance.publish(instance.chunk(1, `${text}\n`));
        yield* reader.take(2);
        yield* opened.close;
      }

      const directory = path.join(root, "auth", "restart");
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        "0000000001.log",
        "0000000002.log",
      ]);
      const records = yield* persisted({ root });
      expect(texts(records)).toEqual(["before restart", "after restart"]);
      expect(records.map(({ position }) => position?.generation)).toEqual([1, 1, 2, 2]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("follows only records written after an empty tailed read subscribes", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot("log-store-end-");
      const { store } = yield* openStore(root);
      const instance = yield* fakeInstance("end");
      yield* store.attach(instance);
      const history = yield* collect(store.read("end", { from: "oldest", follow: true }));
      yield* instance.publish(instance.chunk(1, "old\n"));
      yield* history.take(2);

      const reader = yield* collect(store.read("end", { from: "oldest", tail: 0, follow: true }));
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
