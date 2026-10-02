import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { createServer } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
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
  PubSub,
  Queue,
  Ref,
  References,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { ServiceObservation } from "../Service.ts";
import type { LaunchOutput } from "../runtime/Session.ts";
import { CatalogError } from "../services/Recipe.ts";
import type { LogRecord } from "./LogRecord.ts";
import * as LogForwarder from "./LogForwarder.ts";
import * as LogStore from "./LogStore.ts";

const Body = Schema.Struct({
  batch: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      event_message: Schema.String,
      appname: Schema.String,
      timestamp: Schema.String,
      metadata: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
type Event = Schema.Schema.Type<typeof Body>["batch"][number];

interface Received {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly events: ReadonlyArray<Event>;
}

const decodeBody = Schema.decodeUnknownSync(Body);

/** A Logflare stand-in that records posts and answers the next `failures` of them with `status`. */
const makeSink = Effect.gen(function* () {
  const received = yield* Queue.unbounded<Received>();
  const control = { failures: 0, status: 500 };
  const server = yield* Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly server: ReturnType<typeof createServer> }>(
      (resume) => {
        const server = createServer((request, response) => {
          const chunks: Array<Uint8Array> = [];
          request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
          request.on("end", () => {
            const apiKey = request.headers["x-api-key"];
            Queue.offerUnsafe(received, {
              url: request.url ?? "",
              apiKey: typeof apiKey === "string" ? apiKey : undefined,
              events: decodeBody(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))).batch,
            });
            response.statusCode = control.failures > 0 ? control.status : 200;
            control.failures = Math.max(0, control.failures - 1);
            response.end();
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string")
            return resume(Effect.die("sink has no address"));
          resume(Effect.succeed({ port: address.port, server }));
        });
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return {
    port: server.port,
    next: Queue.take(received),
    failNext: (count: number, status = 500) =>
      Effect.sync(() => {
        control.failures = count;
        control.status = status;
      }),
  };
});

const observationOf = (
  id: string,
  overrides: Partial<ServiceObservation<unknown>>,
): ServiceObservation<unknown> => ({
  id,
  config: undefined,
  lifecycle: "stopped",
  health: undefined,
  error: undefined,
  cleanupError: undefined,
  exit: undefined,
  currentOperation: undefined,
  launchId: undefined,
  intentRevision: 0,
  wakeEnabled: true,
  registered: true,
  ...overrides,
});

const serving = (id: string) =>
  observationOf(id, { lifecycle: "running", health: "healthy", launchId: 1 });

const encoder = new TextEncoder();

/** A database instance whose output a real log store persists. */
const databaseSource = (store: LogStore.Interface) =>
  Effect.gen(function* () {
    const logs = yield* PubSub.unbounded<LaunchOutput>();
    const observation = yield* SubscriptionRef.make(serving("database"));
    yield* store.attach({
      service: "database",
      instanceId: "database",
      logs: PubSub.subscribe(logs),
      observation: SubscriptionRef.changes(observation).pipe(
        Stream.map(({ launchId }) => ({ launchId })),
      ),
    });
    let seq = 0;
    const written = yield* Queue.unbounded<LogRecord>();
    yield* (yield* store.read("database", { from: "oldest", follow: true })).pipe(
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
        id: "database",
        service: "database" as const,
        endpoint: () => Effect.fail(new CatalogError({ operation: "endpoint", message: "unused" })),
        creation: Effect.die("Only the Analytics creation is read"),
        observation: SubscriptionRef.changes(observation),
      } satisfies LogForwarder.ForwardedInstance,
    };
  });

const analyticsTarget = (port: number) =>
  Effect.gen(function* () {
    const observation = yield* SubscriptionRef.make(observationOf("analytics", {}));
    return {
      set: (awake: boolean) =>
        SubscriptionRef.set(
          observation,
          awake ? serving("analytics") : observationOf("analytics", { lifecycle: "stopped" }),
        ),
      instance: {
        id: "analytics",
        service: "analytics" as const,
        endpoint: () => Effect.succeed({ kind: "tcp" as const, host: "127.0.0.1" as const, port }),
        creation: Effect.succeed({ service: "analytics" as const, config: { apiKey: "test-key" } }),
        observation: SubscriptionRef.changes(observation),
      } satisfies LogForwarder.ForwardedInstance,
    };
  });

const composition = Effect.succeed({
  members: [
    { id: "analytics", activation: "lazy" as const },
    { id: "database", activation: "eager" as const },
  ],
  dependencies: [],
});

/** Starts a forwarder in its own scope so a test can stop it like an owner. */
const startForwarder = (
  store: LogStore.Interface,
  instances: ReadonlyArray<LogForwarder.ForwardedInstance>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    // Stops before the test's store and temp directory close, so no cursor write races removal.
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const forwarder = yield* LogForwarder.make({ composition, logs: store }).pipe(
      Scope.provide(scope),
    );
    for (const instance of instances) yield* forwarder.attach(instance);
    yield* forwarder.rebind;
    const awaitShipping = (value: boolean) =>
      forwarder.shipping.pipe(
        Stream.filter((current) => current === value),
        Stream.take(1),
        Stream.runDrain,
      );
    return { awaitShipping, detach: forwarder.detach, stop: Scope.close(scope, Exit.void) };
  });

const fixture = (options: Omit<LogStore.LogStoreOptions, "root"> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "log-forwarder-" });
    const store = yield* LogStore.make({ root, ...options });
    const sink = yield* makeSink;
    const database = yield* databaseSource(store);
    const analytics = yield* analyticsTarget(sink.port);
    return { root, store, sink, database, analytics };
  });

