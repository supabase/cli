import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  Stream,
  Tracer,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- integration verifies exact-port reopening.
import * as Net from "node:net";
import { fileURLToPath } from "node:url";
import {
  HostEndpoint,
  connectHost,
  currentRelease,
  launchHost,
  shutdownHost,
  type HostAccess,
} from "./HostProcess.ts";
import { discover } from "./effect.ts";
import { watchLeaseRelease } from "../tests/owner.ts";
import { watchEntry } from "../tests/watch-entry.ts";
import * as StackNamespace from "./StackNamespace.ts";

class ProcessTestError extends Data.TaggedError("ProcessTestError")<{ readonly message: string }> {}

const fixtureEntrypoint = fileURLToPath(
  new URL("../tests/host-process-fixture.ts", import.meta.url),
);

const savedStack = (root: string, stackName: string): StackNamespace.SavedStack => ({
  id: "stack",
  runtime: "native",
  identity: { projectRoot: root, branchContext: "main", stackName },
  instances: [],
  lifetime: "detached",
  composition: { members: [], dependencies: [] },
});

/** A loopback listener that accepts connections and never answers, counting each one. */
const silentListener = Effect.acquireRelease(
  Effect.callback<
    { readonly server: Net.Server; readonly sockets: Set<Net.Socket> },
    ProcessTestError
  >((resume) => {
    const sockets = new Set<Net.Socket>();
    const server = Net.createServer((socket) => sockets.add(socket));
    server.once("error", (cause) =>
      resume(Effect.fail(new ProcessTestError({ message: cause.message }))),
    );
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server, sockets }) => {
    const address = server.address();
    return typeof address === "object" && address !== null
      ? Effect.succeed({ port: address.port, connections: () => sockets.size })
      : Effect.fail(new ProcessTestError({ message: "Silent listener has no port" }));
  }),
);

const makeTestState = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

/** Writes a holder record directly, simulating a process that published then crashed before retracting. */
const writeStaleHolder = (root: string, id: string, record: StackNamespace.LeaseHolder) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(StackNamespace.LeaseHolder))(
      record,
    );
    yield* fs.writeFileString(path.join(root, id, "owner.json"), encoded);
  });

type ChildHandle = {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  closed: boolean;
  closeCode: number | null;
  closeSignal: NodeJS.Signals | null;
};

const spawnChild = (args: ReadonlyArray<string>, stdio: Array<"ignore" | "pipe">) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, args, {
        cwd: process.cwd(),
        detached: true,
        stdin: stdio[0],
        stdout: stdio[1],
        stderr: stdio[2],
        ...(stdio[3] === "pipe" ? { additionalFds: { fd3: { type: "output" as const } } } : {}),
        forceKillAfter: "2 seconds",
      }),
    );
    const handle: ChildHandle = { child, closed: false, closeCode: null, closeSignal: null };
    return handle;
  });

const waitForClose = (handle: ChildHandle) =>
  handle.closed
    ? Effect.succeed({ code: handle.closeCode, signal: handle.closeSignal })
    : handle.child.exitCode.pipe(
        Effect.map((code) => {
          handle.closed = true;
          handle.closeCode = Number(code);
          return { code: handle.closeCode, signal: null };
        }),
        Effect.catch(() => {
          handle.closed = true;
          handle.closeCode = null;
          handle.closeSignal = null;
          return Effect.succeed({ code: null, signal: null });
        }),
      );

const waitForLine = (handle: ChildHandle, streamIndex: 1 | 3, label: string) =>
  (streamIndex === 1 ? handle.child.stdout : handle.child.getOutputFd(3)).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new ProcessTestError({ message: `${label} exited before readiness` })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new ProcessTestError({ message: `${label} readiness timed out` })),
    }),
  );

const waitForReady = (handle: ChildHandle) =>
  waitForLine(handle, 3, "Host").pipe(
    Effect.flatMap((line) =>
      Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            type: Schema.Literal("ready"),
            endpoint: HostEndpoint,
            secret: Schema.String,
          }),
        ),
      )(line).pipe(
        Effect.map(({ endpoint, secret }): HostAccess => ({ endpoint, secret })),
        Effect.mapError((cause) => new ProcessTestError({ message: String(cause) })),
      ),
    ),
  );

