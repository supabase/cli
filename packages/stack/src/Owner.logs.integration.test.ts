import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Queue,
  Redacted,
  Scope,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import { tmpdir } from "node:os";
import { engineTarget, testEngine } from "../tests/engine-target.ts";
import { ownerFor } from "../tests/owner-rpc.ts";
import type { LogRecord } from "./host/LogRecord.ts";
import { StackError, streamStackLogs } from "./effect.ts";
import * as LogStore from "./host/LogStore.ts";
import * as StackNamespace from "./StackNamespace.ts";
import type { SavedStack } from "./StackNamespace.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

const stackFor = (id: string, runtime: SavedStack["runtime"]): SavedStack => ({
  id,
  identity: { projectRoot: "/tmp/project", branchContext: "owner-logs-test", stackName: id },
  runtime,
  instances: [],
  lifetime: "detached",
  composition: { members: [], dependencies: [] },
});

/** Opens an owner that destroys its stack on scope exit unless `kept` preserves it for a later read. */
const openOwner = (
  prefix: string,
  runtime: SavedStack["runtime"],
  kept?: { readonly root: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const root = kept?.root ?? (yield* fs.makeTempDirectoryScoped({ prefix }));
    const stack = stackFor(
      `owner-logs-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`,
      runtime,
    );
    const state = Context.get(
      yield* Layer.build(StackNamespace.layer({ root: `${root}/state` })),
      StackNamespace.Service,
    );
    yield* state.save(stack);
    const owner = yield* ownerFor({
      saved: stack,
      state,
      root: `${root}/data`,
      cacheRoot,
      ...(runtime === "native" ? {} : { engineTarget }),
    });
    if (kept === undefined)
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
    return {
      ...owner,
      state,
      stack,
      stateRoot: `${root}/state`,
      logsRoot: StackNamespace.stackLogsRoot(path, `${root}/state`, stack.id),
    };
  });

/** The port the shared API listener serves a service's `http` endpoint on. */
const httpPort = (
  observation: Effect.Effect<
    { readonly endpoints: ReadonlyArray<{ readonly name: string; readonly port: number }> },
    StackError
  >,
) =>
  observation.pipe(
    Effect.flatMap(({ endpoints }) => {
      const http = endpoints.find(({ name }) => name === "http");
      return http === undefined
        ? Effect.die("the service has no http endpoint")
        : Effect.succeed(http.port);
    }),
  );

const isOutput = (record: LogRecord) => record.kind === "stdout" || record.kind === "stderr";

const firstOutput = (records: Stream.Stream<LogRecord, StackError>) =>
  records.pipe(Stream.filter(isOutput), Stream.take(1), Stream.runCollect);

/** Follows from the oldest record until `count` launch markers are persisted. */
const awaitLaunches = (records: Stream.Stream<LogRecord, StackError>, count: number) =>
  records.pipe(
    Stream.filter(({ kind }) => kind === "launch"),
    Stream.take(count),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );

