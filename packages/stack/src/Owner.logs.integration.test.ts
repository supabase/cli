import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
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
import { tmpdir } from "node:os";
import { ownerFor, registerLeased } from "../tests/owner-rpc.ts";
import { sharedStateRoot, uniqueStackId } from "../tests/helpers/integration-state.ts";
import type { LogRecord } from "./host/LogRecord.ts";
import { StackError, streamStackLogs } from "./effect.ts";
import * as LogStore from "./host/LogStore.ts";
import * as State from "./State.ts";
import type { SavedStack } from "./State.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

const stackFor = (id: string, runtime: SavedStack["runtime"]): SavedStack => ({
  id,
  identity: { projectRoot: "/tmp/project", branchContext: "owner-logs-test", stackName: id },
  runtime,
  instances: [],
  lifetime: "detached",
  composition: { members: [], dependencies: [] },
  ports: [],
});

/** Leases a fresh stack on the shared state root for the enclosing scope. */
const registerStack = (prefix: string, runtime: SavedStack["runtime"]) =>
  Effect.gen(function* () {
    const stack = stackFor(uniqueStackId(prefix), runtime);
    const stateRoot = sharedStateRoot();
    const state = Context.get(yield* Layer.build(State.layer({ root: stateRoot })), State.Service);
    yield* registerLeased(state, stack);
    return { stack, state, stateRoot };
  });

/**
 * Opens an owner for an already-registered stack, destroying it on scope exit unless `persist`
 * keeps it for a later reopen. Call `registerStack` in the enclosing scope so a reopen after an
 * inner scope closes reuses its lease instead of taking it again.
 */
const openOwner = (
  registered: {
    readonly stack: SavedStack;
    readonly state: State.Interface;
    readonly stateRoot: string;
  },
  dataRoot: string,
  persist = false,
) =>
  Effect.gen(function* () {
    const owner = yield* ownerFor({
      saved: registered.stack,
      state: registered.state,
      root: `${dataRoot}/data`,
      cacheRoot,
    });
    if (!persist) yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
    return {
      ...owner,
      state: registered.state,
      stack: registered.stack,
      stateRoot: registered.stateRoot,
      logsRoot: registered.state.logsRoot(registered.stack.id),
    };
  });

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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-native-" });
        const registered = yield* registerStack("owner-logs-native", "native");
        const owner = yield* openOwner(registered, root);
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
        const registered = yield* registerStack("owner-logs-offline", "native");
        const ownerScope = yield* Scope.make();
        const owner = yield* openOwner(registered, root, true).pipe(Scope.provide(ownerScope));
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
        const records = yield* streamStackLogs(selection).pipe(Stream.runCollect);
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
        const registered = yield* registerStack("owner-logs-relaunch", "native");
        const firstRun = yield* Scope.make();
        const owner = yield* openOwner(registered, root, true).pipe(Scope.provide(firstRun));
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: mail.id });
        yield* owner.rpc.readyService({ id: mail.id });
        yield* owner.rpc.stopService({ id: mail.id });
        yield* Scope.close(firstRun, Exit.void);
        const saved = yield* registered.state.read(registered.stack.id);
        if (saved === undefined) return yield* Effect.die("stack state missing");
        const restarted = yield* ownerFor({
          saved,
          state: registered.state,
          root: `${root}/data`,
          cacheRoot,
        });
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

  it.live("continues after the launch ids in its logs when its saved state has none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-unsaved-launch-" });
        const registered = yield* registerStack("owner-logs-unsaved-launch", "native");
        const firstRun = yield* Scope.make();
        const owner = yield* openOwner(registered, root, true).pipe(Scope.provide(firstRun));
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* Scope.close(firstRun, Exit.void);
        const saved = yield* registered.state.read(registered.stack.id);
        if (saved === undefined) return yield* Effect.die("stack state missing");
        // Logs a state saved before launch ids were persisted left behind at launch 3.
        const directory = `${owner.logsRoot}/mail/${mail.id}`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/0000000001.log`,
          "2026-01-01T00:00:00.000Z launch 3 | \n2026-01-01T00:00:00.001Z stdout 3 | earlier\n",
        );
        const restarted = yield* ownerFor({
          saved,
          state: registered.state,
          root: `${root}/data`,
          cacheRoot,
        });
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

        expect(saved.instances.find(({ id }) => id === mail.id)?.launchId).toBeUndefined();
        expect(
          records.filter(({ kind }) => kind === "launch").map(({ launchId }) => launchId),
        ).toEqual([3, 4]);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("resumes a follow at a record position without replaying earlier records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-resume-" });
        const registered = yield* registerStack("owner-logs-resume", "native");
        const owner = yield* openOwner(registered, root);
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
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-reset-" });
          const registered = yield* registerStack("owner-logs-reset", "native");
          const owner = yield* openOwner(registered, root);
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
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-docker-" });
          const registered = yield* registerStack("owner-logs-docker", "docker");
          const owner = yield* openOwner(registered, root);
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