const waitForLauncherEndpoint = (handle: ChildHandle) =>
  waitForLine(handle, 1, "Launcher").pipe(
    Effect.flatMap((line) =>
      Schema.decodeEffect(Schema.fromJsonString(HostEndpoint))(line).pipe(
        Effect.mapError((cause) => new ProcessTestError({ message: String(cause) })),
      ),
    ),
  );

const stopChild = (handle: ChildHandle) =>
  Effect.exit(
    Effect.gen(function* () {
      if (!handle.closed)
        yield* handle.child.kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" });
      yield* waitForClose(handle);
    }),
  ).pipe(Effect.asVoid);

/** Stops an owner and waits for it to release its lease, so its files are no longer in use. */
const bestEffortShutdown = (stateRoot: string) => (access: HostAccess) =>
  Effect.scoped(
    Effect.gen(function* () {
      const released = yield* watchLeaseRelease(stateRoot, access.endpoint.stackId);
      yield* shutdownHost(access, false);
      yield* released;
    }),
  ).pipe(Effect.exit, Effect.asVoid);

const bestEffortShutdownByState = (
  stateRoot: string,
  state: StackNamespace.Interface,
  stackId: string,
) =>
  Effect.exit(connectHost(state, stackId).pipe(Effect.flatMap(bestEffortShutdown(stateRoot)))).pipe(
    Effect.asVoid,
  );

const bindExact = (port: number) =>
  Effect.callback<Net.Server, ProcessTestError>((resume) => {
    const server = Net.createServer();
    const onListening = () => resume(Effect.succeed(server));
    const onError = (cause: Error) =>
      resume(Effect.fail(new ProcessTestError({ message: cause.message })));
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port });
    return Effect.sync(() => {
      server.off("listening", onListening);
      server.off("error", onError);
    });
  });

const closeServer = (server: Net.Server) =>
  Effect.callback<void, never>((resume) => {
    server.close(() => resume(Effect.void));
  });

/** Attaches now; the returned effect awaits the marker and reads its value. Subscribe before
 * triggering the fixture that writes the marker, then await the returned effect after. */
const waitForMarker = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ready = yield* watchEntry(path.dirname(marker), path.basename(marker), true);
    return yield* Effect.succeed(
      ready.pipe(
        Effect.flatMap(() =>
          fs.readFileString(marker).pipe(
            Effect.map(Number),
            Effect.mapError(() => new ProcessTestError({ message: "marker read failed" })),
          ),
        ),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(new ProcessTestError({ message: "slow fixture did not start" })),
        }),
      ),
    );
  });

