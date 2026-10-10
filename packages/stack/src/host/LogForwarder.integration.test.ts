import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  PlatformError,
  PubSub,
  Queue,
  Ref,
  References,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  makeFakeLogflare,
  type FakeLogflare,
  type FakeLogflareOptions,
  type Received,
} from "../../tests/fake-logflare.ts";
import { makeManualClock, type ManualClock } from "../../tests/manual-clock.ts";
import type { LaunchOutput } from "../runtime/Session.ts";
import { CatalogError } from "../services/Recipe.ts";
import * as GatewayLog from "./GatewayLog.ts";
import type { LogRecord } from "./LogRecord.ts";
import * as LogForwarder from "./LogForwarder.ts";
import * as LogStore from "./LogStore.ts";

const { flushWindowMillis, pollMillis, postTimeoutMillis, retryMillis, stuckMillis } = LogForwarder;

/** Takes the next post, running each stored-id poll the forwarder waits on until one arrives. */
const nextPost = (logflare: FakeLogflare, manual: ManualClock): Effect.Effect<Received> =>
  logflare.next.pipe(
    Effect.raceFirst(
      manual
        .sleeping(pollMillis)
        .pipe(
          Effect.andThen(manual.advance(pollMillis)),
          Effect.andThen(Effect.suspend(() => nextPost(logflare, manual))),
        ),
    ),
  );

/**
 * Stores each post as it arrives and runs out each stored-id wait of the forwarder until `done`
 * holds for the posts taken so far; returns them.
 */
const drive = (
  logflare: FakeLogflare,
  manual: ManualClock,
  done: (posts: ReadonlyArray<Received>) => Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    const posts: Array<Received> = [];
    for (let step = 0; !(yield* done(posts)); step++) {
      if (step > 5_000) return yield* Effect.die("the forwarder stopped making progress");
      if ((yield* logflare.unread) > 0) {
        posts.push(yield* logflare.next);
        yield* logflare.apply();
        continue;
      }
      yield* manual.sleeping(pollMillis);
      if ((yield* logflare.unread) === 0) yield* manual.advance(stuckMillis);
    }
    return posts;
  });

type Serving = LogForwarder.ForwardedInstance["serving"] extends Stream.Stream<infer A> ? A : never;

const serving = (launchId = 1): Serving => ({ serving: true, launchId });

const notServing = (launchId?: number): Serving => ({ serving: false, launchId });

const encoder = new TextEncoder();

/** A shipped service instance, named after its service, whose output a real log store persists. */
const serviceSource = (
  store: LogStore.Interface,
  service: "database" | "auth" | "storage" = "database",
) =>
  Effect.gen(function* () {
    const logs = yield* PubSub.unbounded<LaunchOutput>();
    const observation = yield* SubscriptionRef.make(serving());
    yield* store.attach({
      service,
      instanceId: service,
      logs: PubSub.subscribe(logs),
      launches: SubscriptionRef.changes(observation).pipe(Stream.map(({ launchId }) => launchId)),
    });
    let seq = 0;
    const written = yield* Queue.unbounded<LogRecord>();
    yield* (yield* store.read(service, { from: "oldest", follow: true })).pipe(
      Stream.runForEach((record) => Queue.offer(written, record)),
      Effect.forkScoped,
    );
    /** Publishes lines and waits until the store has persisted the last one. */
    const log = (...lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const time = yield* Clock.currentTimeMillis;
        yield* PubSub.publish(logs, {
          stream: "stdout",
          bytes: encoder.encode(lines.map((line) => `${line}\n`).join("")),
          launchId: 1,
          part: 0,
          seq: seq++,
          time,
        });
        const last = lines.at(-1);
        while ((yield* Queue.take(written)).text !== last);
      });
    return {
      log,
      instance: {
        id: service,
        service,
        endpoint: () => Effect.fail(new CatalogError({ operation: "endpoint", message: "unused" })),
        creation: Effect.die("Only the Analytics creation is read"),
        serving: SubscriptionRef.changes(observation),
      } satisfies LogForwarder.ForwardedInstance,
    };
  });

const analyticsTarget = (port: Effect.Effect<number>) =>
  Effect.gen(function* () {
    const observation = yield* SubscriptionRef.make(notServing());
    return {
      observation,
      set: (awake: boolean) => SubscriptionRef.set(observation, awake ? serving() : notServing()),
      /** Restarts Analytics as a new launch, which loses whatever the previous one had queued. */
      relaunch: (launchId: number) =>
        SubscriptionRef.set(observation, notServing()).pipe(
          Effect.andThen(SubscriptionRef.set(observation, serving(launchId))),
        ),
      instance: {
        id: "analytics",
        service: "analytics" as const,
        endpoint: () =>
          port.pipe(
            Effect.map((current) => ({
              kind: "tcp" as const,
              host: "127.0.0.1" as const,
              port: current,
            })),
          ),
        creation: Effect.succeed({ service: "analytics" as const, config: { apiKey: "test-key" } }),
        serving: SubscriptionRef.changes(observation),
      } satisfies LogForwarder.ForwardedInstance,
    };
  });

