// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- Public Stack lifecycle scenarios use temporary native roots and Effect-backed process fixtures.

import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Sink,
  Stream,
} from "effect";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Stack } from "./Stack.ts";
import { localStackLayer } from "./LocalStack.ts";
import { StackBuilder } from "./StackBuilder.ts";
import { StackPreparation } from "./StackPreparation.ts";
import { resolveConfig } from "./StackConfigResolver.ts";
import { SERVICE_NAMES } from "./ServiceCatalog.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import type { PortSet } from "./PortCatalog.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { buildGraph, type ServiceDef } from "@supabase/process-compose";
import { StackBuildError } from "./errors.ts";
import type { PreparedStackArtifacts } from "./StackPreparation.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";
import type { PortLease } from "./PortAllocator.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { systemError, type PlatformError } from "effect/PlatformError";

interface SpawnRecord {
  readonly service: string;
  readonly pid: number;
  readonly args: ReadonlyArray<string>;
  readonly crash: Effect.Effect<void>;
}

const decodeSupervisor = (
  args: ReadonlyArray<string>,
): { command: string; args: string[] } | null => {
  const encoded = args.at(-1);
  if (encoded === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("command" in decoded) ||
      typeof decoded.command !== "string" ||
      !("args" in decoded) ||
      !Array.isArray(decoded.args) ||
      !decoded.args.every((arg) => typeof arg === "string")
    ) {
      return null;
    }
    return { command: decoded.command, args: decoded.args };
  } catch {
    return null;
  }
};

const serviceNameForSupervisor = (command: string, args: ReadonlyArray<string>): string | null => {
  if (command.includes("supabase-postgres-init.sh")) return "postgres";
  if (command === "bash" && args.some((arg) => arg.includes("supabase_migrations"))) {
    return "postgres-init";
  }
  const service = SERVICE_NAMES.find((candidate) => command.includes(`/${candidate}/`));
  if (service !== undefined) {
    if (service === "realtime" && command.endsWith("/migrate")) return "realtime-migrate";
    if (service === "realtime" && args[0] === "eval") return "realtime-seed";
    if (service === "analytics" && args[0] === "eval") {
      return args[1]?.includes("Logflare.SingleTenant.create_default_plan")
        ? "analytics-seed"
        : "analytics-migrate";
    }
    if (service === "pooler" && command.endsWith("/migrate")) return "pooler-migrate";
    if (service === "pooler" && command.endsWith("/supavisor")) return "pooler-bootstrap";
    return service;
  }
  return null;
};

const oneShotServices = new Set([
  "postgres-init",
  "realtime-migrate",
  "realtime-seed",
  "analytics-migrate",
  "analytics-seed",
  "pooler-migrate",
  "pooler-bootstrap",
]);

const nativeLifecycleError = (method: string, port: number, cause: unknown): PlatformError =>
  systemError({
    _tag: "Unknown",
    module: "native-service-lifecycle-test",
    method,
    pathOrDescriptor: port,
    cause,
  });

const listenTestServer = (server: ReturnType<typeof createServer>, port: number) =>
  Effect.callback<void, PlatformError>((resume, signal) => {
    let completed = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
      signal.removeEventListener("abort", onAbort);
    };
    const complete = (effect: Effect.Effect<void, PlatformError>) => {
      if (completed) return;
      completed = true;
      cleanup();
      resume(effect);
    };
    const onError = (cause: unknown) =>
      complete(Effect.fail(nativeLifecycleError("listen", port, cause)));
    const onListening = () => complete(Effect.void);
    const onAbort = () => {
      if (completed) return;
      completed = true;
      cleanup();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return Effect.sync(() => {
        cleanup();
        if (server.listening) server.close();
      });
    }
    try {
      server.listen({ port, host: "127.0.0.1", signal });
    } catch (cause) {
      onError(cause);
    }
    return Effect.sync(() => {
      cleanup();
      if (server.listening) server.close();
    });
  });

const closeTestServer = (server: ReturnType<typeof createServer>, port: number) =>
  Effect.callback<void, PlatformError>((resume, signal) => {
    let completed = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const complete = (effect: Effect.Effect<void, PlatformError>) => {
      if (completed) return;
      completed = true;
      cleanup();
      resume(effect);
    };
    const onError = (cause: unknown) =>
      complete(Effect.fail(nativeLifecycleError("close", port, cause)));
    const onClose = () => complete(Effect.void);
    const onAbort = () => {
      if (completed) return;
      completed = true;
      cleanup();
      if (server.listening) server.close();
    };

    server.once("error", onError);
    server.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return Effect.void;
    }
    try {
      server.close();
    } catch (cause) {
      onError(cause);
    }
    return Effect.sync(() => {
      cleanup();
      if (server.listening) server.close();
    });
  });

