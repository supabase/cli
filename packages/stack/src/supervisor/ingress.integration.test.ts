import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Crypto, Deferred, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native server is required for the backend fixture.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- TCP servers are required for the gateway fixture.
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";
import { compileStack, createExecutionPlan, seedServiceRegistry } from "../model/Compiler.ts";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { resolveSecrets } from "../state/SecretStore.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import { privateBindingIntentsFor } from "../runtime/WorkloadRuntimeSpec.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { BackendEndpoint } from "../gateway/Gateway.ts";
import { makeSupervisorIngress } from "./Ingress.ts";
import { StackLifecycleConflictError } from "../public/Errors.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
  );

const listenBackend = Effect.acquireRelease(
  Effect.callback<Server, Error>((resume) => {
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.statusCode = 200;
      response.end("backend-ready");
    });
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  }),
  (server) =>
    Effect.callback<void, never>((resume) => {
      if (!server.listening) return resume(Effect.void);
      server.close(() => resume(Effect.void));
    }),
);

const request = (endpoint: BackendEndpoint, path: string) =>
  HttpClient.get(new URL(path, `http://${endpoint.host}:${endpoint.port}`)).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
    ),
  );

const listenTcpBackend = (body: string) =>
  Effect.gen(function* () {
    const received = yield* Deferred.make<void>();
    const server = yield* Effect.acquireRelease(
      Effect.callback<TcpServer, Error>((resume) => {
        const server = createTcpServer((socket) => {
          socket.once("data", () =>
            Deferred.doneUnsafe(
              received,
              Effect.map(Effect.void, () => undefined),
            ),
          );
          socket.once("data", () => socket.end(body));
        });
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void, never>((resume) => {
          if (!server.listening) return resume(Effect.void);
          server.close(() => resume(Effect.void));
        }),
    );
    return { server, received };
  });

const tcpRequest = (endpoint: BackendEndpoint) =>
  Effect.callback<void, Error>((resume) => {
    let settled = false;
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    const onConnect = () => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      socket.end("probe");
      resume(Effect.map(Effect.void, () => undefined));
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      resume(Effect.fail(error));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  });

const makeFixture = (backendPort: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-ingress-v2-" });
    const identity: StackIdentity = {
      projectRoot: root,
      branchContext: "ordinary-workspace",
      stackName: "ingress",
    };
    const stackId = yield* deriveStackId(identity);
    const compiled = yield* compileStack({
      projectRoot: root,
      runtime: { kind: "container", engine: "docker" },
      config: {
        listeners: {
          api: { enabled: true },
          functionsInspector: { enabled: true },
        },
      },
    });
    const seeded = yield* seedServiceRegistry(
      compiled.definition,
      { projectRoot: root, path, runtime: { kind: "container", engine: "docker" } },
      compiled.sourceConfig,
      compiled.secrets,
    );
    const resolved = yield* resolveSecrets(
      { declarations: seeded.secretSlots },
      undefined,
      "stopped",
    );
    const registry = seeded.registry;
    const runtime = { kind: "container", engine: "docker" } as const;
    const plan = yield* createExecutionPlan(runtime, registry);
    const privateIntents = privateBindingIntentsFor(plan, {
      runtime,
      registry,
      listeners: { api: { enabled: true } },
    });
    const base: PersistedStackState = {
      format: "supabase-stack-state-v2" as const,
      identity,
      runtime,
      preparation: compiled.definition.preparation,
      security: {
        jwt: {
          issuer: null,
          expirySeconds: 3600,
          signing: { kind: "symmetric", secret: { slot: "secret:auth.settings.jwt_secret" } },
        },
      },
      listeners: {},
      registry,
      ports: [],
      privatePorts: privateIntents.map((intent, index) => ({
        ...intent,
        port: backendPort + index + 1,
      })),
      secrets: resolved.persisted,
    } satisfies PersistedStackState;
    const store = yield* makeStackStateStore({ stateRoot: root });
    yield* store.initialize(stackId, base);
    const context = Context.make(FileSystem.FileSystem, fs).pipe(
      Context.add(Path.Path, path),
      Context.add(Crypto.Crypto, crypto),
    );
    const input = {
      stackId,
      state: base,
      definition: compiled.definition,
      secrets: resolved.persisted,
      plan,
    };
    const ingress = yield* makeSupervisorIngress({
      stackId,
      stateRoot: root,
      store,
      context,
      bindPrivate: (_address, port) => Effect.succeed({ port, close: Effect.void }),
      apiMaterial: () =>
        Effect.succeed({
          publishableKey: "publishable",
          secretKey: "secret",
          anonJwt: "anon",
          serviceRoleJwt: "service",
        }),
    });
    if (ingress.publish === undefined)
      return yield* Effect.die("Ingress publication is unavailable");
    if (ingress.setTrafficAcquirer === undefined)
      return yield* Effect.die("Ingress traffic admission is unavailable");
    yield* ingress.setTrafficAcquirer(() => Effect.succeed({ release: Effect.void }));
    return { input, ingress, plan, publish: ingress.publish, store };
  });

const workloadFor = (
  plan: { readonly workloads: ReadonlyArray<PlannedWorkload> },
  recipeId: string,
) => {
  const workload = plan.workloads.find((entry) => entry.recipeId === recipeId);
  if (workload === undefined) throw new Error(`Missing workload ${recipeId}`);
  return workload;
};

describe("Supervisor ingress", () => {
  it.live("keeps startup-control inspector traffic available before ordinary readiness", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* listenBackend;
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend did not expose a port");
        const fixture = yield* makeFixture(address.port);
        const reservation = yield* fixture.ingress.acquire(fixture.input);
        yield* fixture.ingress.open(fixture.input, reservation, () =>
          Effect.succeed({
            capability: "functions" as const,
            endpoint: { host: "127.0.0.1", port: address.port },
          }),
        );
        const functions = workloadFor(fixture.plan, "functions:edge-runtime");
        const inspector: RuntimeBindingPublication = {
          workloadId: functions.id,
          recipeId: functions.recipeId,
          binding: "inspector",
          endpoint: { host: "127.0.0.1", port: address.port },
        };
        const listener = reservation.hostListeners.find(
          (entry) => entry.field === "functionsInspector",
        );
        if (listener === undefined) return yield* Effect.die("inspector listener was not reserved");
        const apiListener = reservation.hostListeners.find((entry) => entry.field === "api");
        if (apiListener === undefined) return yield* Effect.die("API listener was not reserved");
        yield* fixture.publish(functions.instanceId, [inspector]);
        const response = yield* request({ host: "127.0.0.1", port: listener.port }, "/");
        expect(response).toEqual({ status: 200, body: "backend-ready" });
        const ordinary = yield* request(
          { host: "127.0.0.1", port: apiListener.port },
          "/functions/v1/items",
        );
        expect(ordinary.status).toBe(503);
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("admits inspector traffic while the ordinary instance lease is fenced", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* listenBackend;
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend did not expose a port");
        const fixture = yield* makeFixture(address.port);
        const setTrafficAcquirer = fixture.ingress.setTrafficAcquirer;
        if (setTrafficAcquirer === undefined)
          return yield* Effect.die("Ingress traffic admission is unavailable");
        yield* setTrafficAcquirer((_instanceId, mode) =>
          mode === "startup-control"
            ? Effect.succeed({ release: Effect.void })
            : Effect.fail(
                new StackLifecycleConflictError({
                  message: "ordinary instance traffic is fenced during startup",
                }),
              ),
        );
        const reservation = yield* fixture.ingress.acquire(fixture.input);
        yield* fixture.ingress.open(fixture.input, reservation, () =>
          Effect.succeed({
            capability: "functions" as const,
            endpoint: { host: "127.0.0.1", port: address.port },
          }),
        );
        const functions = workloadFor(fixture.plan, "functions:edge-runtime");
        yield* fixture.publish(functions.instanceId, [
          {
            workloadId: functions.id,
            recipeId: functions.recipeId,
            binding: "inspector",
            endpoint: { host: "127.0.0.1", port: address.port },
          },
        ]);
        const listener = reservation.hostListeners.find(
          (entry) => entry.field === "functionsInspector",
        );
        if (listener === undefined) return yield* Effect.die("inspector listener was not reserved");
        const response = yield* request({ host: "127.0.0.1", port: listener.port }, "/");
        expect(response).toEqual({ status: 200, body: "backend-ready" });
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("merges final bindings without losing the early inspector publication", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* listenBackend;
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend did not expose a port");
        const fixture = yield* makeFixture(address.port);
        const reservation = yield* fixture.ingress.acquire(fixture.input);
        yield* fixture.ingress.open(fixture.input, reservation, () =>
          Effect.succeed({
            capability: "functions" as const,
            endpoint: { host: "127.0.0.1", port: address.port },
          }),
        );
        const functions = workloadFor(fixture.plan, "functions:edge-runtime");
        const publication = (binding: string): RuntimeBindingPublication => ({
          workloadId: functions.id,
          recipeId: functions.recipeId,
          binding,
          endpoint: { host: "127.0.0.1", port: address.port },
        });
        yield* fixture.publish(functions.instanceId, [publication("inspector")]);
        yield* fixture.publish(functions.instanceId, [publication("primary")]);
        const listener = reservation.hostListeners.find(
          (entry) => entry.field === "functionsInspector",
        );
        if (listener === undefined) return yield* Effect.die("inspector listener was not reserved");
        const response = yield* request({ host: "127.0.0.1", port: listener.port }, "/");
        expect(response.status).toBe(200);
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("arms the shared Functions API before a lazy workload starts", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* listenBackend;
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend did not expose a port");
        const fixture = yield* makeFixture(address.port);
        const functions = workloadFor(fixture.plan, "functions:edge-runtime");
        const arm = fixture.ingress.armFunctionsApi;
        if (arm === undefined) return yield* Effect.die("Functions API arming is unavailable");
        const primary: RuntimeBindingPublication = {
          workloadId: functions.id,
          recipeId: functions.recipeId,
          binding: "primary",
          endpoint: { host: "127.0.0.1", port: address.port },
        };
        const setActivator = fixture.ingress.setInstanceActivator;
        if (setActivator === undefined)
          return yield* Effect.die("Functions activation is unavailable");
        yield* setActivator(() => fixture.publish(functions.instanceId, [primary]));
        yield* arm(fixture.input.state, fixture.plan);
        const isWakeable = fixture.ingress.isInstanceWakeable;
        if (isWakeable === undefined)
          return yield* Effect.die("Functions wakeability is unavailable");
        expect(yield* isWakeable(functions.instanceId)).toBe(false);
        const state = yield* fixture.store.read(fixture.input.stackId);
        const api = state?.ports.find(
          (entry) => entry.owner === "stack" && entry.binding === "api",
        );
        if (api === undefined) return yield* Effect.die("shared API listener was not reserved");
        const response = yield* request(
          { host: "127.0.0.1", port: api.port },
          "/functions/v1/items",
        );
        expect(response).toEqual({ status: 200, body: "backend-ready" });
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("keeps two instance SQL listeners independent across exact unpublish", () =>
    run(
      Effect.gen(function* () {
        const firstBackend = yield* listenTcpBackend("first-database");
        const secondBackend = yield* listenTcpBackend("second-database");
        const firstAddress = firstBackend.server.address();
        const secondAddress = secondBackend.server.address();
        if (
          typeof firstAddress !== "object" ||
          firstAddress === null ||
          typeof secondAddress !== "object" ||
          secondAddress === null
        )
          return yield* Effect.die("database backends did not expose ports");
        const fixture = yield* makeFixture(24_000);
        const primary = fixture.input.state.registry.instances.find(
          (instance) => instance.service === "database",
        );
        if (primary === undefined) return yield* Effect.die("default database is missing");
        const secondaryId = ServiceInstanceIdSchema.make("secondary-database");
        const secondary = {
          ...primary,
          id: secondaryId,
          name: "secondary-database",
          config: { ...primary.config, endpoints: { sql: { port: "auto" as const } } },
        };
        const registry = {
          ...fixture.input.state.registry,
          instances: [
            {
              ...primary,
              config: { ...primary.config, endpoints: { sql: { port: "auto" as const } } },
            },
            secondary,
            ...fixture.input.state.registry.instances.filter((instance) => instance !== primary),
          ],
        };
        const plan = yield* createExecutionPlan(fixture.input.state.runtime, registry);
        const state: PersistedStackState = {
          ...fixture.input.state,
          registry,
          ports: [],
          privatePorts: privateBindingIntentsFor(plan, { ...fixture.input.state, registry }).map(
            (intent, index) => ({ ...intent, port: 26_000 + index }),
          ),
        };
        yield* fixture.store.replace(fixture.input.stackId, state);
        const input = { ...fixture.input, state, plan };
        const reservation = yield* fixture.ingress.acquire(input);
        yield* fixture.ingress.open(input, reservation, () =>
          Effect.succeed({
            capability: "database" as const,
            endpoint: { host: "127.0.0.1", port: firstAddress.port },
          }),
        );
        const firstWorkload = plan.workloads.find(
          (workload) => workload.instanceId === primary.id && workload.capability === "database",
        );
        const secondWorkload = plan.workloads.find(
          (workload) => workload.instanceId === secondary.id && workload.capability === "database",
        );
        if (firstWorkload === undefined || secondWorkload === undefined)
          return yield* Effect.die("database workloads are missing");
        yield* fixture.publish(primary.id, [
          {
            workloadId: firstWorkload.id,
            recipeId: firstWorkload.recipeId,
            binding: "sql:internal",
            endpoint: { host: "127.0.0.1", port: firstAddress.port },
          },
        ]);
        yield* fixture.publish(secondary.id, [
          {
            workloadId: secondWorkload.id,
            recipeId: secondWorkload.recipeId,
            binding: "sql:internal",
            endpoint: { host: "127.0.0.1", port: secondAddress.port },
          },
        ]);
        const firstListener = reservation.hostListeners.find(
          (listener) => listener.routeKey === `instance:${primary.id}:sql`,
        );
        const secondListener = reservation.hostListeners.find(
          (listener) => listener.routeKey === `instance:${secondary.id}:sql`,
        );
        if (firstListener === undefined || secondListener === undefined)
          return yield* Effect.die("instance SQL listeners are missing");
        yield* tcpRequest({ host: "127.0.0.1", port: firstListener.port });
        yield* Deferred.await(firstBackend.received);
        yield* tcpRequest({ host: "127.0.0.1", port: secondListener.port });
        yield* Deferred.await(secondBackend.received);
        const unpublish = fixture.ingress.unpublish;
        if (unpublish === undefined) return yield* Effect.die("Ingress unpublish is unavailable");
        yield* unpublish(primary.id);
        const isWakeable = fixture.ingress.isInstanceWakeable;
        if (isWakeable === undefined)
          return yield* Effect.die("Ingress wakeability is unavailable");
        expect(yield* isWakeable(primary.id)).toBe(false);
        expect(yield* isWakeable(secondary.id)).toBe(true);
        yield* tcpRequest({ host: "127.0.0.1", port: secondListener.port });
        yield* fixture.ingress.close;
      }),
    ),
  );
});