it.live("starts exactly one owner for concurrent launchers and attaches the others", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-" });
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: "local" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
      });
      const entrypoint = fileURLToPath(
        new URL("../tests/host-process-fixture.ts", import.meta.url),
      );
      const options = {
        stateRoot: root,
        cacheRoot: root,
        stackId: "stack",
        entrypoint,
      };
      yield* Effect.gen(function* () {
        const launched = yield* Effect.all(
          [launchHost(state, options), launchHost(state, options), launchHost(state, options)],
          { concurrency: "unbounded" },
        );
        expect(new Set(launched.map(({ endpoint }) => endpoint.pid)).size).toBe(1);
        expect(new Set(launched.map(({ endpoint }) => endpoint.port)).size).toBe(1);
      }).pipe(Effect.ensuring(bestEffortShutdownByState(root, state, "stack")));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("relaunches after shutdown while a foreign listener holds the previous control port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-launcher-" });
      const state = yield* makeTestState(root);
      yield* state.save(savedStack(root, "local"));
      const args = [fixtureEntrypoint, root, root, "stack"];
      const owner = yield* Effect.acquireRelease(
        spawnChild(args, ["ignore", "ignore", "ignore", "pipe"]),
        stopChild,
      );
      const access = yield* waitForReady(owner);
      const { endpoint } = access;
      const observed = yield* connectHost(state, "stack");
      const client = yield* HttpClient.HttpClient;
      expect(observed.endpoint.pid).toBe(endpoint.pid);
      const ownerExitFiber = yield* waitForClose(owner).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        const unauthenticated = yield* client.execute(
          HttpClientRequest.post(`http://127.0.0.1:${endpoint.port}/shutdown`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ destroy: true }),
          ),
        );
        expect(unauthenticated.status, "shutdown requires the owner secret").toBe(401);
        expect(Option.isNone(yield* shutdownHost(access, false))).toBe(true);
        const ownerExit = yield* Fiber.join(ownerExitFiber);
        owner.closed = true;
        owner.closeCode = ownerExit.code;
        owner.closeSignal = ownerExit.signal;
        expect(ownerExit.signal).toBeNull();
      }).pipe(Effect.ensuring(bestEffortShutdown(root)(access)));
      yield* Effect.acquireRelease(bindExact(endpoint.port), closeServer);
      const relaunched = yield* Effect.acquireRelease(
        launchHost(state, {
          stateRoot: root,
          cacheRoot: root,
          stackId: "stack",
          entrypoint: fixtureEntrypoint,
        }).pipe(Effect.provide(FetchHttpClient.layer)),
        bestEffortShutdown(root),
      );
      expect(relaunched.endpoint.pid).not.toBe(endpoint.pid);
      expect(relaunched.endpoint.port).not.toBe(endpoint.port);
      expect(yield* connectHost(state, "stack")).toEqual(relaunched);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("ignores a stale endpoint record once no process holds the lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-stale-" });
      const state = yield* makeTestState(root);
      yield* state.save(savedStack(root, "local"));
      const unresponsive = yield* silentListener;
      yield* writeStaleHolder(root, "stack", {
        role: "owner",
        secret: "stale",
        port: unresponsive.port,
        pid: process.pid,
        release: yield* currentRelease,
        lifetime: "detached",
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      const [live] = yield* discover({ stateRoot: root });
      expect(live?.host).toBeUndefined();
      const launched = yield* Effect.acquireRelease(
        launchHost(state, {
          stateRoot: root,
          cacheRoot: root,
          stackId: "stack",
          entrypoint: fixtureEntrypoint,
        }),
        bestEffortShutdown(root),
      );
      expect(launched.endpoint.port).not.toBe(unresponsive.port);
      const published = yield* state.readHolder("stack");
      expect(published?.role === "owner" ? published.port : undefined).toBe(launched.endpoint.port);
      expect(unresponsive.connections()).toBe(0);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("discovers dead stacks from their free leases without contacting recorded endpoints", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-discover-" });
      const state = yield* makeTestState(root);
      const unresponsive = yield* silentListener;
      const ids = ["dead-a", "dead-b", "dead-c"];
      for (const id of ids) {
        yield* state.save({ ...savedStack(root, id), id });
        yield* Effect.scoped(state.acquireLease(id));
        yield* writeStaleHolder(root, id, {
          role: "owner",
          secret: "stale",
          port: unresponsive.port,
          pid: process.pid,
          release: yield* currentRelease,
          lifetime: "detached",
          startedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }
      const entries = yield* discover({ stateRoot: root });
      expect(entries.map(({ definition }) => definition.id).toSorted()).toEqual(ids);
      expect(entries.every(({ host }) => host === undefined)).toBe(true);
      expect(unresponsive.connections()).toBe(0);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "starts an owner through an external launcher and keeps it reachable after launcher exit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "host-process-external-launcher-",
        });
        const state = yield* makeTestState(root);
        yield* state.save({
          id: "stack",
          runtime: "native",
          identity: { projectRoot: root, branchContext: "main", stackName: "local" },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
        });
        const entrypoint = fileURLToPath(
          new URL("../tests/host-process-fixture.ts", import.meta.url),
        );
        yield* Effect.gen(function* () {
          const args = [entrypoint, root, root, "stack", "launcher", entrypoint];
          const launcher = yield* Effect.acquireRelease(
            spawnChild(args, ["ignore", "pipe", "pipe", "ignore"]),
            stopChild,
          );
          const endpoint = yield* waitForLauncherEndpoint(launcher);
          const launcherExit = yield* waitForClose(launcher);
          expect(launcherExit.code).toBe(0);
          const connected = yield* connectHost(state, "stack");
          expect(connected.endpoint).toEqual(endpoint);
        }).pipe(Effect.ensuring(bestEffortShutdownByState(root, state, "stack")));
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("terminates a detached child when readiness is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-cancel-" });
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: "slow-handshake" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
      });
      const entrypoint = fileURLToPath(
        new URL("../tests/host-process-fixture.ts", import.meta.url),
      );
      const marker = path.join(root, "slow-handshake.pid");
      const markerReady = yield* waitForMarker(marker);
      const launch = yield* launchHost(state, {
        stateRoot: root,
        cacheRoot: root,
        stackId: "stack",
        entrypoint,
      }).pipe(Effect.forkChild);
      const pid = yield* markerReady;
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
      yield* Fiber.interrupt(launch);
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("reports a structured owner startup error without the owner log tail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-failed-start-" });
      const state = yield* makeTestState(root);
      const failure = yield* launchHost(state, {
        stateRoot: root,
        cacheRoot: root,
        stackId: "stack",
        entrypoint: fileURLToPath(new URL("../tests/failing-owner-fixture.ts", import.meta.url)),
        register: savedStack(root, "failing"),
      }).pipe(Effect.flip);
      expect(failure.message).toContain("owner startup failed");
      expect(failure.message).toContain("owner log:");
      expect(failure.message).not.toContain("failing-owner-diagnostic");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("keeps the owner secret out of recorded HTTP span attributes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-tracing-" });
      const state = yield* makeTestState(root);
      yield* state.save(savedStack(root, "local"));
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const access = yield* launchHost(state, {
        stateRoot: root,
        cacheRoot: root,
        stackId: "stack",
        entrypoint: fixtureEntrypoint,
      }).pipe(
        Effect.andThen(connectHost(state, "stack")),
        Effect.tap(bestEffortShutdown(root)),
        Effect.withTracer(tracer),
      );
      const requests = spans.filter((span) => span.attributes.has("http.request.method"));
      expect(requests.length, "identity and shutdown requests were traced").toBeGreaterThan(1);
      const attributes = spans.flatMap((span) => Array.from(span.attributes));
      expect(attributes.filter(([, value]) => String(value).includes(access.secret))).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("waits out a sweeper's hold before spawning the owner of a stack it registers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-sweeper-hold-" });
      const state = yield* makeTestState(root);
      const hold = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(hold, Exit.void));
      const lease = yield* state.acquireLease("stack").pipe(Scope.provide(hold));
      yield* lease.publishHolder({
        role: "sweeper",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      const sweeperSeen = yield* Deferred.make<void>();
      const observations = yield* Ref.make(0);
      const watched: StackNamespace.Interface = {
        ...state,
        readHolder: (id) =>
          state.readHolder(id).pipe(
            Effect.tap((holder) =>
              holder?.role !== "sweeper"
                ? Effect.void
                : Ref.updateAndGet(observations, (count) => count + 1).pipe(
                    Effect.flatMap((count) =>
                      // The first attempt has ended once the retry observes the hold again.
                      count === 2 ? Deferred.succeed(sweeperSeen, undefined) : Effect.void,
                    ),
                  ),
            ),
          ),
      };
      const launching = yield* launchHost(watched, {
        stateRoot: root,
        cacheRoot: root,
        stackId: "stack",
        register: savedStack(root, "held"),
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(sweeperSeen);
      expect(yield* fs.exists(state.ownerLog("stack")), "no owner spawned during the hold").toBe(
        false,
      );
      yield* lease.retractHolder;
      yield* Scope.close(hold, Exit.void);
      yield* Effect.acquireRelease(Fiber.join(launching), bestEffortShutdown(root));
      expect(yield* state.read("stack")).toBeDefined();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
