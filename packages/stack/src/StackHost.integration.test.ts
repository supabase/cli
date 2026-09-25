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
  Redacted,
  Ref,
  Stream,
} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- integration observes exact listener closure.
import * as Net from "node:net";
import { launchHost, ownerAuthorization, ownerClient } from "./HostProcess.ts";
import * as Owner from "./Owner.ts";
import { OrchestratorError } from "./Orchestrator.ts";
import * as State from "./State.ts";
import { bindControl, makeRuntime } from "./StackHost.ts";
import { shutdownOwner } from "../tests/owner.ts";
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

const openIdleSocket = (port: number) =>
  Effect.callback<Net.Socket, HostTestError>((resume) => {
    let socket: Net.Socket;
    try {
      socket = Net.connect(port, "127.0.0.1");
    } catch (cause) {
      resume(Effect.fail(hostTestError(cause)));
      return Effect.void;
    }
    // Bun registers an HTTP connection only after it receives a request.
    let response = "";
    const onData = (bytes: Buffer) => {
      response += bytes.toString();
      if (response.includes("\r\n\r\n")) {
        socket.off("data", onData);
        socket.resume();
        resume(Effect.succeed(socket));
      }
    };
    const onConnect = () =>
      socket.write("GET /identity HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
    const onError = (cause: Error) => resume(Effect.fail(hostTestError(cause)));
    socket.on("data", onData);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("data", onData);
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
    const acquired = yield* bindControl();
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
        endpoint: {
          stackId: "stack",
          identity: { projectRoot: root, branchContext: "main", stackName: "host" },
          pid: process.pid,
          port: acquired.port,
          release: "test",
        },
        secret: "test-secret",
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

const occupiedPort = Effect.acquireRelease(
  Effect.callback<Net.Server, HostTestError>((resume) => {
    const server = Net.createServer();
    server.once("error", (cause) => resume(Effect.fail(hostTestError(cause))));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
).pipe(
  Effect.flatMap((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null
      ? Effect.succeed(address.port)
      : Effect.fail(new HostTestError({ message: "Occupied listener has no port" }));
  }),
);

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
        lifetime: "detached" as const,
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
      const { runtime } = yield* inProcessRuntime(owner, state, root);
      const client = yield* ownerClient(runtime.access);
      const port = yield* occupiedPort;
      const lazy = yield* client.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" } },
      });
      const blocked = yield* client.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port } },
      });
      yield* client.configureComposition({
        members: [
          { id: lazy.id, activation: "lazy" },
          { id: blocked.id, activation: "eager" },
        ],
        dependencies: [],
      });

      const error = yield* client.startComposition().pipe(Effect.flip);

      expect("outcomes" in error).toBe(true);
      if (!("outcomes" in error)) return yield* Effect.die("Missing composition outcomes");
      expect(error.outcomes).toEqual([
        { id: lazy.id, succeeded: true },
        { id: blocked.id, succeeded: false, error: expect.stringContaining(String(port)) },
      ]);
      yield* shutdownOwner(runtime.access, true);
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
        lifetime: "detached" as const,
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
          stop: Effect.fail(
            new OrchestratorError({ operation: "stop", message: "cleanup failed" }),
          ),
        },
      };
      const { runtime } = yield* inProcessRuntime(failedOwner, state, root);
      const client = yield* ownerClient(runtime.access);
      const failure = yield* shutdownOwner(runtime.access, false).pipe(Effect.flip);
      expect(failure.message).toContain("cleanup failed");
      yield* client.configureComposition({ members: [], dependencies: [] });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("reports destroy and fallback stop failures together", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-destroy-failure-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "host-destroy-failure" },
        instances: [],
        lifetime: "detached" as const,
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
      const failureWithOutcome = (
        operation: "destroy" | "stop",
        message: string,
        id: string,
        reason: string,
      ) =>
        new OrchestratorError({
          operation,
          message,
          outcomes: [
            {
              id,
              result: Exit.fail(new OrchestratorError({ operation, message: reason })),
            },
          ],
        });
      const failedOwner = {
        ...owner,
        namespace: {
          ...owner.namespace,
          destroy: Effect.fail(
            failureWithOutcome(
              "destroy",
              "Namespace destroy had failures",
              "database-destroy",
              "data removal refused",
            ),
          ),
          stop: Effect.fail(
            failureWithOutcome(
              "stop",
              "Composition stop had failures",
              "database-stop",
              "process stop refused",
            ),
          ),
        },
      };
      const { runtime } = yield* inProcessRuntime(failedOwner, state, root);
      const failure = yield* shutdownOwner(runtime.access, true).pipe(Effect.flip);
      expect(failure.message).toContain("Namespace destroy had failures");
      expect(failure.message).toContain("database-destroy:");
      expect(failure.message).toContain("data removal refused");
      expect(failure.message).toContain("fallback stop failed: Composition stop had failures");
      expect(failure.message).toContain("database-stop:");
      expect(failure.message).toContain("process stop refused");
      expect("outcomes" in failure).toBe(true);
      if (!("outcomes" in failure)) return yield* Effect.die("shutdown outcomes were missing");
      expect(failure.outcomes).toEqual(
        expect.arrayContaining([
          {
            id: "database-destroy",
            succeeded: false,
            error: expect.stringContaining("data removal refused"),
          },
          {
            id: "database-stop",
            succeeded: false,
            error: expect.stringContaining("process stop refused"),
          },
        ]),
      );
      expect(yield* Deferred.isDone(runtime.exit)).toBe(false);
      expect(yield* owner.getServing).toBe(true);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("rejects destroy while stop is in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-stop-join-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "host-stop-join" },
        instances: [],
        lifetime: "detached" as const,
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
      const release = yield* Deferred.make<void>();
      const delayedOwner = {
        ...owner,
        namespace: {
          ...owner.namespace,
          stop: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(owner.namespace.stop),
          ),
        },
      };
      const { runtime } = yield* inProcessRuntime(delayedOwner, state, root);
      const stop = yield* Effect.forkScoped(runtime.shutdown(false));
      yield* Deferred.await(entered);
      const rejected = yield* runtime.shutdown(true).pipe(Effect.flip);
      expect(rejected.message).toContain("Shutdown mode is already selected");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stop);
      yield* Deferred.await(runtime.exit).pipe(Effect.timeout("5 seconds"));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("retains ownership when namespace shutdown defects and retries cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-host-drain-defect-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "host-drain-defect" },
        instances: [],
        lifetime: "detached" as const,
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
      const failStop = yield* Ref.make(true);
      const failedOwner = {
        ...owner,
        namespace: {
          ...owner.namespace,
          stop: Effect.gen(function* () {
            if (yield* Ref.getAndSet(failStop, false)) return yield* Effect.die("cleanup failed");
            yield* owner.namespace.stop;
          }),
        },
      };
      const { runtime } = yield* inProcessRuntime(failedOwner, state, root);
      const client = yield* ownerClient(runtime.access);
      const failure = yield* runtime.shutdown(false).pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) expect(Cause.pretty(failure.cause)).toContain("cleanup failed");
      const http = yield* HttpClient.HttpClient;
      const identity = yield* http.get(`http://127.0.0.1:${runtime.endpoint.port}/identity`, {
        headers: { authorization: ownerAuthorization(runtime.access.secret) },
      });
      expect(identity.status).toBe(200);
      expect(yield* owner.getServing).toBe(true);
      yield* client.configureComposition({ members: [], dependencies: [] });
      yield* runtime.shutdown(false);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "serves one detached owner through Effect RPC and retires after shutdown",
  () =>
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
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        const access = yield* launchHost(state, {
          stateRoot: `${root}/state`,
          cacheRoot: "/tmp/supabase-stack-artifacts",
          stackId: "stack",
        });
        const { endpoint } = access;
        const http = yield* HttpClient.HttpClient;
        const identityUrl = `http://127.0.0.1:${endpoint.port}/identity`;
        expect((yield* http.get(identityUrl)).status, "the secret is required").toBe(401);
        const identity = yield* http.get(identityUrl, {
          headers: { authorization: ownerAuthorization(access.secret) },
        });
        expect(identity.status).toBe(200);
        const client = yield* ownerClient(access);
        const stopped = yield* Ref.make(false);
        yield* Effect.addFinalizer(() =>
          Ref.get(stopped).pipe(
            Effect.flatMap((value) =>
              value ? Effect.void : shutdownOwner(access, true).pipe(Effect.ignore),
            ),
          ),
        );
        yield* abortBeforeRpcBody(endpoint.port);
        expect(yield* client.startComposition()).toEqual([]);
        const mail = yield* client.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
        });
        expect(mail.creation.service).toBe("mail");
        expect((yield* client.status({ id: mail.id })).lifecycle).toBe("stopped");
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
        const database = yield* client.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("host-test-password"),
            jwtSecret: Redacted.make("host-test-jwt-secret-at-least-thirty-two-characters"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* client.startService({ id: database.id });
        yield* client.readyService({ id: database.id });
        const databaseUrl = (yield* client.credentials({ id: database.id, from: "host" }))
          .databaseUrl;
        if (databaseUrl === undefined) return yield* Effect.die("Database credentials missing");
        const databaseEndpoint = new URL(databaseUrl);
        const databaseEnv = {
          PGHOST: databaseEndpoint.hostname,
          PGPORT: databaseEndpoint.port,
          PGUSER: decodeURIComponent(databaseEndpoint.username),
          PGPASSWORD: decodeURIComponent(databaseEndpoint.password),
          PGDATABASE: databaseEndpoint.pathname.slice(1),
        };
        const idleSocket = yield* Effect.acquireRelease(openIdleSocket(endpoint.port), (socket) =>
          Effect.sync(() => socket.destroy()),
        );
        const logs = yield* Effect.forkScoped(client.logs({ id: mail.id }).pipe(Stream.runDrain));
        const ready = yield* Deferred.make<void>();
        const drainingTool = yield* Effect.forkScoped(
          client
            .runTool({
              attachmentId: "draining-stdin",
              tool: postgres.psql({ major: 17 }),
              args: [
                "-X",
                "-t",
                "-A",
                "-c",
                "SELECT 'stack-host-tool-ready'",
                "-c",
                "SELECT pg_sleep(600)",
              ],
              env: databaseEnv,
              stdin: true,
            })
            .pipe(
              Stream.filter((event) => event._tag === "Stdout"),
              Stream.map((event) => event.bytes),
              Stream.decodeText,
              Stream.splitLines,
              Stream.runForEach((line) =>
                line === "stack-host-tool-ready" ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
            ),
        );
        yield* Deferred.await(ready);
        expect(idleSocket.destroyed).toBe(false);
        yield* shutdownOwner(access, false);
        yield* awaitClosed(idleSocket).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                new HostTestError({
                  message: "Idle control connection did not close after shutdown",
                }),
              ),
          }),
        );
        yield* Fiber.await(logs).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                new HostTestError({ message: "Log observation did not close after shutdown" }),
              ),
          }),
        );
        const drainingToolExit = yield* Fiber.await(drainingTool);
        expect(Exit.isFailure(drainingToolExit)).toBe(true);
        if (Exit.isFailure(drainingToolExit))
          expect(Cause.pretty(drainingToolExit.cause)).toContain("Stack host is draining");
        yield* Ref.set(stopped, true);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 120_000 },
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
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const owner = yield* ownerFor({
        saved: {
          id: "stack",
          runtime: "native",
          identity: { projectRoot: root, branchContext: "main", stackName: "host" },
          instances: [],
          lifetime: "detached",
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
      const shutdown = yield* Effect.forkScoped(shutdownOwner(runtime.access, false));
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
        lifetime: "detached" as const,
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
        handlers: {
          ...owner.handlers,
          startService: (payload: { readonly id: string }) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(allow)),
              Effect.andThen(owner.handlers.startService(payload)),
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
      const client = yield* ownerClient(runtime.access);
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
      yield* shutdownOwner(runtime.access, false);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

const disconnectFixture = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix });
    const state = yield* stateFor(`${root}/state`);
    const saved: State.SavedStack = {
      id: "stack",
      runtime: "native",
      identity: { projectRoot: root, branchContext: "main", stackName: prefix },
      instances: [],
      lifetime: "detached",
      composition: { members: [], dependencies: [] },
      ports: [],
    };
    yield* state.save(saved);
    return { root, state, saved };
  });

