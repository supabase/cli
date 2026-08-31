import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Path,
  Crypto,
  Redacted,
  Scope,
  Stream,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createNetServer } from "node:net";
import type { StackLogEntry } from "../public/Logs.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import type { SupervisorIngress } from "../supervisor/Ingress.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import { makeProductionRuntimeFactory, withOwnedRuntimeFileCleanup } from "./ProductionRuntime.ts";
import { RuntimeDriverError, type RuntimeDriver } from "./RuntimeDriver.ts";
import { StackPreparationError } from "../public/Errors.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { compileStack } from "../model/Compiler.ts";
import type {
  ContainerContainerSpec,
  ContainerEngine,
  ContainerResource,
  ContainerNetworkSpec,
  ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import {
  makeFunctionsBootstrapOwner,
  type FunctionsBootstrapOwner,
} from "../functions/FunctionsBootstrap.ts";
import type { RuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";
import { makeRuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";

const stackId = StackIdSchema.make("a".repeat(64));

const stateFor = (
  secrets: PersistedStackState["secrets"],
  runtime: StackRuntime = { kind: "native" },
): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: {
    stackId,
    projectRoot: "/tmp/production-runtime",
    checkoutRoot: "/tmp/production-runtime",
    workspaceId: "/tmp/production-runtime",
    checkoutId: "/tmp/production-runtime",
    branchContext: "ordinary-workspace",
    localProjectKey: ".",
    stackName: "production-runtime",
  },
  runtime,
  desiredGeneration: 1,
  portsGeneration: null,
  desiredLifecycle: "stopped",
  ports: [],
  privatePorts: [],
  secrets,
});

const workloadFor = (
  id: string,
  capability: PlannedWorkload["capability"],
  selected: PlannedWorkload["selected"],
): PlannedWorkload => ({
  id,
  capability,
  dependencies: [],
  readiness: { mode: "tcp" },
  restart: { maxAttempts: 1, backoffMs: 0 },
  artifacts: {
    native: { kind: "native", service: "postgres", release: "17.6.1.166" },
    container: {
      kind: "container",
      service: "postgres",
      image: "ghcr.io/supabase/cli/postgres:17.6.1.166",
    },
  },
  selected,
  specHash: `hash-${id}`,
});

const stateStoreFor = (current: { value: PersistedStackState }): StackStateStore => ({
  read: () => Effect.sync(() => current.value),
  write: () => Effect.die("unused"),
  initialize: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  replaceUnlocked: () => Effect.die("unused"),
  cleanup: () => Effect.die("unused"),
});

const memoryLogStore = (entries: StackLogEntry[]): LogStore => ({
  path: "memory://production-runtime",
  append: (record) =>
    Effect.sync(() => {
      const entry: StackLogEntry = {
        cursor: { opaque: `v1_${entries.length + 1}` },
        timestamp: record.timestamp ?? "2026-01-01T00:00:00.000Z",
        source: record.source,
        stream: record.stream,
        message: record.message,
      };
      entries.push(entry);
      return entry;
    }),
  read: () => Effect.succeed(entries),
  retained: () => Effect.succeed(entries),
  stream: () => Stream.fromIterable(entries),
});

const ingress: SupervisorIngress = {
  acquire: () => Effect.die("unused"),
  open: () => Effect.die("unused"),
  close: Effect.void,
};

const artifacts: RuntimeArtifactPreparer = {
  prepare: () => Effect.die("unused"),
};

const envFiles: RuntimeEnvFileOwner = {
  write: () => Effect.die("unused"),
  cleanupGeneration: () => Effect.void,
  cleanupAll: Effect.void,
};

const bootstrap: FunctionsBootstrapOwner = {
  write: () => Effect.die("unused"),
  cleanupGeneration: () => Effect.void,
  cleanupAll: Effect.void,
};

const ownerInputContainerEngine = (createdSpecs: ContainerContainerSpec[]): ContainerEngine => {
  const resources: ContainerResource[] = [];
  let nextId = 1;
  const resource = (
    kind: ContainerResource["kind"],
    name: string,
    labels: ContainerResource["labels"],
  ): ContainerResource => ({
    id: `${kind}-${nextId++}`,
    name,
    kind,
    labels,
    ...(kind === "workload" ? { state: "created" as const } : {}),
  });
  const updateState = (id: string, state: "running" | "stopped") => {
    const index = resources.findIndex((entry) => entry.id === id);
    const entry = resources[index];
    if (entry !== undefined) resources[index] = { ...entry, state };
  };
  return {
    kind: "docker",
    executable: "test-container-engine",
    preflight: Effect.sync(() => {
      return { host: "host.docker.internal" };
    }),
    probe: Effect.void,
    inspectImage: () => Effect.succeed({ present: true }),
    pullImage: () => Effect.void,
    listResources: () =>
      Effect.sync(() => {
        return [...resources];
      }),
    createNetwork: (spec: ContainerNetworkSpec) =>
      Effect.sync(() => {
        const created = resource("network", spec.name, spec.labels);
        resources.push(created);
        return created;
      }),
    removeNetwork: (id) =>
      Effect.sync(() => {
        const index = resources.findIndex((entry) => entry.id === id);
        if (index >= 0) resources.splice(index, 1);
      }),
    createVolume: (spec: ContainerVolumeSpec) =>
      Effect.sync(() => {
        const created = resource("volume", spec.name, spec.labels);
        resources.push(created);
        return created;
      }),
    removeVolume: (id) =>
      Effect.sync(() => {
        const index = resources.findIndex((entry) => entry.id === id);
        if (index >= 0) resources.splice(index, 1);
      }),
    createContainer: (spec) =>
      Effect.sync(() => {
        createdSpecs.push(spec);
        const created = resource("workload", spec.name, spec.labels);
        resources.push(created);
        return created;
      }),
    copyToContainer: () => Effect.void,
    startContainer: (id) =>
      Effect.sync(() => {
        updateState(id, "running");
      }),
    waitContainer: () => Effect.succeed(0),
    stopContainer: (id) => Effect.sync(() => updateState(id, "stopped")),
    removeContainer: (id) =>
      Effect.sync(() => {
        const index = resources.findIndex((entry) => entry.id === id);
        if (index >= 0) resources.splice(index, 1);
      }),
    streamLogs: () => Stream.empty,
  };
};

describe("production runtime composition", () => {
  it.live("exposes artifact-only preparation without starting workloads or mutating state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = { value: stateFor({}) };
        const preparedCalls: string[] = [];
        const preparer: RuntimeArtifactPreparer = {
          prepare: (_runtime, workload) =>
            Effect.sync(() => {
              preparedCalls.push(workload.id);
              return {
                workloadId: workload.id,
                capability: workload.capability,
                version: "17.6.1.166",
                outcome: workload.id.endsWith("download")
                  ? ("downloaded" as const)
                  : ("cached" as const),
                artifactRoot: "/tmp/prepared",
              };
            }),
        };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: "/tmp/production-runtime-prepare-state",
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: preparer,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        if (runtime.prepare === undefined) return yield* Effect.die("prepare seam missing");
        const before = current.value;
        const result = yield* runtime.prepare({ kind: "native" }, [
          workloadFor("database:database", "database", {
            kind: "native",
            service: "postgres",
            release: "17.6.1.166",
          }),
          workloadFor("rest:download", "rest", {
            kind: "native",
            service: "postgres",
            release: "17.6.1.166",
          }),
        ]);
        expect(result.map(({ workloadId, outcome }) => [workloadId, outcome])).toEqual([
          ["database:database", "cached"],
          ["rest:download", "downloaded"],
        ]);
        expect(preparedCalls).toEqual(["database:database", "rest:download"]);
        expect(current.value).toEqual(before);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("redacts logs using secret slots materialized after factory creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = { value: stateFor({}) };
        const entries: StackLogEntry[] = [];
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: "/tmp/production-runtime-state",
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: artifacts,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore(entries),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        current.value = stateFor({
          "secret:auth.settings.jwt_secret": { policy: "managed", value: "rotated-secret" },
        });
        const logStore = runtime.logStore;
        expect(logStore).toBeDefined();
        if (logStore === undefined) return;
        yield* logStore.append({
          source: "auth",
          stream: "stdout",
          message: "token=rotated-secret",
        });
        expect(entries[0]?.message).toBe("token=[REDACTED]");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("wires owner material into container workloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-inputs-" });
        const template = path.join(root, "templates", "confirmation.html");
        yield* fs.makeDirectory(path.dirname(template), { recursive: true });
        yield* fs.writeFileString(template, "confirmation");
        const gcpCredentials = path.join(root, "gcp.json");
        yield* fs.writeFileString(gcpCredentials, "{}");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  email: {
                    template: { confirmation: { content_path: "templates/confirmation.html" } },
                  },
                },
              },
              pooler: { enabled: true },
              rest: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: {
                enabled: true,
                settings: {
                  edge_runtime: { secrets: { FACTORY_SECRET: Redacted.make("factory-secret") } },
                },
              },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: {
                enabled: true,
                settings: { backend: "bigquery", gcp_jwt_path: "gcp.json" },
              },
            },
            listeners: {
              database: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        }).pipe(Effect.provide(NodeServices.layer));
        const authServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* Effect.acquireRelease(
          Effect.callback<void, Error>((resume) => {
            authServer.once("error", (error) => resume(Effect.fail(error)));
            authServer.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              if (!authServer.listening) return resume(Effect.void);
              authServer.close(() => resume(Effect.void));
            }),
        );
        const authAddress = authServer.address();
        if (typeof authAddress !== "object" || authAddress === null)
          return yield* Effect.die("Auth readiness server did not expose an address");
        const functionsServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* Effect.acquireRelease(
          Effect.callback<void, Error>((resume) => {
            functionsServer.once("error", (error) => resume(Effect.fail(error)));
            functionsServer.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              if (!functionsServer.listening) return resume(Effect.void);
              functionsServer.close(() => resume(Effect.void));
            }),
        );
        const functionsAddress = functionsServer.address();
        if (typeof functionsAddress !== "object" || functionsAddress === null)
          return yield* Effect.die("Functions readiness server did not expose an address");
        const analyticsServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* Effect.acquireRelease(
          Effect.callback<void, Error>((resume) => {
            analyticsServer.once("error", (error) => resume(Effect.fail(error)));
            analyticsServer.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              if (!analyticsServer.listening) return resume(Effect.void);
              analyticsServer.close(() => resume(Effect.void));
            }),
        );
        const analyticsAddress = analyticsServer.address();
        if (typeof analyticsAddress !== "object" || analyticsAddress === null)
          return yield* Effect.die("Analytics readiness server did not expose an address");
        const poolerServer = createNetServer();
        yield* Effect.acquireRelease(
          Effect.callback<void, Error>((resume) => {
            poolerServer.once("error", (error) => resume(Effect.fail(error)));
            poolerServer.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              if (!poolerServer.listening) return resume(Effect.void);
              poolerServer.close(() => resume(Effect.void));
            }),
        );
        const poolerAddress = poolerServer.address();
        if (typeof poolerAddress !== "object" || poolerAddress === null)
          return yield* Effect.die("Pooler readiness server did not expose an address");
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
                "secret:auth.settings.publishable_key": {
                  policy: "managed",
                  value: "sb_publishable_test",
                },
                "secret:auth.settings.secret_key": {
                  policy: "managed",
                  value: "sb_secret_test",
                },
                "secret:functions.settings.edge_runtime.secrets.FACTORY_SECRET": {
                  policy: "managed",
                  value: "factory-secret",
                },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            inputFingerprint: compiled.inputFingerprint,
            portsGeneration: 1,
            ports: [{ field: "api" as const, port: 40_000, intent: "exact" as const }],
            privatePorts: [
              {
                workloadId: "auth:auth",
                binding: "primary",
                port: authAddress.port,
              },
              {
                workloadId: "pooler:pooler",
                binding: "primary",
                port: poolerAddress.port,
              },
              {
                workloadId: "functions:edge-runtime",
                binding: "primary",
                port: functionsAddress.port,
              },
              {
                workloadId: "analytics:analytics",
                binding: "primary",
                port: analyticsAddress.port,
              },
            ],
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const engine = ownerInputContainerEngine(createdSpecs);
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: engine,
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "present" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const auth = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "auth:auth",
        );
        const pooler = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "pooler:pooler",
        );
        if (auth === undefined || pooler === undefined)
          return yield* Effect.die("Expected Auth and Pooler workloads");
        yield* runtime.driver.start(
          {
            stackId,
            desiredGeneration: 1,
            workloadId: auth.id,
            specHash: auth.specHash,
          },
          auth,
        );
        const authSpec = createdSpecs.find((spec) => spec.labels.workloadId === auth.id);
        if (authSpec === undefined || authSpec.envFile === undefined)
          return yield* Effect.die("Auth container was not captured");
        const authEnv = yield* fs.readFileString(authSpec.envFile);
        expect(authEnv).toContain("GOTRUE_JWT_SECRET=jwt-secret");
        expect(authEnv).toContain(
          "GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://host.docker.internal:40000/email/confirmation.html",
        );
        const functions = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "functions:edge-runtime",
        );
        const analytics = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "analytics:analytics",
        );
        if (functions === undefined || analytics === undefined)
          return yield* Effect.die("Expected Functions and Analytics workloads");
        yield* runtime.driver.start(
          {
            stackId,
            desiredGeneration: 1,
            workloadId: functions.id,
            specHash: functions.specHash,
          },
          functions,
        );
        const functionsSpec = createdSpecs.find((spec) => spec.labels.workloadId === functions.id);
        if (functionsSpec?.envFile === undefined)
          return yield* Effect.die("Functions container was not captured");
        expect(yield* fs.readFileString(functionsSpec.envFile)).toContain(
          "FACTORY_SECRET=factory-secret",
        );
        yield* runtime.driver.start(
          {
            stackId,
            desiredGeneration: 1,
            workloadId: analytics.id,
            specHash: analytics.specHash,
          },
          analytics,
        );
        const analyticsSpec = createdSpecs.find((spec) => spec.labels.workloadId === analytics.id);
        expect(analyticsSpec?.mounts).toContainEqual({
          source: expect.stringContaining("gcp.json"),
          target: "/opt/app/rel/logflare/bin/gcloud.json",
          readOnly: true,
        });
        yield* runtime.driver.start(
          {
            stackId,
            desiredGeneration: 1,
            workloadId: pooler.id,
            specHash: pooler.specHash,
          },
          pooler,
        );
        const poolerSpec = createdSpecs.find((spec) => spec.labels.workloadId === pooler.id);
        expect(poolerSpec?.mounts).toContainEqual({
          source: expect.stringContaining("pooler_tenant.exs"),
          target: "/app/pooler_tenant.exs",
          readOnly: true,
        });
        expect(poolerSpec?.command?.join(" ")).toContain("/app/bin/supavisor eval");
        const tenantPath = poolerSpec?.mounts.find(
          (mount) => mount.target === "/app/pooler_tenant.exs",
        )?.source;
        if (tenantPath === undefined)
          return yield* Effect.die("Pooler tenant mount was not captured");
        expect(yield* fs.exists(tenantPath)).toBe(true);
        yield* runtime.driver.stop({
          stackId,
          desiredGeneration: 1,
          workloadId: pooler.id,
          specHash: pooler.specHash,
        });
        expect(yield* fs.exists(tenantPath)).toBe(false);
        current.value = { ...current.value, desiredGeneration: 2, portsGeneration: 2 };
        yield* runtime.driver.start(
          {
            stackId,
            desiredGeneration: 2,
            workloadId: pooler.id,
            specHash: pooler.specHash,
          },
          pooler,
        );
        const generationTwoSpec = createdSpecs.find(
          (spec) => spec.labels.workloadId === pooler.id && spec.labels.desiredGeneration === 2,
        );
        const generationTwoTenantPath = generationTwoSpec?.mounts.find(
          (mount) => mount.target === "/app/pooler_tenant.exs",
        )?.source;
        if (generationTwoTenantPath === undefined)
          return yield* Effect.die("Second-generation Pooler tenant mount was not captured");
        expect(yield* fs.exists(generationTwoTenantPath)).toBe(true);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* fs.exists(generationTwoTenantPath)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("scopes Auth template URL requirements to the Auth workload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-auth-scope-",
        });
        const template = path.join(root, "confirmation.html");
        yield* fs.writeFileString(template, "confirmation");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  email: { template: { confirmation: { content_path: "confirmation.html" } } },
                },
              },
              rest: { enabled: true },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
            listeners: {
              api: { enabled: false },
              database: { enabled: false },
              pooler: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        }).pipe(Effect.provide(NodeServices.layer));
        const restServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* Effect.acquireRelease(
          Effect.callback<void, Error>((resume) => {
            restServer.once("error", (error) => resume(Effect.fail(error)));
            restServer.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              if (!restServer.listening) return resume(Effect.void);
              restServer.close(() => resume(Effect.void));
            }),
        );
        const address = restServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("REST readiness server did not expose an address");
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            inputFingerprint: compiled.inputFingerprint,
            privatePorts: [
              { workloadId: "rest:rest", binding: "primary", port: address.port },
              { workloadId: "rest:rest", binding: "admin", port: address.port + 1 },
              { workloadId: "auth:auth", binding: "primary", port: address.port + 2 },
            ],
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: ownerInputContainerEngine(createdSpecs),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "present" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const rest = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "rest:rest",
        );
        const auth = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "auth:auth",
        );
        if (rest === undefined || auth === undefined)
          return yield* Effect.die("Expected REST and Auth workloads");
        yield* runtime.driver.start(
          { stackId, desiredGeneration: 1, workloadId: rest.id, specHash: rest.specHash },
          rest,
        );
        expect(createdSpecs.some((spec) => spec.labels.workloadId === rest.id)).toBe(true);
        const authStart = yield* runtime.driver
          .start(
            { stackId, desiredGeneration: 1, workloadId: auth.id, specHash: auth.specHash },
            auth,
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(authStart)).toBe(true);
        expect(createdSpecs.some((spec) => spec.labels.workloadId === auth.id)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("closes the production owner scope while input resolution is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-owner-close-",
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
                },
              },
              pooler: { enabled: true },
              rest: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
            },
            listeners: {
              database: { enabled: false },
              pooler: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        }).pipe(Effect.provide(NodeServices.layer));
        const poolerServer = createNetServer();
        yield* Effect.acquireRelease(
          Effect.callback<void, Error>((resume) => {
            poolerServer.once("error", (error) => resume(Effect.fail(error)));
            poolerServer.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              if (!poolerServer.listening) return resume(Effect.void);
              poolerServer.close(() => resume(Effect.void));
            }),
        );
        const poolerAddress = poolerServer.address();
        if (typeof poolerAddress !== "object" || poolerAddress === null)
          return yield* Effect.die("Pooler readiness server did not expose an address");
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            definition: compiled.definition,
            inputFingerprint: compiled.inputFingerprint,
            desiredLifecycle: "running" as const,
            portsGeneration: 1,
            privatePorts: [
              { workloadId: "pooler:pooler", binding: "primary", port: poolerAddress.port },
            ],
          },
        } satisfies { value: PersistedStackState };
        const ownerScope = yield* Scope.make();
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const engine = ownerInputContainerEngine(createdSpecs);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let fetches = 0;
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: engine,
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "present" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          fetchJson: (url) =>
            Effect.gen(function* () {
              fetches += 1;
              if (fetches > 2) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            }),
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const runtime = yield* factory.make(current.value);
        const pooler = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "pooler:pooler",
        );
        if (pooler === undefined) return yield* Effect.die("Expected Pooler workload");
        yield* runtime.driver.start(
          { stackId, desiredGeneration: 1, workloadId: pooler.id, specHash: pooler.specHash },
          pooler,
        );
        const firstTenant = createdSpecs
          .find((spec) => spec.labels.desiredGeneration === 1)
          ?.mounts.find((mount) => mount.target === "/app/pooler_tenant.exs")?.source;
        if (firstTenant === undefined) return yield* Effect.die("Missing first Pooler tenant");
        current.value = { ...current.value, desiredGeneration: 2, portsGeneration: 2 };
        const inFlight = yield* Effect.forkChild(
          runtime.driver.start(
            { stackId, desiredGeneration: 2, workloadId: pooler.id, specHash: pooler.specHash },
            pooler,
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* Scope.close(ownerScope, Exit.void);
        const inFlightExit = yield* Fiber.join(inFlight).pipe(Effect.exit);
        expect(Exit.isFailure(inFlightExit)).toBe(true);
        expect(yield* fs.exists(firstTenant)).toBe(false);
        yield* Deferred.succeed(release, undefined);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("cleans stale env and functions generations only during stack cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-cleanup-" });
        const current = { value: stateFor({}) };
        const envOwner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
        const functionsOwner = yield* makeFunctionsBootstrapOwner({
          stateRoot: root,
          stackId,
        });
        const envPath = yield* envOwner.write({
          generation: 4,
          workloadId: "database:database",
          values: { TOKEN: "stale" },
        });
        const bootstrapPath = yield* functionsOwner.write({
          generation: 4,
          content: "export default 1",
        });
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: artifacts,
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        yield* runtime.driver.stop({
          stackId,
          desiredGeneration: 4,
          workloadId: "database:database",
          specHash: "stale",
        });
        expect(yield* fs.exists(envPath)).toBe(true);
        expect(yield* fs.exists(bootstrapPath)).toBe(true);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* fs.exists(envPath)).toBe(false);
        expect(yield* fs.exists(bootstrapPath)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it("attempts both owner cleanups when runtime cleanup fails", () => {
    const calls: string[] = [];
    const runtimeFailure = new RuntimeDriverError({
      message: "runtime cleanup failed",
      stackId,
    });
    const driver: RuntimeDriver = {
      observe: () => Effect.succeed([]),
      start: () => Effect.die("unused"),
      stop: () => Effect.void,
      remove: () => Effect.void,
      cleanup: () => Effect.fail(runtimeFailure),
      recover: () => Effect.succeed([]),
    };
    const envOwner: RuntimeEnvFileOwner = {
      write: () => Effect.die("unused"),
      cleanupGeneration: () => Effect.void,
      cleanupAll: Effect.sync(() => {
        calls.push("env");
      }),
    };
    const functionsOwner: FunctionsBootstrapOwner = {
      write: () => Effect.die("unused"),
      cleanupGeneration: () => Effect.void,
      cleanupAll: Effect.sync(() => {
        calls.push("functions");
      }),
    };
    const wrapped = withOwnedRuntimeFileCleanup(driver, envOwner, functionsOwner);
    const result = Effect.runSyncExit(wrapped.cleanup({ stackId, destroy: false }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(calls.sort()).toEqual(["env", "functions"]);
  });

  it("continues owner cleanup when one file owner fails", () => {
    const calls: string[] = [];
    const driver: RuntimeDriver = {
      observe: () => Effect.succeed([]),
      start: () => Effect.die("unused"),
      stop: () => Effect.void,
      remove: () => Effect.void,
      cleanup: () => Effect.void,
      recover: () => Effect.succeed([]),
    };
    const envOwner: RuntimeEnvFileOwner = {
      write: () => Effect.die("unused"),
      cleanupGeneration: () => Effect.void,
      cleanupAll: Effect.gen(function* () {
        calls.push("env");
        return yield* new StackPreparationError({ message: "env cleanup failed" });
      }),
    };
    const functionsOwner: FunctionsBootstrapOwner = {
      write: () => Effect.die("unused"),
      cleanupGeneration: () => Effect.void,
      cleanupAll: Effect.sync(() => {
        calls.push("functions");
      }),
    };
    const wrapped = withOwnedRuntimeFileCleanup(driver, envOwner, functionsOwner);
    const result = Effect.runSyncExit(wrapped.cleanup({ stackId, destroy: false }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(calls).toEqual(["env", "functions"]);
  });
});