const composition = Effect.succeed({
  members: [
    { id: "analytics", activation: "lazy" as const },
    { id: "database", activation: "eager" as const },
    { id: "auth", activation: "eager" as const },
  ],
  dependencies: [],
});

/** Starts a forwarder in its own scope so a test can stop it like an owner. */
const startForwarder = (
  store: LogStore.Interface,
  logflare: FakeLogflare,
  instances: ReadonlyArray<LogForwarder.ForwardedInstance | LogForwarder.ForwardedStream>,
  clock?: Clock.Clock,
  stored?: LogForwarder.StoredEvents,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    // Stops before the test's store and temp directory close, so no cursor write races removal.
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const forwarder = yield* LogForwarder.make({
      composition,
      logs: store,
      storedEvents: () => (stored === undefined ? logflare.storedEvents : Effect.succeed(stored)),
    }).pipe(Scope.provide(scope));
    for (const instance of instances) yield* forwarder.attach(instance);
    yield* forwarder.rebind;
    const awaitShipping = (value: boolean) =>
      forwarder.shipping.pipe(
        Stream.filter((current) => current === value),
        Stream.take(1),
        Stream.runDrain,
      );
    return { awaitShipping, detach: forwarder.detach, stop: Scope.close(scope, Exit.void) };
  }).pipe(clock === undefined ? (effect) => effect : Effect.provideService(Clock.Clock, clock));

/** Without `logflare` options, the fake stores each accepted post right away. */
const fixture = (
  options: {
    readonly store?: Omit<LogStore.LogStoreOptions, "root">;
    readonly logflare?: FakeLogflareOptions;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "log-forwarder-" });
    const store = yield* LogStore.make({ root, ...options.store });
    const logflare = yield* makeFakeLogflare(options.logflare ?? { flushMillis: 0 });
    const database = yield* serviceSource(store);
    const analytics = yield* analyticsTarget(Effect.succeed(logflare.port));
    return { root, store, logflare, database, analytics };
  });

const messages = (post: Received) => post.events.map((event) => event.event_message);
const ids = (post: Received) => post.events.map((event) => event.id);
const storedMessages = (logflare: FakeLogflare) =>
  logflare.stored.pipe(Effect.map((events) => events.map((event) => event.event_message)));

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

