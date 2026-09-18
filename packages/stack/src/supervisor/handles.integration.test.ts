import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createStack, findStack, openStack } from "../public/EffectStack.ts";
import {
  defaultRuntimeEnvironment,
  ensureSupervisor,
  SUPERVISOR_DISPATCH_SENTINEL,
  supervisorEntrypointFor,
  type StackRuntimeEnvironmentValue,
} from "./Launcher.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackId } from "../public/StackId.ts";
import {
  controlEndpointFor,
  readOwnerMetadata,
  StackRuntimeEnvironment,
} from "../state/Ownership.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { makeControlClient } from "../control/ControlServer.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { STACK_RPC_RELEASE } from "../control/StackRpc.ts";
import { catalogReleaseFor } from "../model/WorkloadCatalog.ts";
import { StackOwnershipConflictError, StackRuntimeMismatchError } from "../public/Errors.ts";
import type { ContainerEngine } from "../runtime/ContainerEngine.ts";
import {
  ContainerEngineResolver,
  defaultContainerEngineResolver,
} from "../runtime/ContainerEngineResolver.ts";

const databaseRelease = catalogReleaseFor("database:database");
if (databaseRelease === undefined) throw new Error("Missing default database release");

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-handles-" });
      const path = yield* Path.Path;
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = yield* defaultRuntimeEnvironment;
      const runtime: StackRuntimeEnvironmentValue = {
        ...defaults,
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      };
      const cleanupOwners = Effect.gen(function* () {
        const exists = yield* fs.exists(runtime.stateRoot);
        if (!exists) return;
        const entries = yield* fs.readDirectory(runtime.stateRoot);
        yield* Effect.forEach(
          entries,
          (entry) =>
            Schema.is(StackIdSchema)(entry) ? stopOwner(StackIdSchema.make(entry)) : Effect.void,
          { discard: true },
        );
      });
      return yield* effect(project).pipe(
        Effect.onExit(() => cleanupOwners),
        Effect.provideService(StackRuntimeEnvironment, runtime),
        Effect.provideService(ContainerEngineResolver, {
          isInstalled: () => Effect.succeed(false),
          resolve: (kind) => defaultContainerEngineResolver.resolve(kind),
        }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const stopOwner = (id: StackId) =>
  Effect.gen(function* () {
    const env = yield* StackRuntimeEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: id });
    const owner = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (owner === undefined) return;
    const removed = Stream.runHead(
      Stream.filterMapEffect(fs.watch(paths.stackRoot), () =>
        readOwnerMetadata(env.stateRoot, id, env).pipe(
          Effect.map((metadata) =>
            metadata === undefined ? Result.succeed(true) : Result.fail(undefined),
          ),
        ),
      ),
    );
    const watcher = yield* Effect.forkChild(removed);
    yield* Effect.scoped(
      makeControlClient(owner.endpoint, {
        stackId: id,
        ownerSessionId: owner.ownerSessionId,
        rpcRelease: owner.rpcRelease,
      }).stop,
    );
    const remaining = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (remaining === undefined) {
      yield* Fiber.interrupt(watcher);
      return;
    }
    yield* Fiber.join(watcher);
  });

const fakeContainerEngine = (kind: "docker" | "podman", calls: string[]): ContainerEngine => ({
  kind,
  preflight: Effect.succeed({ host: "host.containers.internal" }),
  probe: Effect.sync(() => {
    calls.push(`${kind}:probe`);
  }),
  inspectImage: (image) =>
    Effect.sync(() => {
      calls.push(`${kind}:inspect:${image}`);
      return { present: true };
    }),
  pullImage: (image) =>
    Effect.sync(() => {
      calls.push(`${kind}:pull:${image}`);
    }),
  listResources: () => Effect.succeed([]),
  createNetwork: () => Effect.die("unused"),
  removeNetwork: () => Effect.void,
  createVolume: () => Effect.die("unused"),
  removeVolume: () => Effect.void,
  createContainer: () => Effect.die("unused"),
  copyToContainer: () => Effect.void,
  execContainer: () => Effect.void,
  startContainer: () => Effect.void,
  waitContainer: () => Effect.succeed(0),
  stopContainer: () => Effect.void,
  removeContainer: () => Effect.void,
  streamLogs: () => Stream.empty,
});