const messages = (post: Received) => post.events.map((event) => event.event_message);

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

describe("LogForwarder", () => {
  it.live(
    "ships records written while Analytics slept with their timestamps, without markers",
    () =>
      Effect.gen(function* () {
        const { root, store, sink, database, analytics } = yield* fixture();
        const forwarder = yield* startForwarder(store, [analytics.instance, database.instance]);
        yield* database.log("while asleep 1", "while asleep 2");

        yield* analytics.set(true);
        yield* forwarder.awaitShipping(true);
        const caughtUp = yield* sink.next;
        yield* database.log("while awake");
        const live = yield* sink.next;

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
        const ids = [...caughtUp.events, ...live.events].map((event) => event.id);
        expect(new Set(ids).size).toBe(3);
        expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab]/u.test(id))).toBe(
          true,
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("stops shipping quietly when the log store closes", () =>
    Effect.gen(function* () {
      const { store, sink, database, analytics } = yield* fixture();
      const warnings: Array<unknown> = [];
      const stopped = yield* Deferred.make<void>();
      const captured = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
          if (logLevel === "Debug" && String(message).includes("stopped"))
            Deferred.doneUnsafe(stopped, Effect.void);
        }),
      ]);
      const forwarder = yield* startForwarder(store, [analytics.instance, database.instance]).pipe(
        Effect.provide(captured),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
      yield* analytics.set(true);
      yield* forwarder.awaitShipping(true);
      yield* database.log("before removal");
      const shipped = yield* sink.next;

      yield* store.close;
      yield* Deferred.await(stopped);
      yield* forwarder.stop;

      expect(messages(shipped)).toEqual(["before removal"]);
      expect(warnings).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ships again after a failed log read while Analytics stays healthy", () =>
    Effect.gen(function* () {
      const { store, sink, database, analytics } = yield* fixture();
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
      yield* database.log("after a failed read");
      yield* analytics.set(true);

      yield* startForwarder(flaky, [analytics.instance, database.instance]).pipe(
        Effect.provide(captured),
      );
      const shipped = yield* sink.next;

      expect(messages(shipped)).toEqual(["after a failed read"]);
      expect(yield* Ref.get(reads)).toBe(2);
      expect(warnings).toEqual([
        ["Reading database logs to ship failed; retrying", expect.anything()],
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("removes an instance's stale cursor write directories when it attaches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, store, database, analytics } = yield* fixture();
      const directory = path.join(root, "database", "database");
      const stale = path.join(directory, ".state-write-stale");
      const recent = path.join(directory, ".state-write-recent");
      yield* fs.makeDirectory(stale, { recursive: true });
      yield* fs.makeDirectory(recent, { recursive: true });
      // A numeric file time is in seconds.
      const twoDaysAgo = (yield* Clock.currentTimeMillis) / 1000 - 2 * 24 * 60 * 60;
      yield* fs.utimes(stale, twoDaysAgo, twoDaysAgo);

      yield* startForwarder(store, [analytics.instance, database.instance]);

      expect(yield* fs.exists(stale)).toBe(false);
      expect(yield* fs.exists(recent)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("detaches an instance only once its cursor write landed, so its logs can go", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, store, sink, database, analytics } = yield* fixture();
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
      const forwarder = yield* startForwarder(store, [analytics.instance, database.instance]).pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
      );
      yield* analytics.set(true);
      yield* forwarder.awaitShipping(true);
      yield* database.log("before removal");
      yield* sink.next;
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
      const { store, sink, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      const first = yield* startForwarder(store, [analytics.instance, database.instance]);
      yield* database.log("line 1", "line 2");
      const shipped = yield* sink.next;
      // Shipping line 3 implies the cursor passed lines 1 and 2 before it.
      yield* database.log("line 3");
      const third = yield* sink.next;
      yield* first.stop;

      yield* database.log("line 4");
      yield* startForwarder(store, [analytics.instance, database.instance]);
      const resumed: Array<Event> = [];
      while (resumed.at(-1)?.event_message !== "line 4") resumed.push(...(yield* sink.next).events);

      expect(messages(shipped)).toEqual(["line 1", "line 2"]);
      expect(messages(third)).toEqual(["line 3"]);
      expect(["line 3", "line 4"]).toEqual(
        expect.arrayContaining(resumed.map((e) => e.event_message)),
      );
      const repeated = resumed.find((event) => event.event_message === "line 3");
      if (repeated !== undefined) expect(repeated.id).toBe(third.events[0]?.id);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("posts an unsettled body again before any later body", () =>
    Effect.gen(function* () {
      const { store, sink, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      yield* startForwarder(store, [analytics.instance, database.instance]);
      yield* sink.failNext(1);
      const lines = Array.from({ length: 300 }, (_, index) => `burst ${index}`);

      yield* database.log(...lines);
      const failed = yield* sink.next;
      const retried = yield* sink.next;
      const shipped = [...retried.events];
      while (shipped.length < lines.length) shipped.push(...(yield* sink.next).events);

      expect(retried.events.map((event) => event.id)).toEqual(
        failed.events.map((event) => event.id),
      );
      expect(shipped.map((event) => event.event_message)).toEqual(lines);
      expect(Math.max(failed.events.length, retried.events.length)).toBeLessThanOrEqual(256);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("pauses without advancing when Analytics refuses its credentials", () =>
    Effect.gen(function* () {
      const { store, sink, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      const forwarder = yield* startForwarder(store, [analytics.instance, database.instance]);
      yield* sink.failNext(1, 401);

      yield* database.log("refused line");
      const refused = yield* sink.next;
      yield* analytics.set(false);
      yield* forwarder.awaitShipping(false);
      yield* analytics.set(true);
      const resumed = yield* sink.next;

      expect(messages(refused)).toEqual(["refused line"]);
      expect(resumed.events.map((event) => event.id)).toEqual(
        refused.events.map((event) => event.id),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("skips a body Analytics rejects and ships the next one", () =>
    Effect.gen(function* () {
      const { store, sink, database, analytics } = yield* fixture();
      yield* analytics.set(true);
      yield* startForwarder(store, [analytics.instance, database.instance]);
      yield* sink.failNext(1, 400);

      yield* database.log("rejected line");
      const rejected = yield* sink.next;
      yield* database.log("accepted line");
      const accepted = yield* sink.next;

      expect(messages(rejected)).toEqual(["rejected line"]);
      expect(messages(accepted)).toEqual(["accepted line"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ships from the oldest retained record when its cursor is unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, store, sink, database, analytics } = yield* fixture();
      yield* database.log("before a corrupt cursor");
      yield* fs.writeFileString(path.join(root, "database", "database", "cursor.json"), "{oops");

      yield* analytics.set(true);
      yield* startForwarder(store, [analytics.instance, database.instance]);
      const shipped = yield* sink.next;

      expect(messages(shipped)).toEqual(["before a corrupt cursor"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("restarts from the oldest retained segment when its cursor's segment was deleted", () =>
    Effect.gen(function* () {
      const { root, store, sink, database, analytics } = yield* fixture({
        rotateBytes: 200,
        retainBytes: 400,
      });
      yield* analytics.set(true);
      const forwarder = yield* startForwarder(store, [analytics.instance, database.instance]);
      yield* database.log("first");
      yield* sink.next;
      yield* database.log("second");
      yield* sink.next;
      yield* analytics.set(false);
      yield* forwarder.awaitShipping(false);
      for (let index = 0; index < 30; index++) yield* database.log(`asleep ${index}`);
      const retained = (yield* LogStore.streamStackLogs({ root }).pipe(Stream.runCollect)).filter(
        (record) => record.kind === "stdout",
      );

      yield* analytics.set(true);
      const shipped: Array<Event> = [];
      while (shipped.at(-1)?.event_message !== "asleep 29")
        shipped.push(...(yield* sink.next).events);

      expect(retained.map((record) => record.text)).not.toContain("second");
      expect(shipped.map((event) => event.event_message)).toEqual(
        retained.map((record) => record.text),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