describe("LogForwarder", () => {
  it.live(
    "ships records written while Analytics slept with their timestamps, without markers",
    () =>
      Effect.gen(function* () {
        const { root, store, logflare, database, analytics } = yield* fixture();
        const forwarder = yield* startForwarder(store, logflare, [
          analytics.instance,
          database.instance,
        ]);
        yield* database.log("while asleep 1", "while asleep 2");

        yield* analytics.set(true);
        yield* forwarder.awaitShipping(true);
        const caughtUp = yield* logflare.next;
        yield* database.log("while awake");
        const live = yield* logflare.next;

        expect(caughtUp.url).toBe("/api/logs?source_name=postgres.logs");
        expect(caughtUp.apiKey).toBe("test-key");
        expect(messages(caughtUp)).toEqual(["while asleep 1", "while asleep 2"]);
        expect(messages(live)).toEqual(["while awake"]);
        const persisted = (yield* LogStore.streamStackLogs({ root }).pipe(
          Stream.runCollect,
        )).filter((record) => record.kind === "stdout");
        expect([...caughtUp.events, ...live.events].map((event) => event.timestamp)).toEqual(
          persisted.map((record) => record.timestamp),
        );
        expect(new Set([...ids(caughtUp), ...ids(live)]).size).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "ships a record persisted while Analytics slept once it wakes on a new port, letting the post in flight across the retarget finish without repeating it",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database } = yield* fixture({ logflare: {} });
        const manual = yield* makeManualClock;
        const firstLaunch = yield* Scope.make();
        const asleepPort = yield* logflare.listen(firstLaunch);
        const port = yield* Ref.make(asleepPort);
        const analytics = yield* analyticsTarget(Ref.get(port));
        yield* analytics.set(true);
        const forwarder = yield* startForwarder(
          store,
          logflare,
          [analytics.instance, database.instance],
          manual.clock,
        );
        const release = yield* logflare.hold;
        yield* database.log("while awake");
        const beforeSleep = yield* logflare.next;

        yield* SubscriptionRef.set(analytics.observation, notServing(1));
        yield* forwarder.awaitShipping(false);
        yield* SubscriptionRef.set(analytics.observation, notServing());
        yield* database.log("while asleep");
        yield* Ref.set(port, logflare.port);
        yield* logflare.respond(503);
        yield* SubscriptionRef.set(analytics.observation, notServing(2));
        yield* SubscriptionRef.set(analytics.observation, serving(2));
        yield* forwarder.awaitShipping(true);
        yield* logflare.apply();
        yield* release;
        yield* Scope.close(firstLaunch, Exit.void);
        // The retired session may save the asleep record as pending to launch 1 before it ends,
        // which holds the next post until its saved deadline plus the flush window passed.
        const unavailable = yield* nextPost(logflare, manual);
        yield* manual.sleeping(pollMillis);
        yield* manual.advance(flushWindowMillis);
        const caughtUp = yield* logflare.next;
        yield* logflare.apply();

        expect(beforeSleep.port).toBe(asleepPort);
        expect(messages(beforeSleep)).toEqual(["while awake"]);
        expect(yield* logflare.aborted).toBe(0);
        expect(unavailable.port).toBe(logflare.port);
        expect(messages(unavailable)).toEqual(["while asleep"]);
        expect(ids(caughtUp)).toEqual(ids(unavailable));
        expect(yield* storedMessages(logflare)).toEqual(["while awake", "while asleep"]);
        expect(yield* logflare.dropped).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ships only instances of the composition", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture();
      const standalone = yield* serviceSource(store, "storage");
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [
        analytics.instance,
        standalone.instance,
        database.instance,
      ]);

      yield* standalone.log("standalone line");
      yield* database.log("composed line");
      const posted = yield* logflare.next;
      yield* database.log("later line");
      const later = yield* logflare.next;

      expect(messages(posted)).toEqual(["composed line"]);
      expect(messages(later)).toEqual(["later line"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("stops shipping quietly when the log store closes", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture();
      const warnings: Array<unknown> = [];
      const stopped = yield* Deferred.make<void>();
      const captured = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
          if (logLevel === "Debug" && String(message).includes("stopped"))
            Deferred.doneUnsafe(stopped, Effect.void);
        }),
      ]);
      const forwarder = yield* startForwarder(store, logflare, [
        analytics.instance,
        database.instance,
      ]).pipe(Effect.provide(captured), Effect.provideService(References.MinimumLogLevel, "Debug"));
      yield* analytics.set(true);
      yield* forwarder.awaitShipping(true);
      yield* database.log("before removal");
      const shipped = yield* logflare.next;

      yield* store.close;
      yield* Deferred.await(stopped);
      yield* forwarder.stop;

      expect(messages(shipped)).toEqual(["before removal"]);
      expect(warnings).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ships again after a failed log read while Analytics stays healthy", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture();
      const reads = yield* Ref.make(0);
      const flaky: LogStore.Interface = {
        ...store,
        read: (instanceId, options) =>
          Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 0
                ? Effect.succeed(
                    Stream.fail(
                      new LogStore.LogStoreError({ operation: "read", message: "injected" }),
                    ),
                  )
                : store.read(instanceId, options),
            ),
          ),
      };
      const warnings: Array<unknown> = [];
      const captured = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        }),
      ]);
      const manual = yield* makeManualClock;
      yield* database.log("after a failed read");
      yield* analytics.set(true);

      yield* startForwarder(
        flaky,
        logflare,
        [analytics.instance, database.instance],
        manual.clock,
      ).pipe(Effect.provide(captured));
      yield* manual.sleeping(retryMillis);
      yield* manual.advance(retryMillis);
      const shipped = yield* logflare.next;

      expect(messages(shipped)).toEqual(["after a failed read"]);
      expect(warnings).toEqual([
        ["Reading database logs to ship failed; retrying", expect.anything()],
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("detaches an instance only once its cursor write landed, so its logs can go", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, store, logflare, database, analytics } = yield* fixture();
      const renaming = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const injected: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) =>
          to.endsWith("cursor.json")
            ? Deferred.succeed(renaming, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.rename(from, to)),
              )
            : fs.rename(from, to),
      };
      const forwarder = yield* startForwarder(store, logflare, [
        analytics.instance,
        database.instance,
      ]).pipe(Effect.provideService(FileSystem.FileSystem, injected));
      yield* analytics.set(true);
      yield* forwarder.awaitShipping(true);
      yield* database.log("before removal");
      yield* Deferred.await(renaming);

      const directory = path.join(root, "database", "database");
      const detaching = yield* Effect.forkChild(forwarder.detach("database"), {
        startImmediately: true,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(detaching);
      const cursorLanded = yield* fs.exists(path.join(directory, "cursor.json"));
      yield* store.remove({ service: "database", instanceId: "database" });

      expect(cursorLanded).toBe(true);
      expect(yield* fs.exists(directory)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("resumes from its persisted cursor after the forwarder restarts", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      const first = yield* startForwarder(store, logflare, [analytics.instance, database.instance]);
      yield* database.log("line 1", "line 2");
      const shipped = yield* logflare.next;
      yield* database.log("line 3");
      const third = yield* logflare.next;
      yield* first.stop;

      yield* database.log("line 4");
      yield* startForwarder(store, logflare, [analytics.instance, database.instance]);
      const resumed = yield* logflare.next;

      expect(messages(shipped)).toEqual(["line 1", "line 2"]);
      expect(messages(third)).toEqual(["line 3"]);
      expect(messages(resumed)).toEqual(["line 4"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "does not post an accepted body again after an interruption before it was confirmed",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
        const manual = yield* makeManualClock;
        const instances = [analytics.instance, database.instance];
        yield* analytics.set(true);
        const first = yield* startForwarder(store, logflare, instances, manual.clock);
        const release = yield* logflare.hold;
        yield* database.log("line 1");
        const accepted = yield* logflare.next;

        const stopping = yield* Effect.forkChild(first.stop, { startImmediately: true });
        yield* release;
        yield* Fiber.join(stopping);
        yield* logflare.apply();
        yield* startForwarder(store, logflare, instances, manual.clock);
        yield* database.log("line 2");
        const resumed = yield* logflare.next;
        yield* logflare.apply();

        expect(messages(accepted)).toEqual(["line 1"]);
        expect(messages(resumed)).toEqual(["line 2"]);
        expect(yield* storedMessages(logflare)).toEqual(["line 1", "line 2"]);
        expect(yield* logflare.dropped).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("posts again only the events Analytics has not stored when its cursor is lost", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, store, logflare, database, analytics } = yield* fixture({ logflare: {} });
      const manual = yield* makeManualClock;
      const instances = [analytics.instance, database.instance];
      yield* analytics.set(true);
      const first = yield* startForwarder(store, logflare, instances, manual.clock);
      yield* database.log("line 1");
      yield* logflare.next;
      yield* logflare.apply();
      yield* database.log("line 2");
      yield* nextPost(logflare, manual);
      yield* first.stop;
      yield* logflare.discard;
      yield* fs.remove(path.join(root, "database", "database", "cursor.json"), { force: true });
      yield* database.log("line 3");

      yield* startForwarder(store, logflare, instances, manual.clock);
      const reposted: Array<string> = [];
      while (reposted.at(-1) !== "line 3") {
        reposted.push(...messages(yield* nextPost(logflare, manual)));
        yield* logflare.apply();
      }

      expect(reposted).toEqual(["line 2", "line 3"]);
      expect(yield* logflare.dropped).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("posts a body Analytics failed again before any later body", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
      const manual = yield* makeManualClock;
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [analytics.instance, database.instance], manual.clock);
      yield* logflare.respond(500);
      const lines = Array.from({ length: 300 }, (_, index) => `burst ${index}`);

      yield* database.log(...lines);
      const failed = yield* logflare.next;
      yield* manual.sleeping(pollMillis);
      yield* manual.advance(flushWindowMillis);
      const retried = yield* logflare.next;
      yield* logflare.apply();
      const rest = yield* nextPost(logflare, manual);

      expect(ids(retried)).toEqual(ids(failed));
      expect([...messages(retried), ...messages(rest)]).toEqual(lines);
      expect(failed.events.length).toBeLessThanOrEqual(256);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "posts accepted events Analytics has not stored again to its next launch, not to the launch that may still store them",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
        const manual = yield* makeManualClock;
        yield* analytics.set(true);
        yield* startForwarder(
          store,
          logflare,
          [analytics.instance, database.instance],
          manual.clock,
        );
        yield* database.log("line 1", "line 2");
        const posted = yield* logflare.next;

        yield* manual.sleeping(pollMillis);
        yield* manual.advance(stuckMillis - pollMillis);
        yield* manual.sleeping(pollMillis);
        const resentToSameLaunch = yield* logflare.unread;
        yield* logflare.discard;
        yield* analytics.relaunch(2);
        const resent = yield* logflare.next;
        yield* logflare.apply();
        yield* database.log("line 3");
        const later = yield* nextPost(logflare, manual);

        expect(resentToSameLaunch).toBe(0);
        expect(ids(resent)).toEqual(ids(posted));
        expect(messages(later)).toEqual(["line 3"]);
        expect(yield* storedMessages(logflare)).toEqual(["line 1", "line 2"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("posts again only the events Analytics did not store", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture({
        logflare: { batchEvents: 2 },
      });
      const manual = yield* makeManualClock;
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [analytics.instance, database.instance], manual.clock);
      yield* database.log("line 1", "line 2", "line 3", "line 4");
      const posted = yield* logflare.next;
      yield* logflare.apply(1);
      yield* logflare.discard;

      yield* manual.sleeping(pollMillis);
      yield* manual.advance(postTimeoutMillis + flushWindowMillis);
      yield* analytics.relaunch(2);
      const resent = yield* logflare.next;
      yield* logflare.apply();

      expect(messages(posted)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
      expect(messages(resent)).toEqual(["line 3", "line 4"]);
      expect(yield* storedMessages(logflare)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
      expect(yield* logflare.dropped).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "waits for a post that timed out after Analytics queued it instead of posting it again",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
        const manual = yield* makeManualClock;
        yield* analytics.set(true);
        yield* startForwarder(
          store,
          logflare,
          [analytics.instance, database.instance],
          manual.clock,
        );
        const release = yield* logflare.hold;
        yield* database.log("line 1");
        const queued = yield* logflare.next;

        yield* manual.sleeping(postTimeoutMillis);
        yield* manual.advance(postTimeoutMillis);
        yield* manual.sleeping(pollMillis);
        yield* logflare.apply();
        yield* database.log("line 2");
        const later = yield* nextPost(logflare, manual);
        yield* release;

        expect(messages(queued)).toEqual(["line 1"]);
        expect(messages(later)).toEqual(["line 2"]);
        expect(yield* logflare.dropped).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("posts nothing while it cannot save its cursor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
      const manual = yield* makeManualClock;
      const broken = yield* Ref.make(true);
      const injected: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) =>
          Ref.get(broken).pipe(
            Effect.flatMap((failing) =>
              failing && to.endsWith("cursor.json")
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                      description: "injected cursor write failure",
                    }),
                  )
                : fs.rename(from, to),
            ),
          ),
      };
      yield* analytics.set(true);
      yield* startForwarder(
        store,
        logflare,
        [analytics.instance, database.instance],
        manual.clock,
      ).pipe(Effect.provideService(FileSystem.FileSystem, injected));

      yield* database.log("line 1");
      const first = yield* logflare.next.pipe(
        Effect.as("posted"),
        Effect.raceFirst(manual.sleeping(retryMillis).pipe(Effect.as("retrying"))),
      );
      yield* Ref.set(broken, false);
      yield* manual.advance(retryMillis);
      const posted = yield* logflare.next;

      expect(first).toBe("retrying");
      expect(messages(posted)).toEqual(["line 1"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "posts a pending body again after a restart only once the previous owner's launch had time to store it since its slow post ended",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
        const manual = yield* makeManualClock;
        const instances = [analytics.instance, database.instance];
        const checking = yield* Queue.unbounded<void>();
        const checked = yield* Deferred.make<void>();
        const slowCheck: LogForwarder.StoredEvents = {
          storedIds: (source, eventIds) =>
            Queue.offer(checking, undefined).pipe(
              Effect.andThen(Deferred.await(checked)),
              Effect.andThen(logflare.storedIds(source, eventIds)),
            ),
        };
        yield* analytics.set(true);
        const first = yield* startForwarder(store, logflare, instances, manual.clock, slowCheck);
        yield* database.log("line 1");
        yield* Queue.take(checking);
        yield* manual.advance(2_000);
        const release = yield* logflare.hold;
        yield* Deferred.succeed(checked, undefined);
        const posted = yield* logflare.next;
        yield* manual.advance(2_000);
        yield* release;
        yield* manual.sleeping(pollMillis);
        yield* logflare.discard;
        yield* first.stop;

        yield* startForwarder(store, logflare, instances, manual.clock);
        yield* manual.sleeping(pollMillis);
        yield* manual.advance(stuckMillis - 1);
        yield* manual.sleeping(pollMillis);
        const resentInWindow = yield* logflare.unread;
        yield* manual.advance(postTimeoutMillis);
        const resent = yield* logflare.next;

        expect(resentInWindow).toBe(0);
        expect(ids(resent)).toEqual(ids(posted));
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "does not post a body again after a restart while the previous owner's launch still stores it late",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
        const manual = yield* makeManualClock;
        const instances = [analytics.instance, database.instance];
        yield* analytics.set(true);
        const first = yield* startForwarder(store, logflare, instances, manual.clock);
        yield* database.log("line 1");
        yield* logflare.next;
        yield* manual.sleeping(pollMillis);
        yield* first.stop;

        yield* startForwarder(store, logflare, instances, manual.clock);
        yield* manual.sleeping(pollMillis);
        yield* manual.advance(postTimeoutMillis + 2 * flushWindowMillis);
        yield* manual.sleeping(pollMillis);
        const resentBeforeDrain = yield* logflare.unread;
        yield* logflare.apply();
        yield* database.log("line 2");
        const later = yield* nextPost(logflare, manual);
        yield* logflare.apply();

        expect(resentBeforeDrain).toBe(0);
        expect(messages(later)).toEqual(["line 2"]);
        expect(yield* storedMessages(logflare)).toEqual(["line 1", "line 2"]);
        expect(yield* logflare.dropped).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("posts a body again after 429s without skipping any of it", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture({ logflare: {} });
      const manual = yield* makeManualClock;
      const warnings: Array<unknown> = [];
      const captured = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        }),
      ]);
      yield* analytics.set(true);
      yield* startForwarder(
        store,
        logflare,
        [analytics.instance, database.instance],
        manual.clock,
      ).pipe(Effect.provide(captured));
      yield* logflare.respond(429, 429, 429);

      yield* database.log("line 1", "line 2");
      const attempts = [yield* logflare.next];
      while (attempts.length < 4) {
        yield* manual.sleeping(pollMillis);
        yield* manual.advance(flushWindowMillis);
        attempts.push(yield* logflare.next);
      }
      yield* logflare.apply();
      yield* database.log("line 3");
      const later = yield* nextPost(logflare, manual);
      yield* logflare.apply();

      expect(attempts.map(messages)).toEqual(Array.from({ length: 4 }, () => ["line 1", "line 2"]));
      expect(messages(later)).toEqual(["line 3"]);
      expect(yield* storedMessages(logflare)).toEqual(["line 1", "line 2", "line 3"]);
      expect(warnings).toEqual([
        ["Posting postgres.logs logs of database failed; retrying", expect.anything()],
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("warns about pending events retention deleted and ships the retained records", () =>
    Effect.gen(function* () {
      const { root, store, logflare, database, analytics } = yield* fixture({
        store: { rotateBytes: 200, retainBytes: 400 },
        logflare: {},
      });
      const manual = yield* makeManualClock;
      const instances = [analytics.instance, database.instance];
      const warnings: Array<unknown> = [];
      const captured = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        }),
      ]);
      yield* analytics.set(true);
      const first = yield* startForwarder(store, logflare, instances, manual.clock);
      yield* database.log("first");
      yield* logflare.next;
      yield* logflare.discard;
      yield* manual.sleeping(pollMillis);
      yield* first.stop;
      for (let index = 0; index < 30; index++) yield* database.log(`later ${index}`);
      const retained = (yield* LogStore.streamStackLogs({ root }).pipe(Stream.runCollect)).filter(
        (record) => record.kind === "stdout",
      );

      yield* startForwarder(store, logflare, instances, manual.clock).pipe(
        Effect.provide(captured),
      );
      yield* manual.sleeping(pollMillis);
      yield* manual.advance(postTimeoutMillis + stuckMillis);
      const shipped: Array<string> = [];
      while (shipped.at(-1) !== "later 29") {
        shipped.push(...messages(yield* nextPost(logflare, manual)));
        yield* logflare.apply();
      }

      expect(retained.map((record) => record.text)).not.toContain("first");
      expect(shipped).toEqual(retained.map((record) => record.text));
      expect(warnings).toEqual([
        [
          "Logs of database instance database were deleted before Analytics stored them; skipping 1 line",
        ],
        [
          "Logs of database instance database were deleted before shipping; resuming from the next retained record",
        ],
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("pauses without advancing when Analytics refuses its credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { store, logflare, database, analytics } = yield* fixture();
      const manual = yield* makeManualClock;
      const refused = yield* Deferred.make<void>();
      const savedAfterRefusal = yield* Deferred.make<void>();
      const saved = (file: string) =>
        Deferred.isDone(refused).pipe(
          Effect.flatMap((done) =>
            done && file.endsWith("cursor.json")
              ? Deferred.succeed(savedAfterRefusal, undefined)
              : Effect.void,
          ),
        );
      // A cursor with neither a confirmed position nor a pending body is removed, not written.
      const injected: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) => fs.rename(from, to).pipe(Effect.andThen(saved(to))),
        remove: (file, options) => fs.remove(file, options).pipe(Effect.andThen(saved(file))),
      };
      yield* analytics.set(true);
      yield* startForwarder(
        store,
        logflare,
        [analytics.instance, database.instance],
        manual.clock,
      ).pipe(Effect.provideService(FileSystem.FileSystem, injected));
      yield* logflare.respond(401);
      // Holding the answer arms the gate before the forwarder can act on the refusal.
      const release = yield* logflare.hold;

      yield* database.log("refused line");
      const refusedPost = yield* logflare.next;
      yield* Deferred.succeed(refused, undefined);
      yield* release;
      // A retried post first waits on the clock, so the cursor write wins only when it pauses.
      const outcome = yield* Deferred.await(savedAfterRefusal).pipe(
        Effect.as("paused"),
        Effect.raceFirst(manual.sleeping(pollMillis).pipe(Effect.as("retrying"))),
      );
      yield* analytics.relaunch(2);
      const resumed = yield* logflare.next;

      expect(outcome).toBe("paused");
      expect(messages(refusedPost)).toEqual(["refused line"]);
      expect(ids(resumed)).toEqual(ids(refusedPost));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("halves a body Analytics rejects and skips only the line it still rejects alone", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [analytics.instance, database.instance]);
      yield* logflare.respond(400, 400);

      yield* database.log("rejected line", "accepted line");
      const posts = [yield* logflare.next, yield* logflare.next, yield* logflare.next];
      yield* database.log("next line");
      const next = yield* logflare.next;

      expect(posts.map(messages)).toEqual([
        ["rejected line", "accepted line"],
        ["rejected line"],
        ["accepted line"],
      ]);
      expect(messages(next)).toEqual(["next line"]);
      // The next line is posted only once the earlier body is confirmed stored.
      expect((yield* storedMessages(logflare))[0]).toBe("accepted line");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("stores a line holding NUL, replaced, instead of losing its batch", () =>
    Effect.gen(function* () {
      const { store, logflare, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [analytics.instance, database.instance]);

      yield* database.log("before \u0000 after", "next line");
      const posted = yield* logflare.next;
      yield* database.log("later");
      yield* logflare.next;

      expect(messages(posted)).toEqual(["before � after", "next line"]);
      expect((yield* storedMessages(logflare)).slice(0, 2)).toEqual(messages(posted));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("keeps shipping an instance's lines after a JSON line nested too deep for metadata", () =>
    Effect.gen(function* () {
      const { store, logflare, analytics } = yield* fixture();
      const auth = yield* serviceSource(store, "auth");
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [analytics.instance, auth.instance]);
      const depth = 16_000;
      const deep = `{"detail":${"[".repeat(depth)}${"]".repeat(depth)}}`;

      yield* auth.log(deep);
      const posted = yield* logflare.next;
      yield* auth.log("later line");
      const later = yield* logflare.next;

      expect(messages(posted)).toEqual([deep]);
      expect(messages(later)).toEqual(["later line"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "isolates one unstorable event among 256 by halving, skips it alone, and ships the rest",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({
          logflare: { unstorable: (event) => event.event_message === "line 100" },
        });
        const manual = yield* makeManualClock;
        const warnings: Array<unknown> = [];
        const captured = Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(message);
          }),
        ]);
        yield* startForwarder(
          store,
          logflare,
          [analytics.instance, database.instance],
          manual.clock,
        ).pipe(Effect.provide(captured));
        const lines = Array.from({ length: 256 }, (_, index) => `line ${index}`);
        const storedCount = storedMessages(logflare).pipe(Effect.map((stored) => stored.length));

        // Seeded while Analytics sleeps, so no read can land mid-append and split the 256 lines.
        yield* database.log(...lines);
        yield* analytics.set(true);
        const posts = yield* drive(logflare, manual, () =>
          Effect.map(storedCount, (n) => n >= 255),
        );
        yield* database.log("later");
        yield* drive(logflare, manual, () => Effect.map(storedCount, (n) => n >= 256));

        expect(yield* storedMessages(logflare)).toEqual([
          ...lines.filter((line) => line !== "line 100"),
          "later",
        ]);
        expect(posts.filter((post) => post.events.length === 1).map(messages)).toContainEqual([
          "line 100",
        ]);
        expect(posts.length).toBeLessThan(40);
        expect(warnings).toEqual([
          [
            "Analytics has not stored 256 postgres.logs lines of database it accepted; posting them in halves",
          ],
          [
            "Skipping 1 postgres.logs line of database that Analytics did not store while it stored later posts when posted on their own",
          ],
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "keeps a lone unstored line pending while Analytics stores only another source's posts",
    () =>
      Effect.gen(function* () {
        const { store, logflare, database, analytics } = yield* fixture({
          logflare: { unstorable: (event) => event.event_message.startsWith("db ") },
        });
        const auth = yield* serviceSource(store, "auth");
        const manual = yield* makeManualClock;
        const isDatabase = (post: Received) => post.url.includes("source_name=postgres.logs");
        yield* analytics.set(true);
        yield* startForwarder(
          store,
          logflare,
          [analytics.instance, database.instance, auth.instance],
          manual.clock,
        );

        yield* database.log("db line");
        yield* drive(logflare, manual, (posts) =>
          Effect.succeed(posts.filter(isDatabase).length >= 2),
        );
        yield* database.log("db later");
        // Storing before the answer lets auth confirm without a clock tick that could make the
        // database line stuck; its next post shows the stored one was recorded.
        const release = yield* logflare.hold;
        yield* auth.log("auth line");
        yield* logflare.next;
        yield* logflare.apply();
        yield* release;
        yield* auth.log("auth later");
        yield* logflare.next;
        yield* logflare.apply();
        const posts = yield* drive(logflare, manual, (taken) =>
          Effect.succeed(taken.some(isDatabase)),
        );

        expect(posts.filter(isDatabase).map(messages)).toEqual([["db line"]]);
        expect(yield* storedMessages(logflare)).toEqual(["auth line", "auth later"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("keeps every event while Analytics stores nothing and ships them once it recovers", () =>
    Effect.gen(function* () {
      let storing = false;
      const { store, logflare, database, analytics } = yield* fixture({
        logflare: { unstorable: () => !storing },
      });
      const manual = yield* makeManualClock;
      const warnings: Array<unknown> = [];
      const captured = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        }),
      ]);
      yield* analytics.set(true);
      yield* startForwarder(
        store,
        logflare,
        [analytics.instance, database.instance],
        manual.clock,
      ).pipe(Effect.provide(captured));
      const lines = ["line 1", "line 2", "line 3", "line 4"];
      const storedCount = storedMessages(logflare).pipe(Effect.map((stored) => stored.length));

      yield* database.log(...lines);
      yield* drive(logflare, manual, () => Effect.sync(() => warnings.length >= 2));
      const retried = yield* drive(logflare, manual, (posts) => Effect.succeed(posts.length >= 8));
      const warnedWhileBroken = [...warnings];
      storing = true;
      yield* drive(logflare, manual, () => Effect.map(storedCount, (n) => n >= 4));
      yield* database.log("later");
      yield* drive(logflare, manual, () => Effect.map(storedCount, (n) => n >= 5));

      expect(yield* storedMessages(logflare)).toEqual([...lines, "later"]);
      expect(warnedWhileBroken).toEqual([
        [
          "Analytics has not stored 4 postgres.logs lines of database it accepted; posting them in halves",
        ],
        [
          "Analytics stored none of 4 postgres.logs lines of database posted on their own; waiting until it stores them",
        ],
      ]);
      expect(retried.map(messages)).toEqual([...lines, ...lines].map((line) => [line]));
      expect(warnings).toEqual(warnedWhileBroken);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ships from the oldest retained record when its cursor is unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, store, logflare, database, analytics } = yield* fixture();
      yield* database.log("before a corrupt cursor");
      yield* fs.writeFileString(path.join(root, "database", "database", "cursor.json"), "{oops");

      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [analytics.instance, database.instance]);
      const shipped = yield* logflare.next;

      expect(messages(shipped)).toEqual(["before a corrupt cursor"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("restarts from the oldest retained segment when its cursor's segment was deleted", () =>
    Effect.gen(function* () {
      const { root, store, logflare, database, analytics } = yield* fixture({
        store: { rotateBytes: 200, retainBytes: 400 },
      });
      yield* analytics.set(true);
      const forwarder = yield* startForwarder(store, logflare, [
        analytics.instance,
        database.instance,
      ]);
      yield* database.log("first");
      yield* logflare.next;
      yield* database.log("second");
      yield* logflare.next;
      yield* analytics.set(false);
      yield* forwarder.awaitShipping(false);
      for (let index = 0; index < 30; index++) yield* database.log(`asleep ${index}`);
      const retained = (yield* LogStore.streamStackLogs({ root }).pipe(Stream.runCollect)).filter(
        (record) => record.kind === "stdout",
      );

      yield* analytics.set(true);
      const shipped: Array<string> = [];
      while (shipped.at(-1) !== "asleep 29") shipped.push(...messages(yield* logflare.next));

      expect(retained.map((record) => record.text)).not.toContain("second");
      expect(shipped).toEqual(retained.map((record) => record.text));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ships gateway lines to cloudflare.logs.prod", () =>
    Effect.gen(function* () {
      const { store, logflare, analytics } = yield* fixture({ logflare: {} });
      const gateway = yield* GatewayLog.make;
      yield* store.attach({
        ...GatewayLog.gatewayLog,
        logs: gateway.logs,
        launches: gateway.launches,
      });
      yield* gateway.begin(1);
      yield* analytics.set(true);
      yield* startForwarder(store, logflare, [
        analytics.instance,
        { id: GatewayLog.gatewayLog.instanceId, service: GatewayLog.gatewayLog.service },
      ]);

      yield* gateway.record({
        time: Date.parse("2026-10-01T09:25:23.000Z"),
        client: "127.0.0.1",
        method: "POST",
        target: "/auth/v1/token?grant_type=password",
        protocol: "HTTP/1.1",
        status: 400,
        bytes: 60,
        durationMillis: 3,
      });
      const shipped = yield* logflare.next;
      yield* logflare.apply();

      expect(shipped.url).toBe("/api/logs?source_name=cloudflare.logs.prod");
      expect(shipped.events).toEqual([expect.objectContaining({ appname: "gateway" })]);
      expect(yield* logflare.storedIds("cloudflare.logs.prod", ids(shipped))).toEqual(
        new Set(ids(shipped)),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