const controllableSpawner = (options: { readonly bindPoolerBootstrapPort?: number } = {}) => {
  const spawned: SpawnRecord[] = [];
  const killed: string[] = [];
  let nextPid = 10_000;

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = Predicate.isTagged(command, "StandardCommand") ? command.command : "";
        const args = Predicate.isTagged(command, "StandardCommand") ? command.args : [];
        const supervisor = cmd === process.execPath ? decodeSupervisor(args) : null;
        const service =
          supervisor === null
            ? null
            : serviceNameForSupervisor(supervisor.command, supervisor.args);
        if (options.bindPoolerBootstrapPort !== undefined && service === "pooler-bootstrap") {
          const port = options.bindPoolerBootstrapPort;
          const server = createServer();
          yield* listenTestServer(server, port);
          yield* closeTestServer(server, port);
        }
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        let running = true;
        const pid = nextPid++;
        const finish = (code: number) =>
          Effect.sync(() => {
            running = false;
          }).pipe(
            Effect.andThen(Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(code))),
            Effect.ignore,
          );

        if (cmd === "true" || (service !== null && oneShotServices.has(service))) {
          yield* finish(0);
        }

        if (service !== null) {
          const record: SpawnRecord = {
            service,
            pid,
            args,
            crash: finish(1),
          };
          spawned.push(record);
        }

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.sync(() => running),
          stdin: Sink.drain,
          kill: (opts) => {
            if (service !== null) killed.push(service);
            return finish(opts?.killSignal === "SIGKILL" ? 137 : 143);
          },
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
  return {
    layer,
    spawned,
    killed,
    crash: (service: string) => {
      const record = [...spawned].reverse().find((candidate) => candidate.service === service);
      return record === undefined ? Effect.die(`No running process for ${service}`) : record.crash;
    },
  };
};

const latestPid = (
  spawner: ReturnType<typeof controllableSpawner>,
  service: string,
): number | null =>
  [...spawner.spawned].reverse().find((entry) => entry.service === service)?.pid ?? null;

const ports = (base: number): PortSet => ({
  apiPort: base,
  dbPort: base + 1,
  authPort: base + 2,
  postgrestPort: base + 3,
  postgrestAdminPort: base + 4,
  edgeRuntimePort: base + 5,
  edgeRuntimeInspectorPort: base + 6,
  realtimePort: base + 7,
  storagePort: base + 8,
  imgproxyPort: base + 9,
  mailpitPort: base + 10,
  mailpitSmtpPort: base + 11,
  mailpitPop3Port: base + 12,
  pgmetaPort: base + 13,
  studioPort: base + 14,
  analyticsPort: base + 15,
  vectorAdminPort: base + 16,
  poolerSessionPort: base + 17,
  poolerTransactionPort: base + 18,
  poolerApiPort: base + 19,
  poolerInternalPort: base + 20,
});

const allBinaries = Object.fromEntries(
  SERVICE_NAMES.map((service) => [service, `/fake/slim/${service}`]),
);

const makeConfig = (root: string, base: number) =>
  resolveConfig(
    {
      mode: "native",
      readiness: { mode: "finite", timeoutMs: 5_000 },
      servicePolicies: {
        postgres: "eager",
        postgrest: "lazy",
        auth: "lazy",
        "edge-runtime": "lazy",
        realtime: "eager",
        storage: "lazy",
        imgproxy: "lazy",
        mailpit: "eager",
        pgmeta: "eager",
        studio: "eager",
        analytics: "eager",
        vector: "eager",
        pooler: "eager",
      },
      edgeRuntime: {},
      realtime: {},
      storage: {},
      imgproxy: {},
      mailpit: {},
      pgmeta: {},
      studio: {},
      analytics: {},
      vector: {},
      pooler: {},
    },
    {
      ports: ports(base),
      stackRoot: join(root, "stack"),
      runtimeRoot: join(root, "runtime"),
      runtime: { mode: "native", containerRuntime: null },
    },
  );

const graphWithExecHealth = Layer.effect(
  StackBuilder,
  Effect.gen(function* () {
    const builder = yield* StackBuilder;
    return {
      build: (config: ResolvedStackConfig, prepared: PreparedStackArtifacts) =>
        builder.build(config, prepared).pipe(
          Effect.flatMap((result) =>
            buildGraph(
              result.graph.startOrder.map((definition: ServiceDef) =>
                definition.healthCheck === undefined
                  ? definition
                  : {
                      ...definition,
                      healthCheck: {
                        ...definition.healthCheck,
                        probe: { _tag: "Exec", command: "true", args: [] },
                        initialDelaySeconds: 0,
                        periodSeconds: 1,
                        timeoutSeconds: 1,
                      },
                    },
              ),
            ).pipe(
              Effect.map((graph) => ({ ...result, graph })),
              Effect.mapError(
                (cause) =>
                  new StackBuildError({
                    detail: `Test graph health override failed: ${String(cause)}`,
                  }),
              ),
            ),
          ),
        ),
    };
  }),
).pipe(Layer.provide(StackBuilder.layer));