describe("managed stack handles", { timeout: 30_000 }, () => {
  it("selects the private dispatch marker only for compiled Bun paths", () => {
    expect(
      supervisorEntrypointFor("file:///$bunfs/root/packages/stack/src/supervisor/Launcher.ts"),
    ).toBe(SUPERVISOR_DISPATCH_SENTINEL);
    expect(supervisorEntrypointFor(import.meta.url)).not.toBe(SUPERVISOR_DISPATCH_SENTINEL);
  });

  it("selects the private dispatch marker for Windows compiled Bun paths", () => {
    expect(
      supervisorEntrypointFor("C:\\$bunfs\\root\\packages\\stack\\src\\supervisor\\Launcher.ts"),
    ).toBe(SUPERVISOR_DISPATCH_SENTINEL);
  });

  it.live("preserves the child ownership detail for metadata without a lease lock", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const runtime: StackRuntimeEnvironmentValue = {
          ...env,
          platform: "windows",
          tempRoot: project,
        };
        const stack = yield* createStack({ initialConfig: {}, projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId: stack.id,
          ownerSessionId: "stale-owner",
          leasePort: 45_001,
          endpoint: controlEndpointFor(stack.id, runtime, 45_001),
          rpcRelease: STACK_RPC_RELEASE,
        };
        const ownerJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(owner);
        yield* fs.writeFileString(paths.controlMetadata, ownerJson);
        const frameJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ok: false,
          code: "ownership-conflict",
          message: "Owner metadata exists without a lease lock; refusing recovery",
        });
        const frame = new TextEncoder().encode(`${frameJson}\n`);
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: (fd) => (fd === 3 ? Stream.succeed(frame) : Stream.empty),
              unref: Effect.succeed(Effect.void),
            }),
          ),
        );
        const result = yield* ensureSupervisor({
          stackId: stack.id,
          stateStore: store,
          environment: runtime,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.exit,
        );
        yield* fs.remove(paths.controlMetadata, { force: true });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(StackOwnershipConflictError);
            expect(failure.value.message).toContain("without a lease lock");
          }
        }
      }),
    ),
  );

  it.live("does not kill a detached launch child when its caller is interrupted", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ initialConfig: {}, projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const killCalls = yield* Ref.make(0);
        const readinessObserved = yield* Deferred.make<void>();
        const child = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Ref.update(killCalls, (calls) => calls + 1),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () =>
            Stream.fromEffect(Deferred.succeed(readinessObserved, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          unref: Effect.succeed(Effect.void),
        });
        const spawner = ChildProcessSpawner.make(() => Effect.succeed(child));
        const launch = yield* Effect.forkChild(
          ensureSupervisor({
            stackId: stack.id,
            stateStore: store,
            environment: env,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          { startImmediately: true },
        );
        yield* Deferred.await(readinessObserved);
        yield* Fiber.interrupt(launch);
        expect(yield* Ref.get(killCalls)).toBe(0);
      }),
    ),
  );

  it.live("persists Docker for an omitted container engine without probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const resolver = {
          isInstalled: () => Effect.die("resolver must not be called"),
          resolve: () => Effect.die("resolver must not be called"),
        };
        yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "docker" });
      }),
    ),
  );

  it.live("selects Docker for a new stack when the client is installed", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = {
          isInstalled: (kind: "docker" | "podman") =>
            Effect.sync(() => {
              calls.push(kind);
              return true;
            }),
          resolve: () => Effect.die("engine construction must not run during create"),
        };
        yield* createStack({ initialConfig: {}, projectRoot: project }).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
        );
        expect(calls).toEqual(["docker"]);
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "docker" });
      }),
    ),
  );

  it.live("selects native for a new stack when the Docker client is absent", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = {
          isInstalled: (kind: "docker" | "podman") =>
            Effect.sync(() => {
              calls.push(kind);
              return false;
            }),
          resolve: () => Effect.die("engine construction must not run during create"),
        };
        yield* createStack({ initialConfig: {}, projectRoot: project }).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
        );
        expect(calls).toEqual(["docker"]);
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "native" });
      }),
    ),
  );

  it.live("persists explicit Podman without probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const resolver = {
          isInstalled: () => Effect.die("resolver must not be called"),
          resolve: () => Effect.die("resolver must not be called"),
        };
        yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "podman" });
      }),
    ),
  );

  it.live("reuses an existing runtime without probing the container resolver", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const created = yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        });
        const resolver = {
          isInstalled: () => Effect.die("resolver must not be called"),
          resolve: () => Effect.die("resolver must not be called"),
        };
        const reopened = yield* createStack({ initialConfig: {}, projectRoot: project }).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
        );
        expect(reopened.id).toBe(created.id);
        expect((yield* reopened.status).runtime).toEqual({ kind: "container", engine: "podman" });
      }),
    ),
  );

  it.live("prepares through only the explicitly selected Podman engine", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const dockerCalls: string[] = [];
        const resolver = {
          isInstalled: () => Effect.succeed(true),
          resolve: (kind: "docker" | "podman") =>
            Effect.succeed(
              kind === "podman"
                ? fakeContainerEngine(kind, calls)
                : fakeContainerEngine(kind, dockerCalls),
            ),
        };
        const stack = yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        const database = (yield* stack.status).instances.find(
          (instance) => instance.service === "database",
        );
        if (database === undefined) throw new Error("Database instance is missing");
        const prepared = yield* stack.prepare({ services: [database.id] });
        expect(prepared.instances).toHaveLength(1);
        expect(calls).toEqual(["podman:probe", `podman:inspect:${databaseRelease.containerImage}`]);
        expect(dockerCalls).toEqual([]);
      }),
    ),
  );

  it.live("does not probe a persisted container engine when reopening", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const created = yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        });
        const resolver = {
          isInstalled: () => Effect.die("resolver must not be called"),
          resolve: () => Effect.die("resolver must not be called"),
        };
        const stack = yield* openStack(created.id).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
        );
        expect((yield* stack.status).runtime).toEqual({ kind: "container", engine: "podman" });
      }),
    ),
  );

  it.live("rejects a conflicting explicit engine before probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container", engine: "docker" },
        });
        const result = yield* createStack({
          initialConfig: {},
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, {
            isInstalled: () => Effect.die("resolver must not be called"),
            resolve: () => Effect.die("resolver must not be called"),
          }),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(StackRuntimeMismatchError);
        }
      }),
    ),
  );

  it.live("does not probe an explicitly native identity", () =>
    withRuntimeRoot((project) =>
      createStack({ initialConfig: {}, projectRoot: project, runtime: { kind: "native" } }).pipe(
        Effect.provideService(ContainerEngineResolver, {
          isInstalled: () => Effect.die("native stack must not resolve a container engine"),
          resolve: () => Effect.die("native stack must not resolve a container engine"),
        }),
      ),
    ),
  );
});
