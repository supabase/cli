import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Ref,
  Stream,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as HttpClient from "effect/unstable/http/HttpClient";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- integration observes exact listener closure.
import * as Net from "node:net";
import { acquireHost, launchHost } from "./HostProcess.ts";
import * as Owner from "./Owner.ts";
import { OwnerError } from "./Owner.ts";
import { OrchestratorError } from "./Orchestrator.ts";
import { StackRpc } from "./Rpc.ts";
import * as State from "./State.ts";
import { makeRuntime } from "./StackHost.ts";
import { postgres } from "./Tools.ts";
import * as ToolRunner from "./host/ToolRunner.ts";

class HostTestError extends Data.TaggedError("HostTestError")<{ readonly message: string }> {}

const stateFor = (root: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(State.layer({ root }));
    return Context.get(context, State.Service);
  });

const hostTestError = (cause: unknown) =>
  new HostTestError({ message: cause instanceof Error ? cause.message : String(cause) });

const ownerFor = (options: {
  readonly saved: Parameters<typeof Owner.layer>[0]["saved"];
  readonly state: State.Interface;
  readonly root: string;
  readonly cacheRoot: string;
}) => {
  const { state, ...layerOptions } = options;
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      Owner.layer(layerOptions).pipe(Layer.provide(Layer.succeed(State.Service, state))),
    );
    return Context.get(context, Owner.Service);
  });
};