it.live("finishes a service creation after its caller disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root, state, saved } = yield* disconnectFixture("stack-host-create-abort-");
      const persisted = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(allow, undefined));
      const owner = yield* ownerFor({
        saved,
        state: {
          ...state,
          save: (next) =>
            state
              .save(next)
              .pipe(
                Effect.andThen(
                  next.instances.length === 0
                    ? Effect.void
                    : Deferred.succeed(persisted, undefined).pipe(
                        Effect.andThen(Deferred.await(allow)),
                      ),
                ),
              ),
        },
        root: `${root}/data`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
      });
      const interrupted = yield* Deferred.make<void>();
      const { runtime } = yield* inProcessRuntime(
        {
          ...owner,
          handlers: {
            ...owner.handlers,
            createService: (input: Parameters<typeof owner.handlers.createService>[0]) =>
              owner.handlers
                .createService(input)
                .pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          },
        },
        state,
        root,
      );
      const client = yield* ownerClient(runtime.access);
      const creation = yield* Effect.forkScoped(
        client.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        }),
      );
      yield* Deferred.await(persisted);
      yield* Fiber.interrupt(creation);
      yield* Deferred.await(interrupted);
      yield* Deferred.succeed(allow, undefined);
      // Definition changes are serialized, so this returns after the abandoned creation settles.
      yield* client.configureComposition({ members: [], dependencies: [] });

      const [instance, ...others] = (yield* state.read(saved.id))?.instances ?? [];
      if (instance === undefined) return yield* Effect.die("creation was not persisted");
      expect(others).toEqual([]);
      expect((yield* client.status({ id: instance.id })).lifecycle).toBe("stopped");
      yield* client.destroyService({ id: instance.id });
      yield* shutdownOwner(runtime.access, true);
      yield* Deferred.await(runtime.exit).pipe(Effect.timeout("5 seconds"));
      expect(yield* state.read(saved.id)).toBeUndefined();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("persists a composition change after its caller disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root, state, saved } = yield* disconnectFixture("stack-host-configure-abort-");
      const entered = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(allow, undefined));
      const owner = yield* ownerFor({
        saved,
        state: {
          ...state,
          save: (next) =>
            (next.composition.members.length === 0
              ? Effect.void
              : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(allow)))
            ).pipe(Effect.andThen(state.save(next))),
        },
        root: `${root}/data`,
        cacheRoot: "/tmp/supabase-stack-artifacts",
      });
      const interrupted = yield* Deferred.make<void>();
      const { runtime } = yield* inProcessRuntime(
        {
          ...owner,
          handlers: {
            ...owner.handlers,
            configureComposition: (
              input: Parameters<typeof owner.handlers.configureComposition>[0],
            ) =>
              owner.handlers
                .configureComposition(input)
                .pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          },
        },
        state,
        root,
      );
      const client = yield* ownerClient(runtime.access);
      const mail = yield* client.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" } },
      });
      const members = [{ id: mail.id, activation: "eager" as const }];
      const configure = yield* Effect.forkScoped(
        client.configureComposition({ members, dependencies: [] }),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(configure);
      yield* Deferred.await(interrupted);
      yield* Deferred.succeed(allow, undefined);
      yield* client.createService({ service: "mail", config: {}, endpoints: {} });

      expect((yield* state.read(saved.id))?.composition).toEqual({ members, dependencies: [] });
      yield* shutdownOwner(runtime.access, true);
      yield* Deferred.await(runtime.exit).pipe(Effect.timeout("5 seconds"));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

const abandonedComposition = (prefix: string, destroy: boolean) =>
  Effect.gen(function* () {
    const { root, state, saved } = yield* disconnectFixture(prefix);
    const persisted = yield* Deferred.make<void>();
    const allow = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(allow, undefined));
    const owner = yield* ownerFor({
      saved,
      state: {
        ...state,
        save: (next) =>
          state
            .save(next)
            .pipe(
              Effect.andThen(
                next.instances.length === 0
                  ? Effect.void
                  : Deferred.succeed(persisted, undefined).pipe(
                      Effect.andThen(Deferred.await(allow)),
                    ),
              ),
            ),
      },
      root: `${root}/data`,
      cacheRoot: "/tmp/supabase-stack-artifacts",
    });
    const interrupted = yield* Deferred.make<void>();
    const draining = yield* Deferred.make<void>();
    const { runtime } = yield* inProcessRuntime(
      {
        ...owner,
        setDraining: (value: boolean) =>
          owner
            .setDraining(value)
            .pipe(Effect.andThen(value ? Deferred.succeed(draining, undefined) : Effect.void)),
        handlers: {
          ...owner.handlers,
          supabaseComposition: (input: Parameters<typeof owner.handlers.supabaseComposition>[0]) =>
            owner.handlers
              .supabaseComposition(input)
              .pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        },
      },
      state,
      root,
    );
    const client = yield* ownerClient(runtime.access);
    const composition = yield* Effect.forkScoped(
      client.supabaseComposition({
        services: [
          {
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("abandoned-composition-password"),
              jwtSecret: Redacted.make("abandoned-composition-jwt-secret-at-least-32-chars"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          },
        ],
      }),
    );
    yield* Deferred.await(persisted);
    yield* Fiber.interrupt(composition);
    yield* Deferred.await(interrupted);
    const shutdown = yield* Effect.forkScoped(shutdownOwner(runtime.access, destroy));
    yield* Deferred.await(draining);
    yield* Deferred.succeed(allow, undefined);
    yield* Fiber.join(shutdown);
    yield* Deferred.await(runtime.exit).pipe(Effect.timeout("5 seconds"));
    return { root, state, saved };
  });

it.live("stops a stack only after an abandoned composition settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { state, saved } = yield* abandonedComposition("stack-host-compose-stop-", false);

      const current = yield* state.read(saved.id);
      const instanceIds = current?.instances.map(({ id }) => id) ?? [];
      expect(instanceIds).toHaveLength(1);
      expect(current?.composition.members.map(({ id }) => id)).toEqual(instanceIds);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("destroys a stack only after an abandoned composition settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, state, saved } = yield* abandonedComposition(
        "stack-host-compose-destroy-",
        true,
      );

      expect(yield* state.read(saved.id)).toBeUndefined();
      const data = `${root}/data`;
      expect((yield* fs.exists(data)) ? yield* fs.readDirectory(data) : []).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
