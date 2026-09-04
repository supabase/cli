import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  Sink,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import {
  createStack,
  findStack,
  inspectStack,
  openStack,
  listStacks,
} from "../public/EffectStack.ts";
import type { StackStatus } from "../public/Status.ts";
import { deriveStackId, resolveStackIdentity } from "../identity/Identity.ts";
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
  acquireOwnership,
  controlEndpointFor,
  publishOwnership,
  readOwnerMetadata,
  StackRuntimeEnvironment,
} from "../state/Ownership.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { makeControlClient, startControlServer } from "../control/ControlServer.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { STACK_RPC_RELEASE, type StackRpcHandlers } from "../control/StackRpc.ts";
import {
  StackOwnershipConflictError,
  StackPreparationError,
  StackRuntimeMismatchError,
} from "../public/Errors.ts";
import type { ContainerEngine } from "../runtime/ContainerEngine.ts";
import { ContainerEngineResolver } from "../runtime/ContainerEngineResolver.ts";

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-handles-" });
      const path = yield* Path.Path;
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = defaultRuntimeEnvironment();
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
      }).stop(),
    );
    const remaining = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (remaining === undefined) {
      yield* Fiber.interrupt(watcher);
      return;
    }
    yield* Fiber.join(watcher);
  });

const quoteModuleSpecifier = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const fakeContainerEngine = (kind: "docker" | "podman", calls: string[]): ContainerEngine => ({
  kind,
  executable: kind,
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
  startContainer: () => Effect.void,
  waitContainer: () => Effect.succeed(0),
  stopContainer: () => Effect.void,
  removeContainer: () => Effect.void,
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
        const stack = yield* createStack({ projectRoot: project });
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId: stack.id,
          ownerSessionId: "stale-owner",
          endpoint: controlEndpointFor(stack.id, runtime),
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
          identity,
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

  it.live("persists Docker for an omitted container engine without probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const resolver = { resolve: () => Effect.die("resolver must not be called") };
        yield* createStack({ projectRoot: project, runtime: { kind: "container" } }).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
        );
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "docker" });
      }),
    ),
  );

  it.live("persists explicit Podman without probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const resolver = { resolve: () => Effect.die("resolver must not be called") };
        yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "podman" });
      }),
    ),
  );

  it.live("prepares through only the explicitly selected Podman engine", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const dockerCalls: string[] = [];
        const resolver = {
          resolve: (kind: "docker" | "podman") =>
            Effect.succeed(
              kind === "podman"
                ? fakeContainerEngine(kind, calls)
                : fakeContainerEngine(kind, dockerCalls),
            ),
        };
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        const prepared = yield* stack.prepare({ capabilities: ["database"] });
        expect(prepared.capabilities).toHaveLength(1);
        expect(calls).toEqual([
          "podman:probe",
          "podman:inspect:ghcr.io/supabase/cli/postgres:17.6.1.167",
        ]);
        expect(dockerCalls).toEqual([]);
      }),
    ),
  );

  it.live("does not probe a persisted container engine when reopening", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const created = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        });
        const resolver = { resolve: () => Effect.die("resolver must not be called") };
        const stack = yield* openStack(created.id).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
        );
        expect((yield* stack.status()).runtime).toEqual({ kind: "container", engine: "podman" });
      }),
    ),
  );

  it.live("rejects a conflicting explicit engine before probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "docker" },
        });
        const result = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, {
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
      createStack({ projectRoot: project, runtime: { kind: "native" } }),
    ),
  );

  it.live("creates an unconfigured stack without reading config or starting workloads", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project });
        const status = yield* stack.status();
        expect(status.lifecycle).toBe("unconfigured");
        expect(status.desiredLifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("preserves preparation failures returned by the owner start RPC", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const crypto = yield* Crypto.Crypto;
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const stackId = yield* deriveStackId(identity);
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        yield* store.initialize(stackId, {
          format: "supabase-stack-state-v1",
          identity: { ...identity, stackId },
          runtime: { kind: "native" },
          desiredLifecycle: "stopped",
          ports: [],
          privatePorts: [],
          secrets: {},
        });
        const ownerSessionId = yield* crypto.randomUUIDv4;
        const lease = yield* acquireOwnership({
          stateRoot: env.stateRoot,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          environment: env,
        });
        yield* publishOwnership(lease);
        const status: StackStatus = {
          id: stackId,
          lifecycle: "stopped",
          desiredLifecycle: "stopped",
          runtime: { kind: "native" },
          endpoints: {},
          versions: {},
          capabilities: CAPABILITY_NAMES.map((name) => ({
            name,
            activation: "eager",
            state: "stopped",
          })),
        };
        const handlers: StackRpcHandlers = {
          status: () => Effect.succeed(status),
          credentials: () =>
            Effect.succeed({
              database: {
                url: Redacted.make("postgres://localhost"),
                password: Redacted.make("secret"),
              },
              api: {
                publishableKey: "publishable",
                secretKey: Redacted.make("secret"),
                anonJwt: "anon",
                serviceRoleJwt: Redacted.make("service"),
              },
            }),
          start: () =>
            Effect.fail({ tag: "StackPreparationError", message: "artifact is incomplete" }),
          destroy: () => Effect.void,
          logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
        };
        yield* startControlServer({
          endpoint: lease.metadata.endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" }),
          },
          rpcHandlers: handlers,
        });
        const stack = yield* openStack(stackId);
        const failed = yield* stack.start({ config: {} }).pipe(Effect.exit);
        const error = Exit.isFailure(failed)
          ? Option.getOrUndefined(Cause.findErrorOption(failed.cause))
          : undefined;
        yield* lease.release;
        expect(Exit.isFailure(failed)).toBe(true);
        expect(error).toBeInstanceOf(StackPreparationError);
        expect(error).toMatchObject({ message: "artifact is incomplete" });
      }),
    ),
  );

  it.live("waits for the owner control socket to close before destroy resolves", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const crypto = yield* Crypto.Crypto;
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const stackId = yield* deriveStackId(identity);
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        yield* store.initialize(stackId, {
          format: "supabase-stack-state-v1",
          identity: { ...identity, stackId },
          runtime: { kind: "native" },
          desiredLifecycle: "stopped",
          ports: [],
          privatePorts: [],
          secrets: {},
        });
        const ownerSessionId = yield* crypto.randomUUIDv4;
        const lease = yield* acquireOwnership({
          stateRoot: env.stateRoot,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          environment: env,
        });
        yield* publishOwnership(lease);
        const ownerScope = yield* Scope.make();
        const status: StackStatus = {
          id: stackId,
          lifecycle: "stopped",
          desiredLifecycle: "stopped",
          runtime: { kind: "native" },
          endpoints: {},
          versions: {},
          capabilities: CAPABILITY_NAMES.map((name) => ({
            name,
            activation: "eager",
            state: "stopped",
          })),
        };
        const destroyStarted = yield* Deferred.make<void>();
        const responseRelease = yield* Deferred.make<void>();
        const callbackStarted = yield* Deferred.make<void>();
        const callbackRelease = yield* Deferred.make<void>();
        const callbackCompleted = yield* Deferred.make<void>();
        const destroyDone = yield* Deferred.make<void>();
        yield* startControlServer({
          endpoint: lease.metadata.endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" }),
          },
          rpcHandlers: {
            status: () => Effect.succeed(status),
            credentials: () =>
              Effect.fail({ tag: "StackNotRunningError" as const, message: "not running" }),
            start: () => Effect.succeed(status),
            destroy: () =>
              Deferred.succeed(destroyStarted, undefined).pipe(
                Effect.andThen(Deferred.await(responseRelease)),
                Effect.asVoid,
              ),
            logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
          },
          onShutdownReady: Deferred.succeed(callbackStarted, undefined).pipe(
            Effect.andThen(Deferred.await(callbackRelease)),
            Effect.andThen(Deferred.succeed(callbackCompleted, undefined)),
            Effect.asVoid,
          ),
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* openStack(stackId);
        const destroyFiber = yield* Effect.forkChild(
          stack.destroy().pipe(Effect.andThen(Deferred.succeed(destroyDone, undefined))),
          { startImmediately: true },
        );
        yield* Deferred.await(destroyStarted);
        yield* Deferred.succeed(responseRelease, undefined);
        yield* Deferred.await(callbackStarted);
        expect(yield* Deferred.isDone(destroyDone)).toBe(false);
        yield* Deferred.succeed(callbackRelease, undefined);
        yield* Deferred.await(callbackCompleted);
        yield* Scope.close(ownerScope, Exit.void);
        yield* Fiber.join(destroyFiber);
        yield* lease.release;
      }),
    ),
  );

  it.live("concurrent equivalent creates join one owner", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [createStack({ projectRoot: project }), createStack({ projectRoot: project })],
          { concurrency: 2 },
        );
        expect(second.id).toBe(first.id);
        expect((yield* second.status()).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("discovery never creates an identity", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const found = yield* findStack({ projectRoot: project });
        expect(Option.isNone(found)).toBe(true);
        const absentId = StackIdSchema.make("f".repeat(64));
        const absent = yield* inspectStack(absentId).pipe(Effect.exit);
        expect(Exit.isFailure(absent)).toBe(true);
      }),
    ),
  );

  it.live("openStack is observational and rejects unknown ids", () =>
    withRuntimeRoot((_project) =>
      Effect.gen(function* () {
        const result = yield* openStack(StackIdSchema.make("0".repeat(64))).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("an ordinary handle exposes no lifecycle close operation", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const first = yield* createStack({ projectRoot: project });
        const id = first.id;
        const second = yield* openStack(id);
        expect((yield* second.status()).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("filters read-only discovery by project root", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const other = path.join(path.dirname(project), "other-project");
        yield* fs.makeDirectory(other);
        const first = yield* createStack({ projectRoot: project });
        yield* createStack({ projectRoot: other });
        const filtered = yield* listStacks({ projectRoot: project });
        expect(filtered.map((entry) => entry.id)).toEqual([first.id]);
      }),
    ),
  );

  it.live("concurrent caller processes share one stack identity after exit", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const supabaseHome = path.dirname(project);
        const stackModule = new URL("../public/EffectStack.ts", import.meta.url).href;
        const encodedStackModule = quoteModuleSpecifier(stackModule);
        const script = `
          const { Effect } = await import("effect");
          const { NodeServices } = await import("@effect/platform-node");
          const { createStack } = await import(${encodedStackModule});
          const stack = await Effect.runPromise(Effect.scoped(createStack({ projectRoot: process.argv[1] }).pipe(Effect.provide(NodeServices.layer))));
          process.stdout.write(stack.id);
        `;
        const spawnCaller = () =>
          Effect.gen(function* () {
            const child = yield* ChildProcess.make(
              process.execPath,
              ["--input-type=module", "-e", script, project],
              {
                cwd: process.cwd(),
                env: { SUPABASE_HOME: supabaseHome },
                extendEnv: true,
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            const [chunks, stderrChunks, code] = yield* Effect.all(
              [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
              { concurrency: 3 },
            );
            const bytes = new Uint8Array(chunks.reduce((sum, value) => sum + value.byteLength, 0));
            let offset = 0;
            for (const value of chunks) {
              bytes.set(value, offset);
              offset += value.byteLength;
            }
            const stderrBytes = new Uint8Array(
              stderrChunks.reduce((sum, value) => sum + value.byteLength, 0),
            );
            offset = 0;
            for (const value of stderrChunks) {
              stderrBytes.set(value, offset);
              offset += value.byteLength;
            }
            const stderr = new TextDecoder().decode(stderrBytes);
            return { id: new TextDecoder().decode(bytes), code, stderr };
          });
        const [first, second] = yield* Effect.all([spawnCaller(), spawnCaller()], {
          concurrency: 2,
        });
        expect(first.code, first.stderr).toBe(0);
        expect(second.code, second.stderr).toBe(0);
        expect(first.id).toBe(second.id);
        const attached = yield* openStack(StackIdSchema.make(first.id));
        expect((yield* attached.status()).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live(
    "maintenance stop keeps an unconfigured owner usable without fabricating lifecycle state",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const stack = yield* createStack({ projectRoot: project });
          yield* stack.stop();
          const status = yield* stack.status();
          expect(status.lifecycle).toBe("unconfigured");
        }),
      ),
  );
});