describe("owner persisted logs", () => {
  it.live("persists native output, serves history and follow, and deletes it on destroy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const owner = yield* openOwner("owner-logs-native-", "native");
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: mail.id });
        yield* owner.rpc.readyService({ id: mail.id });

        const [followed] = yield* firstOutput(owner.rpc.readLogs({ id: mail.id, follow: true }));
        const history = Array.from(
          yield* owner.rpc.readLogs({ id: mail.id, follow: false }).pipe(Stream.runCollect),
        );

        expect(history[0]).toMatchObject({ kind: "launch", launchId: 1 });
        expect(history).toContainEqual(followed);
        const directory = path.join(owner.logsRoot, "mail", mail.id);
        expect(yield* fs.exists(directory)).toBe(true);
        const offline = yield* LogStore.streamStackLogs({ root: owner.logsRoot }).pipe(
          Stream.filter(({ instanceId }) => instanceId === mail.id),
          Stream.runCollect,
        );
        expect(offline.slice(0, history.length).map(({ position }) => position)).toEqual(
          history.map(({ position }) => position),
        );

        yield* owner.rpc.destroyService({ id: mail.id });
        expect(yield* fs.exists(directory)).toBe(false);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("streams history through the public API after the owner stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-offline-" });
        const ownerScope = yield* Scope.make();
        const owner = yield* openOwner("owner-logs-offline-", "native", { root }).pipe(
          Scope.provide(ownerScope),
        );
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: mail.id });
        yield* owner.rpc.readyService({ id: mail.id });
        const [followed] = yield* firstOutput(owner.rpc.readLogs({ id: mail.id, follow: true }));
        yield* owner.rpc.stopService({ id: mail.id });
        yield* Scope.close(ownerScope, Exit.void);

        const selection = { stateRoot: owner.stateRoot, stackId: owner.stack.id };
        const records = yield* streamStackLogs(selection).pipe(
          Stream.filter(({ instanceId }) => instanceId === mail.id),
          Stream.runCollect,
        );
        const invalid = yield* streamStackLogs({ ...selection, since: "soon" }).pipe(
          Stream.runDrain,
          Effect.flip,
        );

        expect(records[0]).toMatchObject({ kind: "launch", service: "mail", instanceId: mail.id });
        expect(records.map(({ text }) => text)).toContain(followed?.text);
        expect(invalid).toBeInstanceOf(StackError);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("continues an instance's launch ids after the owner restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-relaunch-" });
        const firstRun = yield* Scope.make();
        const owner = yield* openOwner("owner-logs-relaunch-", "native", { root }).pipe(
          Scope.provide(firstRun),
        );
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: mail.id });
        yield* owner.rpc.readyService({ id: mail.id });
        yield* owner.rpc.stopService({ id: mail.id });
        yield* Scope.close(firstRun, Exit.void);
        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root: owner.stateRoot })),
          StackNamespace.Service,
        );
        const saved = yield* state.read(owner.stack.id);
        if (saved === undefined) return yield* Effect.die("stack state missing");
        const restarted = yield* ownerFor({ saved, state, root: `${root}/data`, cacheRoot });
        yield* Effect.addFinalizer(() => restarted.namespace.destroy.pipe(Effect.ignore));

        const launched = yield* awaitLaunches(
          restarted.rpc.readLogs({ id: mail.id, follow: true }),
          2,
        );
        yield* restarted.rpc.startService({ id: mail.id });
        yield* restarted.rpc.readyService({ id: mail.id });
        yield* Fiber.join(launched);
        const records = yield* restarted.rpc
          .readLogs({ id: mail.id, follow: false })
          .pipe(Stream.runCollect);

        expect(
          records.filter(({ kind }) => kind === "launch").map(({ launchId }) => launchId),
        ).toEqual([1, 2]);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("keeps shared API requests as gateway logs across owner restarts until destroy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-gateway-" });
        const firstScope = yield* Scope.make();
        // Closes the first owner if the test fails before the restart closes it.
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
        const first = yield* openOwner("owner-logs-gateway-", "native", { root }).pipe(
          Scope.provide(firstScope),
        );
        const rest = yield* first.rpc.createService({
          service: "rest",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* first.rpc.configureComposition({
          members: [{ id: rest.id, activation: "lazy" }],
          dependencies: [],
        });
        yield* first.rpc.startComposition();
        const api = yield* httpPort(first.rpc.status({ id: rest.id }));

        const response = yield* client.get(`http://127.0.0.1:${api}/unrouted`);
        const [recorded] = yield* firstOutput(first.rpc.readLogs({ id: "gateway", follow: true }));

        expect(response.status).toBe(404);
        expect(recorded).toMatchObject({ launchId: 1, text: expect.stringContaining("/unrouted") });
        const directory = path.join(first.logsRoot, "gateway", "gateway");
        expect(yield* fs.readDirectory(directory)).toEqual(["0000000001.log"]);
        yield* Scope.close(firstScope, Exit.void);
        // A crash right after rotation leaves an empty newest segment.
        yield* fs.writeFileString(path.join(directory, "0000000002.log"), "");

        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root: first.stateRoot })),
          StackNamespace.Service,
        );
        const saved = yield* state.read(first.stack.id);
        if (saved === undefined) return yield* Effect.die("the stopped stack was not saved");
        const second = yield* ownerFor({ saved, state, root: `${root}/data`, cacheRoot });
        const history = Array.from(
          yield* second.rpc.readLogs({ id: "gateway", follow: false }).pipe(Stream.runCollect),
        );
        const begun = yield* second.rpc.readLogs({ id: "gateway", follow: true }).pipe(
          Stream.filter(({ kind, launchId }) => kind === "launch" && launchId === 2),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        yield* second.rpc.startComposition();
        const reopened = yield* httpPort(second.rpc.status({ id: rest.id }));
        const again = yield* second.rpc.readLogs({ id: "gateway", follow: true }).pipe(
          Stream.filter((record) => isOutput(record) && record.text?.includes("/again") === true),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* client.get(`http://127.0.0.1:${reopened}/again`);

        expect(history).toContainEqual(recorded);
        expect(begun).toHaveLength(1);
        expect(Array.from(yield* Fiber.join(again))).toMatchObject([{ launchId: 2 }]);
        yield* second.namespace.destroy;
        expect(yield* fs.exists(first.logsRoot)).toBe(false);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("resumes a follow at a record position without replaying earlier records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* openOwner("owner-logs-resume-", "native");
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: mail.id });
        yield* owner.rpc.readyService({ id: mail.id });
        const history = Array.from(
          yield* owner.rpc.readLogs({ id: mail.id, follow: false }).pipe(Stream.runCollect),
        );
        const last = history.at(-1);
        if (last?.position === undefined) return yield* Effect.die("mail wrote no records");
        const resumed = yield* Queue.unbounded<LogRecord>();
        yield* owner.rpc.readLogs({ id: mail.id, from: last.position, follow: true }).pipe(
          Stream.runForEach((record) => Queue.offer(resumed, record)),
          Effect.forkScoped,
        );

        yield* owner.rpc.restartService({ id: mail.id });
        const first = yield* Queue.take(resumed);
        const relaunched = yield* Queue.take(resumed).pipe(
          Effect.repeat({ until: (record) => record.kind === "launch" }),
        );

        expect(first).toEqual(last);
        expect(relaunched).toMatchObject({ kind: "launch", launchId: 2 });
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live(
    "keeps database logs across a data reset and removes all logs with the stack",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const owner = yield* openOwner("owner-logs-reset-", "native");
          const database = yield* owner.rpc.createService({
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("owner-logs-reset-password"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          });
          yield* owner.rpc.startService({ id: database.id });
          yield* owner.rpc.readyService({ id: database.id });
          yield* owner.rpc.stopService({ id: database.id });
          const before = Array.from(
            yield* owner.rpc.readLogs({ id: database.id, follow: false }).pipe(Stream.runCollect),
          );

          yield* owner.rpc.resetData({ id: database.id });
          const after = Array.from(
            yield* owner.rpc.readLogs({ id: database.id, follow: false }).pipe(Stream.runCollect),
          );

          expect(before.some(isOutput)).toBe(true);
          expect(after.slice(0, before.length)).toEqual(before);
          yield* owner.namespace.destroy;
          expect(yield* fs.exists(owner.logsRoot)).toBe(false);
        }),
      ).pipe(Effect.provide(services)),
    { timeout: 120_000 },
  );

  it.live.skipIf(process.platform === "win32")(
    "persists container output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* openOwner("owner-logs-docker-", testEngine);
          const mail = yield* owner.rpc.createService({
            service: "mail",
            config: {},
            endpoints: { http: { port: "auto" } },
          });
          yield* owner.rpc.startService({ id: mail.id });
          yield* owner.rpc.readyService({ id: mail.id });

          const [followed] = yield* firstOutput(owner.rpc.readLogs({ id: mail.id, follow: true }));
          const persisted = yield* LogStore.streamStackLogs({ root: owner.logsRoot }).pipe(
            Stream.runCollect,
          );

          expect(followed).toMatchObject({ launchId: 1 });
          expect(Array.from(persisted, ({ position }) => position)).toContainEqual(
            followed?.position,
          );
        }),
      ).pipe(Effect.provide(services)),
    { timeout: 120_000 },
  );
});