const clientFor = (port: number) =>
  RpcClient.make(StackRpc).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/rpc` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ),
  );

const openIdleSocket = (port: number) =>
  Effect.callback<Net.Socket, HostTestError>((resume) => {
    let socket: Net.Socket;
    try {
      socket = Net.connect(port, "127.0.0.1");
    } catch (cause) {
      resume(Effect.fail(hostTestError(cause)));
      return Effect.void;
    }
    const onConnect = () => resume(Effect.succeed(socket));
    const onError = (cause: Error) => resume(Effect.fail(hostTestError(cause)));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  });

const awaitClosed = (socket: Net.Socket) =>
  Effect.callback<void, HostTestError>((resume) => {
    if (socket.destroyed) {
      resume(Effect.void);
      return Effect.void;
    }
    const onClose = () => resume(Effect.void);
    socket.once("close", onClose);
    return Effect.sync(() => socket.off("close", onClose));
  });

const inProcessRuntime = (
  owner: Parameters<typeof makeRuntime>[0],
  state: State.Interface,
  root: string,
) =>
  Effect.gen(function* () {
    const acquired = yield* acquireHost(state, "stack");
    const toolContext = yield* Layer.build(
      ToolRunner.layer({
        stackId: "stack",
        root,
        cacheRoot: "/tmp/supabase-stack-artifacts",
        runtime: "native",
      }),
    );
    const runtime = yield* makeRuntime(
      owner,
      {
        stackId: "stack",
        identity: { projectRoot: root, branchContext: "main", stackName: "host" },
        pid: process.pid,
        port: acquired.port,
      },
      acquired.server,
      acquired.closeConnections,
    ).pipe(Effect.provideService(ToolRunner.Service, Context.get(toolContext, ToolRunner.Service)));
    yield* runtime.serve;
    return { runtime, port: acquired.port };
  });

const abortBeforeRpcBody = (port: number) =>
  Effect.callback<void, HostTestError>((resume) => {
    let socket: Net.Socket;
    try {
      socket = Net.connect(port, "127.0.0.1");
    } catch (cause) {
      resume(Effect.fail(hostTestError(cause)));
      return Effect.void;
    }
    const onConnect = () =>
      socket.write(
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/ndjson\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n",
        () => socket.destroy(),
      );
    const onClose = () => resume(Effect.void);
    const onError = (cause: Error) => resume(Effect.fail(hostTestError(cause)));
    socket.once("connect", onConnect);
    socket.once("close", onClose);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.destroy();
    });
  });

it.live("preserves composition outcomes over RPC", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-outcomes-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "host-outcomes" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      };
      yield* state.save(saved);
      const owner = yield* ownerFor({
        saved,
        state,
        root: `${root}/data`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
      });
      const failed = new OrchestratorError({ operation: "start", message: "member failed" });
      const delayedOwner = {
        ...owner,
        composition: {
          ...owner.composition,
          start: Effect.fail(
            new OwnerError({
              operation: "composition",
              message: "Composition start had failures",
              cause: new OrchestratorError({
                operation: "start",
                message: "Composition start had failures",
                outcomes: [
                  { id: "healthy", result: Exit.succeed(undefined) },
                  { id: "failed", result: Exit.fail(failed) },
                ],
              }),
            }),
          ),
        },
      };
      const { runtime } = yield* inProcessRuntime(delayedOwner, state, root);
      const client = yield* clientFor(runtime.endpoint.port);
      const error = yield* client.startComposition().pipe(Effect.flip);
      expect("outcomes" in error).toBe(true);
      if (!("outcomes" in error)) return yield* Effect.die("Missing composition outcomes");
      expect(error.outcomes).toEqual([
        { id: "healthy", succeeded: true },
        { id: "failed", succeeded: false, error: expect.stringContaining("member failed") },
      ]);
      yield* client.shutdown({ destroy: false });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("keeps serving when namespace shutdown fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-drain-failure-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "host-drain-failure" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      };
      yield* state.save(saved);
      const owner = yield* ownerFor({
        saved,
        state,
        root: `${root}/data`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
      });
      const failedOwner = {
        ...owner,
        namespace: {
          ...owner.namespace,
          stop: Effect.fail(new OwnerError({ operation: "stop", message: "cleanup failed" })),
        },
      };
      const { runtime } = yield* inProcessRuntime(failedOwner, state, root);
      const client = yield* clientFor(runtime.endpoint.port);
      const failure = yield* client.shutdown({ destroy: false }).pipe(Effect.flip);
      expect("operation" in failure).toBe(true);
      expect((yield* client.listServices()).length).toBe(0);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("serves one detached owner through Effect RPC and retires after shutdown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-" });
      const state = yield* stateFor(`${root}/state`);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: "host" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const endpoint = yield* launchHost(state, {
        stateRoot: `${root}/state`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
        stackId: "stack",
      });
      const http = yield* HttpClient.HttpClient;
      const identity = yield* http.get(`http://127.0.0.1:${endpoint.port}/identity`);
      expect(identity.status).toBe(200);
      const client = yield* clientFor(endpoint.port);
      const stopped = yield* Ref.make(false);
      yield* Effect.addFinalizer(() =>
        Ref.get(stopped).pipe(
          Effect.flatMap((value) =>
            value ? Effect.void : client.shutdown({ destroy: true }).pipe(Effect.ignore),
          ),
        ),
      );
      yield* abortBeforeRpcBody(endpoint.port);
      expect((yield* client.listServices()).length).toBe(0);
      const mail = yield* client.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
      });
      expect(mail.creation.service).toBe("mail");
      expect((yield* client.listServices()).length).toBe(1);
      const toolAttachment = "early-stdin";
      const toolEvents = yield* client
        .runTool({
          attachmentId: toolAttachment,
          tool: postgres.psql({ major: 17 }),
          args: ["--version"],
          env: {},
          stdin: true,
        })
        .pipe(Stream.runCollect);
      expect(Array.from(toolEvents).some((event) => event._tag === "Completed")).toBe(true);
      const closedInput = yield* client
        .toolInput({ attachmentId: toolAttachment, bytes: null })
        .pipe(Effect.flip);
      expect("operation" in closedInput).toBe(true);
      if (!("operation" in closedInput)) return yield* Effect.die("Unexpected RPC error");
      expect(closedInput.operation).toBe("tool-input-closed");
      yield* client.startService({ id: mail.id });
      yield* client.readyService({ id: mail.id });
      expect((yield* client.status({ id: mail.id })).lifecycle).toBe("running");
      const idleSocket = yield* Effect.acquireRelease(openIdleSocket(endpoint.port), (socket) =>
        Effect.sync(() => socket.destroy()),
      );
      const logs = yield* Effect.forkScoped(client.logs({ id: mail.id }).pipe(Stream.runDrain));
      const attached = yield* Deferred.make<void>();
      const drainingTool = yield* Effect.forkScoped(
        client
          .runTool({
            attachmentId: "draining-stdin",
            tool: postgres.psql({ major: 17 }),
            args: [],
            env: {},
            stdin: true,
          })
          .pipe(
            Stream.runForEach((event) =>
              event._tag === "Attached" ? Deferred.succeed(attached, undefined) : Effect.void,
            ),
          ),
      );
      yield* Deferred.await(attached);
      yield* client.shutdown({ destroy: false });
      yield* awaitClosed(idleSocket).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.await(logs).pipe(Effect.timeout("5 seconds"));
      const drainingToolExit = yield* Fiber.await(drainingTool);
      expect(Exit.isFailure(drainingToolExit)).toBe(true);
      if (Exit.isFailure(drainingToolExit))
        expect(Cause.pretty(drainingToolExit.cause)).toContain("Stack host is draining");
      yield* Ref.set(stopped, true);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("finishes detached shutdown after the caller disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-abort-" });
      const state = yield* stateFor(`${root}/state`);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: "host-abort" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const owner = yield* ownerFor({
        saved: {
          id: "stack",
          runtime: "native",
          identity: { projectRoot: root, branchContext: "main", stackName: "host" },
          instances: [],
          composition: { members: [], dependencies: [] },
          ports: [],
        },
        state,
        root: `${root}/data`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
      });
      const entered = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();
      const delayedOwner = {
        ...owner,
        namespace: {
          ...owner.namespace,
          stop: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(allow)),
            Effect.andThen(owner.namespace.stop),
          ),
        },
      };
      const { runtime } = yield* inProcessRuntime(delayedOwner, state, root);
      yield* Effect.addFinalizer(() => Deferred.succeed(allow, undefined));
      const client = yield* clientFor(runtime.endpoint.port);
      const shutdown = yield* Effect.forkScoped(client.shutdown({ destroy: false }));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(shutdown);
      yield* Deferred.succeed(allow, undefined);
      yield* Deferred.await(runtime.exit).pipe(Effect.timeout("5 seconds"));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("withdraws a command waiting for its prerequisite", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-command-abort-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "host-command-abort" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      };
      yield* state.save(saved);
      const owner = yield* ownerFor({
        saved,
        state,
        root: `${root}/data`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
      });
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();
      const delayedOwner = {
        ...owner,
        core: {
          ...owner.core,
          start: (id: string) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(allow)),
              Effect.andThen(owner.core.start(id)),
              Effect.ensuring(Deferred.succeed(cancelled, undefined)),
            ),
        },
      };
      const { runtime } = yield* inProcessRuntime(delayedOwner, state, root);
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allow, undefined).pipe(
          Effect.andThen(runtime.shutdown(false).pipe(Effect.ignore)),
        ),
      );
      const client = yield* clientFor(runtime.endpoint.port);
      const mail = yield* client.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" } },
      });
      const start = yield* Effect.forkScoped(client.startService({ id: mail.id }));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(start);
      yield* Deferred.await(cancelled).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.succeed(allow, undefined);
      expect((yield* client.status({ id: mail.id })).lifecycle).toBe("stopped");
      yield* client.shutdown({ destroy: false });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
