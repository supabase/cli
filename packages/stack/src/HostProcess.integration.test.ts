import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- integration verifies exact-port reopening.
import * as Net from "node:net";
import { fileURLToPath } from "node:url";
import { HostEndpoint, connectHost, launchHost } from "./HostProcess.ts";
import * as State from "./State.ts";

class ProcessTestError extends Data.TaggedError("ProcessTestError")<{ readonly message: string }> {}

const makeTestState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

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
          Schema.Struct({ type: Schema.Literal("ready"), endpoint: HostEndpoint }),
        ),
      )(line).pipe(
        Effect.map((message) => message.endpoint),
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

const bestEffortShutdown = (client: HttpClient.HttpClient, endpoint: HostEndpoint) =>
  Effect.exit(
    client
      .execute(
        HttpClientRequest.post(`http://127.0.0.1:${endpoint.port}/shutdown`).pipe(
          HttpClientRequest.setHeader("connection", "close"),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk)),
  ).pipe(Effect.asVoid);

const bestEffortShutdownByState = (
  client: HttpClient.HttpClient,
  state: State.Interface,
  stackId: string,
) =>
  Effect.exit(
    connectHost(state, stackId).pipe(
      Effect.flatMap((endpoint) => bestEffortShutdown(client, endpoint)),
    ),
  ).pipe(Effect.asVoid);

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

const waitForMarker = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.watch(path.dirname(marker)).pipe(
      Stream.filter((event) => event.path === path.basename(marker)),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ProcessTestError({ message: "marker watcher ended" })),
          onSome: Effect.succeed,
        }),
      ),
    );
    return yield* fs.readFileString(marker).pipe(
      Effect.map(Number),
      Effect.mapError(() => new ProcessTestError({ message: "marker read failed" })),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new ProcessTestError({ message: "slow fixture did not start" })),
    }),
  );

it.live("launches one detached owner and attaches competing launchers", () =>
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
        composition: { members: [], dependencies: [] },
        ports: [],
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
      const client = yield* HttpClient.HttpClient;
      yield* Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [launchHost(state, options), launchHost(state, options)],
          { concurrency: 2 },
        );
        expect(second.port).toBe(first.port);
        expect(second.pid).toBe(first.pid);
      }).pipe(Effect.ensuring(bestEffortShutdownByState(client, state, "stack")));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("lets an external launcher attach, then reopens the owner port after shutdown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-process-launcher-" });
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: "local" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const entrypoint = fileURLToPath(
        new URL("../tests/host-process-fixture.ts", import.meta.url),
      );
      const args = [entrypoint, root, root, "stack"];
      const owner = yield* Effect.acquireRelease(
        spawnChild(args, ["ignore", "ignore", "ignore", "pipe"]),
        stopChild,
      );
      const endpoint = yield* waitForReady(owner);
      const observedEndpoint = yield* connectHost(state, "stack");
      const client = yield* HttpClient.HttpClient;
      expect(observedEndpoint.pid).toBe(endpoint.pid);
      const ownerExitFiber = yield* waitForClose(owner).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.post(`http://127.0.0.1:${endpoint.port}/shutdown`).pipe(
            HttpClientRequest.setHeader("connection", "close"),
          ),
        );
        yield* HttpClientResponse.filterStatusOk(response);
        const ownerExit = yield* Fiber.join(ownerExitFiber);
        owner.closed = true;
        owner.closeCode = ownerExit.code;
        owner.closeSignal = ownerExit.signal;
        expect(ownerExit.signal).toBeNull();
      }).pipe(Effect.ensuring(bestEffortShutdown(client, endpoint)));
      const reopened = yield* Effect.acquireRelease(bindExact(endpoint.port), closeServer);
      expect(reopened.listening).toBe(true);
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
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        const entrypoint = fileURLToPath(
          new URL("../tests/host-process-fixture.ts", import.meta.url),
        );
        const client = yield* HttpClient.HttpClient;
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
          expect(connected).toEqual(endpoint);
        }).pipe(Effect.ensuring(bestEffortShutdownByState(client, state, "stack")));
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
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const entrypoint = fileURLToPath(
        new URL("../tests/host-process-fixture.ts", import.meta.url),
      );
      const marker = path.join(root, "slow-handshake.pid");
      const markerReady = yield* waitForMarker(marker).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const launch = yield* launchHost(state, {
        stateRoot: root,
        cacheRoot: root,
        stackId: "stack",
        entrypoint,
      }).pipe(Effect.forkChild);
      const pid = yield* Fiber.join(markerReady);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
      yield* Fiber.interrupt(launch);
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
