import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Queue,
  Redacted,
  Scope,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { tmpdir } from "node:os";
import { ownerFor } from "../tests/owner-rpc.ts";
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

/** Opens an owner that destroys its stack on scope exit unless `kept` preserves it for a later read. */
const openOwner = (
  prefix: string,
  runtime: SavedStack["runtime"],
  kept?: { readonly root: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const root = kept?.root ?? (yield* fs.makeTempDirectoryScoped({ prefix }));
    const stack = stackFor(
      `owner-logs-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`,
      runtime,
    );
    const state = Context.get(
      yield* Layer.build(State.layer({ root: `${root}/state` })),
      State.Service,
    );
    yield* state.save(stack);
    const owner = yield* ownerFor({ saved: stack, state, root: `${root}/data`, cacheRoot });
    if (kept === undefined)
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
    return {
      ...owner,
      state,
      stack,
      stateRoot: `${root}/state`,
      logsRoot: state.logsRoot(stack.id),
    };
  });

const isOutput = (record: LogRecord) => record.kind === "stdout" || record.kind === "stderr";

const firstOutput = (records: Stream.Stream<LogRecord, StackError>) =>
  records.pipe(Stream.filter(isOutput), Stream.take(1), Stream.runCollect);

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
          yield* Layer.build(State.layer({ root: owner.stateRoot })),
          State.Service,
        );
        const saved = yield* state.read(owner.stack.id);
        if (saved === undefined) return yield* Effect.die("stack state missing");
        const restarted = yield* ownerFor({ saved, state, root: `${root}/data`, cacheRoot });
        yield* Effect.addFinalizer(() => restarted.namespace.destroy.pipe(Effect.ignore));

        yield* restarted.rpc.startService({ id: mail.id });
        yield* restarted.rpc.readyService({ id: mail.id });
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
        const api = (yield* first.state.read(first.stack.id))?.ports.find(
          ({ key }) => key === "api",
        );
        if (api === undefined) return yield* Effect.die("the shared API port was not claimed");

        const response = yield* client.get(`http://127.0.0.1:${api.port}/unrouted?apikey=k`);
        const [recorded] = yield* firstOutput(first.rpc.readLogs({ id: "gateway", follow: true }));

        expect(response.status).toBe(404);
        expect(recorded?.text).toMatch(
          /^127\.0\.0\.1 - - \[[^\]]+\] "GET \/unrouted\?apikey=redacted HTTP\/1\.1" 404 9 "-" "[^"]*" \d+ms$/u,
        );
        const directory = path.join(first.logsRoot, "gateway", "gateway");
        expect(yield* fs.readDirectory(directory)).toEqual(["0000000001.log"]);
        yield* Scope.close(firstScope, Exit.void);

        const state = Context.get(
          yield* Layer.build(State.layer({ root: first.stateRoot })),
          State.Service,
        );
        const saved = yield* state.read(first.stack.id);
        if (saved === undefined) return yield* Effect.die("the stopped stack was not saved");
        const second = yield* ownerFor({ saved, state, root: `${root}/data`, cacheRoot });
        const history = Array.from(
          yield* second.rpc.readLogs({ id: "gateway", follow: false }).pipe(Stream.runCollect),
        );

        expect(history).toContainEqual(recorded);
        yield* second.namespace.destroy;
        expect(yield* fs.exists(first.logsRoot)).toBe(false);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("continues after the launch ids in its logs when its saved state has none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "owner-logs-unsaved-launch-" });
        const firstRun = yield* Scope.make();
        const owner = yield* openOwner("owner-logs-unsaved-launch-", "native", { root }).pipe(
          Scope.provide(firstRun),
        );
        const mail = yield* owner.rpc.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* Scope.close(firstRun, Exit.void);
        const state = Context.get(
          yield* Layer.build(State.layer({ root: owner.stateRoot })),
          State.Service,
        );
        const saved = yield* state.read(owner.stack.id);
        if (saved === undefined) return yield* Effect.die("stack state missing");
        // Logs a state saved before launch ids were persisted left behind at launch 3.
        const directory = `${owner.logsRoot}/mail/${mail.id}`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/0000000001.log`,
          "2026-01-01T00:00:00.000Z launch 3 | \n2026-01-01T00:00:00.001Z stdout 3 | earlier\n",
        );
        const restarted = yield* ownerFor({ saved, state, root: `${root}/data`, cacheRoot });
        yield* Effect.addFinalizer(() => restarted.namespace.destroy.pipe(Effect.ignore));

        yield* restarted.rpc.startService({ id: mail.id });
        yield* restarted.rpc.readyService({ id: mail.id });
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
          const owner = yield* openOwner("owner-logs-docker-", "docker");
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