const setup = (
  config: ResolvedStackConfig,
  spawner = controllableSpawner(),
  resolver = mockBinaryResolver({ binaries: allBinaries }),
  portLease: PortLease = {
    ports: config.ports,
    reserve: () => Effect.void,
    release: () => Effect.void,
    releaseAll: Effect.void,
  },
) => {
  const layer = localStackLayer(config, {
    ports: portLease.ports,
    reserve: portLease.reserve,
    release: portLease.release,
    releaseAll: portLease.releaseAll,
  }).pipe(
    Layer.provide(graphWithExecHealth),
    Layer.provide(
      StackPreparation.layer.pipe(Layer.provide(resolver.layer), Layer.provide(spawner.layer)),
    ),
    Layer.provide(spawner.layer),
    Layer.provide(NodeServices.layer),
  );
  return { layer, resolver, spawner };
};

describe("native service graph lifecycle", () => {
  it.live(
    "starts mixed eager services, retries lazy Storage JIT, and restarts its owner closure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: tmpdir(),
          prefix: "supabase-native-lifecycle-",
        });
        const config = yield* makeConfig(root, 45_000).pipe(Effect.provide(NodeServices.layer));
        const resolver = mockBinaryResolver({
          binaries: allBinaries,
          failOnceServices: ["storage"],
        });
        const spawner = controllableSpawner();
        const { layer } = setup(config, spawner, resolver);
        yield* Effect.gen(function* () {
          const stack = yield* Stack.pipe(Effect.provide(layer));
          yield* stack.start;
          for (const service of [
            "postgres",
            "realtime",
            "mailpit",
            "pgmeta",
            "studio",
            "analytics",
            "vector",
            "pooler",
          ]) {
            expect((yield* stack.getState(service)).status).toBe("Healthy");
          }
          expect((yield* stack.getState("storage")).status).toBe("Dormant");
          expect((yield* stack.getState("imgproxy")).status).toBe("Dormant");
          expect(resolver.resolved.some(({ service }) => service === "storage")).toBe(false);
          expect(spawner.spawned.some(({ service }) => service === "storage")).toBe(false);

          const eagerSpawnCounts = new Map(
            spawner.spawned.map(({ service }) => [
              service,
              spawner.spawned.filter((entry) => entry.service === service).length,
            ]),
          );
          const eagerPids = new Map(
            [...eagerSpawnCounts.keys()].map((service) => [service, latestPid(spawner, service)]),
          );
          const firstActivation = yield* stack.startService("storage").pipe(Effect.exit);
          expect(Exit.isFailure(firstActivation)).toBe(true);
          if (Exit.isFailure(firstActivation)) {
            expect(Cause.squash(firstActivation.cause)).toBeInstanceOf(StackBuildError);
          }
          expect((yield* stack.getState("storage")).status).toBe("Dormant");
          expect((yield* stack.getState("imgproxy")).status).toBe("Dormant");
          expect((yield* stack.getState("postgres")).status).toBe("Healthy");

          yield* stack.startService("storage");
          expect((yield* stack.getState("storage")).status).toBe("Healthy");
          expect((yield* stack.getState("imgproxy")).status).toBe("Healthy");
          expect(resolver.resolved.some(({ service }) => service === "storage")).toBe(true);
          expect(resolver.resolved.some(({ service }) => service === "imgproxy")).toBe(true);
          expect((yield* stack.getState("edge-runtime")).status).toBe("Dormant");

          const resolvedBeforeRestart = resolver.resolved.length;
          const beforeRestart = new Map(
            spawner.spawned.map(({ service }) => [
              service,
              spawner.spawned.filter((entry) => entry.service === service).length,
            ]),
          );
          yield* stack.restartService("storage");
          yield* stack.waitReady("imgproxy");
          expect((yield* stack.getState("storage")).status).toBe("Healthy");
          expect((yield* stack.getState("imgproxy")).status).toBe("Healthy");
          expect(spawner.spawned.filter(({ service }) => service === "storage").length).toBe(
            (beforeRestart.get("storage") ?? 0) + 1,
          );
          expect(spawner.spawned.filter(({ service }) => service === "imgproxy").length).toBe(
            (beforeRestart.get("imgproxy") ?? 0) + 1,
          );
          expect(resolver.resolved.length).toBe(resolvedBeforeRestart);
          for (const [service, count] of eagerSpawnCounts) {
            if (service !== "storage" && service !== "imgproxy") {
              expect(spawner.spawned.filter((entry) => entry.service === service).length).toBe(
                count,
              );
              expect(latestPid(spawner, service)).toBe(eagerPids.get(service));
            }
          }
          yield* stack.dispose;
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("starts Pooler when its bootstrap binds the allocated private shard span", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: tmpdir(),
        prefix: "supabase-native-pooler-bootstrap-",
      });
      const lease = yield* reservePortSet([
        { field: "poolerInternalPort", selection: { kind: "automatic" } },
      ]);
      const internalPort = lease.ports.poolerInternalPort;
      if (internalPort === undefined) {
        yield* lease.releaseAll;
        return yield* Effect.die(new Error("Expected Pooler internal port allocation"));
      }
      yield* Effect.gen(function* () {
        const config = yield* makeConfig(root, internalPort - 20);
        const spawner = controllableSpawner({ bindPoolerBootstrapPort: internalPort });
        const internalLease: PortLease = {
          ports: config.ports,
          reserve: (fields) =>
            fields.includes("poolerInternalPort")
              ? lease.reserve(["poolerInternalPort"])
              : Effect.void,
          release: (fields) =>
            fields.includes("poolerInternalPort")
              ? lease.release(["poolerInternalPort"])
              : Effect.void,
          releaseAll: lease.releaseAll,
        };
        const { layer } = setup(config, spawner, undefined, internalLease);
        yield* Effect.gen(function* () {
          const stack = yield* Stack;
          yield* stack.start;
          expect((yield* stack.getState("pooler")).status).toBe("Healthy");
          yield* stack.dispose;
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.ensuring(lease.releaseAll));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("recovers one crashed Storage stack without affecting a sibling stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootA = yield* fs.makeTempDirectoryScoped({
        directory: tmpdir(),
        prefix: "supabase-native-lifecycle-a-",
      });
      const rootB = yield* fs.makeTempDirectoryScoped({
        directory: tmpdir(),
        prefix: "supabase-native-lifecycle-b-",
      });
      const configA = yield* makeConfig(rootA, 45_100).pipe(Effect.provide(NodeServices.layer));
      const configB = yield* makeConfig(rootB, 45_200).pipe(Effect.provide(NodeServices.layer));
      const spawnerA = controllableSpawner();
      const spawnerB = controllableSpawner();
      const setupA = setup(configA, spawnerA);
      const setupB = setup(configB, spawnerB);
      const scope = yield* Effect.scope;
      const contextA = yield* Layer.buildWithScope(setupA.layer, scope);
      const contextB = yield* Layer.buildWithScope(setupB.layer, scope);
      const stackA = Context.get(contextA, Stack);
      const stackB = Context.get(contextB, Stack);
      yield* stackA.start;
      yield* stackB.start;
      yield* stackA.startService("storage");
      yield* stackB.startService("storage");
      const stackACounts = new Map(
        spawnerA.spawned.map(({ service }) => [
          service,
          spawnerA.spawned.filter((entry) => entry.service === service).length,
        ]),
      );
      const stackAPids = new Map(
        [...stackACounts.keys()].map((service) => [service, latestPid(spawnerA, service)]),
      );
      const siblingCounts = new Map(
        spawnerB.spawned.map(({ service }) => [
          service,
          spawnerB.spawned.filter((entry) => entry.service === service).length,
        ]),
      );
      const previousStorage = yield* stackA.getState("storage");
      const recovered = yield* stackA.stateChanges("storage").pipe(
        Effect.flatMap((changes) =>
          changes.pipe(
            Stream.filter(
              (state) =>
                state.status === "Healthy" && state.restartCount > previousStorage.restartCount,
            ),
            Stream.runHead,
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* spawnerA.crash("storage");
      const recoveredState = yield* Fiber.join(recovered).pipe(
        Effect.map(Option.getOrThrow),
        Effect.timeout("5 seconds"),
      );
      expect(recoveredState.status).toBe("Healthy");
      expect(recoveredState.restartCount).toBeGreaterThan(previousStorage.restartCount);
      expect((yield* stackA.getState("imgproxy")).status).toBe("Healthy");
      expect((yield* stackB.getState("storage")).status).toBe("Healthy");
      for (const [service, count] of stackACounts) {
        if (service !== "storage") {
          expect(spawnerA.spawned.filter((entry) => entry.service === service).length).toBe(count);
          expect(latestPid(spawnerA, service)).toBe(stackAPids.get(service));
        }
      }
      for (const [service, count] of siblingCounts) {
        expect(spawnerB.spawned.filter((entry) => entry.service === service).length).toBe(count);
      }
      const killedBeforeDispose = [...spawnerB.killed];
      yield* stackA.dispose;
      expect(spawnerA.killed.length).toBeGreaterThan(0);
      expect(spawnerB.killed).toEqual(killedBeforeDispose);
      expect((yield* stackB.getState("storage")).status).toBe("Healthy");
      yield* stackB.dispose;
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
