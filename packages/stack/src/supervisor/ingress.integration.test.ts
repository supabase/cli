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
import { makeSupervisorIngress, type SupervisorIngressOptions } from "./Ingress.ts";
import { bindHostListener, type HostListener } from "./HostListener.ts";
import type { PortField } from "../public/Status.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
  );

const listenBackend = (body = "backend-ready") =>
  Effect.acquireRelease(
    Effect.callback<Server, Error>((resume) => {
      const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
        response.statusCode = 200;
        response.end(body);
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
  HttpClient.get(
    new URL(
      path,
      `http://${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`,
    ),
  ).pipe(
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
      socket.end("probe");
    };
    const onData = () => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      socket.end();
      resume(Effect.map(Effect.void, () => undefined));
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      socket.off("data", onData);
      resume(Effect.fail(error));
    };
    socket.once("connect", onConnect);
    socket.once("data", onData);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.destroy();
    });
  });

const makeFixture = (backendPort: number, bindHost?: SupervisorIngressOptions["bindHost"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-ingress-v2-" });
    const templatePath = `${root}/confirm.html`;
    yield* fs.writeFileString(templatePath, "auth-template");
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
    const registry = {
      ...seeded.registry,
      instances: seeded.registry.instances.map((instance) => ({
        ...instance,
        intent: "started" as const,
      })),
    };
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
      bindHost,
      resolveInternalApiBindAddress: () => Effect.succeed("::1"),
      resolveAuthTemplates: () =>
        Effect.succeed([{ id: "confirm", canonicalPath: templatePath, extension: ".html" }]),
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
  it.live("arms dormant Studio and pooler listeners and wakes each backend", () =>
    run(
      Effect.gen(function* () {
        const studioBackend = yield* listenBackend("studio-ready");
        const poolerBackend = yield* listenTcpBackend("pooler-ready");
        const studioAddress = studioBackend.address();
        const poolerAddress = poolerBackend.server.address();
        if (
          typeof studioAddress !== "object" ||
          studioAddress === null ||
          typeof poolerAddress !== "object" ||
          poolerAddress === null
        )
          return yield* Effect.die("lazy backends did not expose ports");
        const boundPorts = new Map<PortField, number>();
        const bindHost = (address: string, _port: number, field: PortField) =>
          bindHostListener(address, 0, field).pipe(
            Effect.tap((listener: HostListener) =>
              Effect.sync(() => {
                boundPorts.set(field, listener.port);
              }),
            ),
          );
        const fixture = yield* makeFixture(studioAddress.port, bindHost);
        const studio = fixture.input.state.registry.instances.find(
          (instance) => instance.service === "studio",
        );
        const pooler = fixture.input.state.registry.instances.find(
          (instance) => instance.service === "pooler",
        );
        if (studio === undefined || pooler === undefined)
          return yield* Effect.die("Studio or pooler instance is missing");
        const registry = {
          ...fixture.input.state.registry,
          instances: fixture.input.state.registry.instances.map((instance) => {
            if (instance.service === "studio")
              return {
                ...instance,
                intent: "started" as const,
                config: { ...instance.config, activation: "lazy" as const },
              };
            if (instance.service === "pooler")
              return {
                ...instance,
                intent: "started" as const,
                config: { ...instance.config, activation: "lazy" as const },
              };
            return instance;
          }),
        };
        const studioPort = 10_000;
        const poolerPort = 10_001;
        const state: PersistedStackState = {
          ...fixture.input.state,
          listeners: { api: { enabled: false } },
          registry,
          ports: [
            {
              owner: "instance",
              instanceId: studio.id,
              binding: "studio",
              address: "127.0.0.1",
              port: studioPort,
              intent: "exact",
            },
            {
              owner: "instance",
              instanceId: pooler.id,
              binding: "pooler",
              address: "127.0.0.1",
              port: poolerPort,
              intent: "exact",
            },
          ],
        };
        const plan = yield* createExecutionPlan(state.runtime, registry);
        yield* fixture.store.replace(fixture.input.stackId, state);
        const studioWorkload = workloadFor(plan, "studio:studio");
        const poolerWorkload = plan.workloads.find((entry) => entry.instanceId === pooler.id);
        if (studioWorkload === undefined || poolerWorkload === undefined)
          return yield* Effect.die("lazy workloads are missing");
        const setActivator = fixture.ingress.setInstanceActivator;
        if (setActivator === undefined) return yield* Effect.die("activation is unavailable");
        yield* setActivator((instanceId) =>
          instanceId === studio.id
            ? fixture.publish(studio.id, [
                {
                  workloadId: studioWorkload.id,
                  recipeId: studioWorkload.recipeId,
                  binding: "primary",
                  endpoint: { host: "127.0.0.1", port: studioAddress.port },
                },
              ])
            : fixture.publish(pooler.id, [
                {
                  workloadId: poolerWorkload.id,
                  recipeId: poolerWorkload.recipeId,
                  binding: "primary",
                  endpoint: { host: "127.0.0.1", port: poolerAddress.port },
                },
              ]),
        );
        const arm = fixture.ingress.armLazyIngress;
        if (arm === undefined) return yield* Effect.die("lazy ingress arming is unavailable");
        yield* arm(state, plan);
        yield* arm(state, plan);
        const actualStudioPort = boundPorts.get("studio");
        const actualPoolerPort = boundPorts.get("pooler");
        if (actualStudioPort === undefined || actualPoolerPort === undefined)
          return yield* Effect.die("lazy listeners were not bound");
        const studioResponse = yield* request({ host: "127.0.0.1", port: actualStudioPort }, "/");
        expect(studioResponse).toEqual({ status: 200, body: "studio-ready" });
        yield* tcpRequest({ host: "127.0.0.1", port: actualPoolerPort });
        yield* Deferred.await(poolerBackend.received);
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("arms the shared Functions API before a lazy workload starts", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* listenBackend();
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend did not expose a port");
        const changedAddress = "::1";
        const fixture = yield* makeFixture(address.port);
        const functions = workloadFor(fixture.plan, "functions:edge-runtime");
        const arm = fixture.ingress.armLazyIngress;
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
        yield* arm(fixture.input.state, fixture.plan);
        const isWakeable = fixture.ingress.isInstanceWakeable;
        if (isWakeable === undefined)
          return yield* Effect.die("Functions wakeability is unavailable");
        expect(yield* isWakeable(functions.instanceId)).toBe(true);
        const state = yield* fixture.store.read(fixture.input.stackId);
        if (state === undefined) return yield* Effect.die("Armed state is missing");
        const api = state?.ports.find(
          (entry) => entry.owner === "stack" && entry.binding === "api",
        );
        if (api === undefined) return yield* Effect.die("shared API listener was not reserved");
        const response = yield* request(
          { host: "127.0.0.1", port: api.port },
          "/functions/v1/items",
        );
        expect(response).toEqual({ status: 200, body: "backend-ready" });
        const changedState: PersistedStackState = {
          ...state,
          listeners: { api: { enabled: true, address: changedAddress, port: api.port } },
          ports: state.ports.map((entry) =>
            entry.owner === "stack" && entry.binding === "api"
              ? { ...entry, address: changedAddress, intent: "exact" as const }
              : entry,
          ),
        };
        yield* fixture.store.replace(fixture.input.stackId, changedState);
        yield* arm(changedState, fixture.plan);
        const changedResponse = yield* request(
          { host: changedAddress, port: api.port },
          "/functions/v1/items",
        );
        expect(changedResponse).toEqual({ status: 200, body: "backend-ready" });
        const disabledState: PersistedStackState = {
          ...changedState,
          listeners: { api: { enabled: false } },
        };
        yield* fixture.store.replace(fixture.input.stackId, disabledState);
        yield* arm(disabledState, fixture.plan);
        const reopened = yield* bindHostListener(changedAddress, api.port, "api");
        yield* reopened.close;
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("arms shared API routes when Functions is disabled", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* listenBackend();
        const storageBackend = yield* listenBackend("storage-backend");
        const imgproxyBackend = yield* listenBackend("imgproxy-backend");
        const address = backend.address();
        const storageAddress = storageBackend.address();
        const imgproxyAddress = imgproxyBackend.address();
        if (
          typeof address !== "object" ||
          address === null ||
          typeof storageAddress !== "object" ||
          storageAddress === null ||
          typeof imgproxyAddress !== "object" ||
          imgproxyAddress === null
        )
          return yield* Effect.die("backend did not expose a port");
        const fixture = yield* makeFixture(address.port);
        const registry = {
          ...fixture.input.state.registry,
          instances: fixture.input.state.registry.instances.map((instance) =>
            instance.service === "functions"
              ? { ...instance, config: { ...instance.config, enabled: false } }
              : instance,
          ),
        };
        const state = { ...fixture.input.state, registry };
        const plan = yield* createExecutionPlan(state.runtime, registry);
        yield* fixture.store.replace(fixture.input.stackId, state);
        const rest = plan.workloads.find((entry) => entry.capability === "rest");
        if (rest === undefined) return yield* Effect.die("REST workload is missing");
        const storage = workloadFor(plan, "storage:storage");
        const imgproxy = workloadFor(plan, "storage:imgproxy");
        const arm = fixture.ingress.armLazyIngress;
        if (arm === undefined) return yield* Effect.die("API arming is unavailable");
        const setActivator = fixture.ingress.setInstanceActivator;
        if (setActivator === undefined) return yield* Effect.die("API activation is unavailable");
        yield* setActivator(() =>
          fixture.publish(rest.instanceId, [
            {
              workloadId: rest.id,
              recipeId: rest.recipeId,
              binding: "primary",
              endpoint: { host: "127.0.0.1", port: address.port },
            },
          ]),
        );
        yield* arm(state, plan);
        yield* fixture.publish(storage.instanceId, [
          {
            workloadId: storage.id,
            recipeId: storage.recipeId,
            binding: "primary",
            endpoint: { host: "127.0.0.1", port: storageAddress.port },
          },
          {
            workloadId: imgproxy.id,
            recipeId: imgproxy.recipeId,
            binding: "primary",
            endpoint: { host: "127.0.0.1", port: imgproxyAddress.port },
          },
        ]);
        const isWakeable = fixture.ingress.isInstanceWakeable;
        if (isWakeable === undefined) return yield* Effect.die("API wakeability is unavailable");
        expect(yield* isWakeable(rest.instanceId)).toBe(true);
        const persisted = yield* fixture.store.read(fixture.input.stackId);
        const api = persisted?.ports.find(
          (entry) => entry.owner === "stack" && entry.binding === "api",
        );
        if (api === undefined) return yield* Effect.die("shared API listener was not reserved");
        const response = yield* request({ host: "127.0.0.1", port: api.port }, "/rest/v1/items");
        expect(response).toEqual({ status: 200, body: "backend-ready" });
        const storageResponse = yield* request(
          { host: "127.0.0.1", port: api.port },
          "/storage/v1/bucket",
        );
        expect(storageResponse).toEqual({ status: 200, body: "storage-backend" });
        const internalResponse = yield* request({ host: "::1", port: api.port }, "/rest/v1/items");
        expect(internalResponse).toEqual({ status: 200, body: "backend-ready" });
        const templateResponse = yield* request(
          { host: "127.0.0.1", port: api.port },
          "/email/confirm.html",
        );
        expect(templateResponse).toEqual({ status: 200, body: "auth-template" });
        yield* fixture.ingress.close;
      }),
    ),
  );

  it.live("updates the shared API route set as instances are added and removed", () =>
    run(
      Effect.gen(function* () {
        const firstBackend = yield* listenBackend("primary-backend");
        const secondBackend = yield* listenBackend("secondary-backend");
        const firstAddress = firstBackend.address();
        const secondAddress = secondBackend.address();
        if (
          typeof firstAddress !== "object" ||
          firstAddress === null ||
          typeof secondAddress !== "object" ||
          secondAddress === null
        )
          return yield* Effect.die("backends did not expose ports");
        const fixture = yield* makeFixture(firstAddress.port);
        const primary = fixture.input.state.registry.instances.find(
          (instance) => instance.service === "rest",
        );
        if (primary === undefined) return yield* Effect.die("default REST instance is missing");
        const secondaryId = ServiceInstanceIdSchema.make("secondary-rest");
        const secondary = { ...primary, id: secondaryId, name: "secondary-rest" };
        const registry = {
          ...fixture.input.state.registry,
          instances: [...fixture.input.state.registry.instances, secondary],
        };
        const state = { ...fixture.input.state, registry };
        const plan = yield* createExecutionPlan(state.runtime, registry);
        yield* fixture.store.replace(fixture.input.stackId, state);
        const arm = fixture.ingress.armLazyIngress;
        if (arm === undefined) return yield* Effect.die("API arming is unavailable");
        yield* arm(state, plan);
        const primaryWorkload = plan.workloads.find(
          (workload) => workload.instanceId === primary.id && workload.capability === "rest",
        );
        const secondaryWorkload = plan.workloads.find(
          (workload) => workload.instanceId === secondary.id && workload.capability === "rest",
        );
        if (primaryWorkload === undefined || secondaryWorkload === undefined)
          return yield* Effect.die("REST workloads are missing");
        yield* fixture.publish(primary.id, [
          {
            workloadId: primaryWorkload.id,
            recipeId: primaryWorkload.recipeId,
            binding: "primary",
            endpoint: { host: "127.0.0.1", port: firstAddress.port },
          },
        ]);
        yield* fixture.publish(secondary.id, [
          {
            workloadId: secondaryWorkload.id,
            recipeId: secondaryWorkload.recipeId,
            binding: "primary",
            endpoint: { host: "127.0.0.1", port: secondAddress.port },
          },
        ]);
        const persisted = yield* fixture.store.read(fixture.input.stackId);
        const api = persisted?.ports.find(
          (entry) => entry.owner === "stack" && entry.binding === "api",
        );
        if (api === undefined) return yield* Effect.die("shared API listener was not reserved");
        const unpublish = fixture.ingress.unpublish;
        if (unpublish === undefined) return yield* Effect.die("Ingress unpublish is unavailable");
        yield* unpublish(primary.id);
        const response = yield* request({ host: "127.0.0.1", port: api.port }, "/rest/v1/items");
        expect(response).toEqual({ status: 200, body: "secondary-backend" });
        const stoppedRegistry = {
          ...registry,
          instances: registry.instances.map((instance) =>
            instance.service === "rest" ? { ...instance, intent: "stopped" as const } : instance,
          ),
        };
        const armedState = yield* fixture.store.read(fixture.input.stackId);
        if (armedState === undefined) return yield* Effect.die("Armed state is missing");
        const stoppedState = { ...armedState, registry: stoppedRegistry };
        const stoppedPlan = yield* createExecutionPlan(stoppedState.runtime, stoppedRegistry);
        yield* fixture.store.replace(fixture.input.stackId, stoppedState);
        const auth = stoppedPlan.workloads.find((workload) => workload.capability === "auth");
        if (auth === undefined) return yield* Effect.die("Auth workload is missing");
        yield* fixture.publish(auth.instanceId, [
          {
            workloadId: auth.id,
            recipeId: auth.recipeId,
            binding: "primary",
            endpoint: { host: "127.0.0.1", port: firstAddress.port },
          },
        ]);
        const stoppedResponse = yield* request(
          { host: "127.0.0.1", port: api.port },
          "/rest/v1/items",
        );
        expect(stoppedResponse.status).toBe(404);
        const resumedRegistry = {
          ...stoppedRegistry,
          instances: stoppedRegistry.instances.map((instance) =>
            instance.id === secondary.id ? { ...instance, intent: "started" as const } : instance,
          ),
        };
        const resumedState = { ...stoppedState, registry: resumedRegistry };
        const resumedPlan = yield* createExecutionPlan(resumedState.runtime, resumedRegistry);
        yield* fixture.store.replace(fixture.input.stackId, resumedState);
        const resumedWorkload = resumedPlan.workloads.find(
          (workload) => workload.instanceId === secondary.id && workload.capability === "rest",
        );
        if (resumedWorkload === undefined)
          return yield* Effect.die("Resumed REST workload is missing");
        yield* fixture.publish(secondary.id, [
          {
            workloadId: resumedWorkload.id,
            recipeId: resumedWorkload.recipeId,
            binding: "primary",
            endpoint: { host: "127.0.0.1", port: secondAddress.port },
          },
        ]);
        const resumedResponse = yield* request(
          { host: "127.0.0.1", port: api.port },
          "/rest/v1/items",
        );
        expect(resumedResponse).toEqual({ status: 200, body: "secondary-backend" });
        yield* fixture.ingress.close;
      }),
    ),
  );
});
