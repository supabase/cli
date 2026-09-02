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
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  defaultRuntimeEnvironment,
  ensureSupervisor,
  type StackRuntimeEnvironmentValue,
} from "../supervisor/Launcher.ts";
import {
  StackRuntimeEnvironment,
  acquireOwnership,
  ownerLockExists,
  publishOwnership,
  readOwnerMetadata,
} from "../state/Ownership.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { deriveStackId, resolveStackIdentity } from "../identity/Identity.ts";
import { toPersistedIdentity } from "../state/StackState.ts";
import { startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcHandlers } from "../control/StackRpc.ts";
import {
  StackDestructionError,
  StackLifecycleConflictError,
  StackOwnershipConflictError,
  StackPreparationError,
  StackStateInvalidError,
} from "./Errors.ts";
import {
  createStack,
  inspectStack,
  makeHandle,
  openStack,
  type EffectStack,
} from "./EffectStack.ts";
import * as effectApi from "../effect.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const runningStatus: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: name === "pooler" ? "disabled" : "ready",
  })),
};

const credentials = {
  database: { url: Redacted.make("postgres://localhost"), password: Redacted.make("secret") },
  api: {
    publishableKey: "publishable",
    secretKey: Redacted.make("secret"),
    anonJwt: "anon",
    serviceRoleJwt: Redacted.make("service"),
  },
};

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "supabase-effect-stack-owner-" });
      yield* Effect.addFinalizer(() =>
        fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = defaultRuntimeEnvironment();
      const runtime: StackRuntimeEnvironmentValue = {
        ...defaults,
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      };
      return yield* effect(project).pipe(Effect.provideService(StackRuntimeEnvironment, runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("Effect stack lifecycle handoff", () => {
  it.live("creates a stopped stack without launching a Supervisor", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        const offline = yield* stack.status();
        expect(offline.lifecycle).toBe("unconfigured");
        expect(offline.capabilities.every(({ state }) => state === "disabled")).toBe(true);
        const opened = yield* openStack(stack.id, { replaceIncompatibleOwner: true });
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        yield* opened.close();
        yield* stack.stop();
        expect(yield* Stream.runCollect(stack.watchStatus())).toHaveLength(1);
        expect(yield* Stream.runCollect(stack.logs())).toHaveLength(0);
        yield* stack.close();
      }),
    ),
  );

  it.live("releases a temporary Supervisor after a pre-commit start failure", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });

        const started = yield* stack
          .start({ config: { capabilities: { database: { version: "15" } } } })
          .pipe(Effect.exit);

        expect(Exit.isFailure(started)).toBe(true);
        yield* Effect.gen(function* () {
          const owner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
          const locked = yield* ownerLockExists(env.stateRoot, stack.id);
          if (owner !== undefined || locked)
            return yield* new StackOwnershipConflictError({
              message: "temporary Supervisor is still shutting down",
            });
        }).pipe(Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ times: 200 }))));
        expect((yield* stack.status()).lifecycle).toBe("unconfigured");
        yield* stack.close();
      }),
    ),
  );

  it.live("never projects offline state while metadata or the ownership lock remains", () =>
    Effect.gen(function* () {
      for (const artifact of ["metadata", "lock"] as const) {
        const ownership = new StackOwnershipConflictError({
          message: `owner ${artifact} is still present`,
        });
        const stack = yield* makeHandle(
          stackId,
          {},
          {
            resolveOwner: () => Effect.succeed(Option.none()),
            readOfflineState: () => Effect.fail(ownership),
            readLogs: () => Effect.fail(ownership),
          },
        );
        const status = yield* stack.status().pipe(Effect.exit);
        expect(Exit.isFailure(status)).toBe(true);
        const logs = yield* Stream.runCollect(stack.logs()).pipe(Effect.exit);
        expect(Exit.isFailure(logs)).toBe(true);
        const watch = yield* Stream.runHead(stack.watchStatus()).pipe(Effect.exit);
        expect(Exit.isFailure(watch)).toBe(true);
        yield* stack.close();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "guards offline operations against real lock-only and metadata ownership",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const env = yield* StackRuntimeEnvironment;
          const stack = yield* createStack({ projectRoot: project });
          const lease = yield* acquireOwnership({
            stateRoot: env.stateRoot,
            stackId: stack.id,
            ownerSessionId: "offline-guard",
            rpcRelease: STACK_RPC_RELEASE,
            environment: env,
          });
          const assertGuarded = (candidate: EffectStack) =>
            Effect.gen(function* () {
              expect(Exit.isFailure(yield* candidate.status().pipe(Effect.exit))).toBe(true);
              expect(
                Exit.isFailure(yield* Stream.runCollect(candidate.logs()).pipe(Effect.exit)),
              ).toBe(true);
              expect(
                Exit.isFailure(yield* Stream.runHead(candidate.watchStatus()).pipe(Effect.exit)),
              ).toBe(true);
              yield* candidate.close();
            });
          const lockOnly = yield* openStack(stack.id);
          expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(true);
          expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
          expect((yield* inspectStack(stack.id)).owner).toBe("unreachable");
          yield* assertGuarded(lockOnly);
          yield* lease.release;

          const metadataLease = yield* acquireOwnership({
            stateRoot: env.stateRoot,
            stackId: stack.id,
            ownerSessionId: "offline-metadata",
            rpcRelease: STACK_RPC_RELEASE,
            environment: env,
          });
          yield* publishOwnership(metadataLease);
          const metadataOnly = yield* openStack(stack.id);
          expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeDefined();
          yield* assertGuarded(metadataOnly);
          yield* stack.close();
        }),
      ),
    60_000,
  );

  it.live("waits for server-owned temporary Supervisor shutdown after prepare", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-effect-stack-prepare-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "prepare-session";
        const shutdownReady = yield* Deferred.make<void>();
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          prepare: () => Effect.fail({ tag: "StackRpcProtocolError", message: "prepare failed" }),
          start: () => Effect.succeed(runningStatus),
          restart: () => Effect.succeed(runningStatus),
          destroy: () => Effect.void,
          logs: () => Stream.empty,
          watchStatus: () => Stream.empty,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers,
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
          onShutdownReady: Deferred.succeed(shutdownReady, undefined).pipe(Effect.asVoid),
        });
        let launched = false;
        const stack = yield* makeHandle(
          stackId,
          {},
          {
            resolveOwner: (launch) =>
              Effect.sync(() => {
                if (launch) launched = true;
                return launched ? Option.some(owner) : Option.none();
              }),
            waitForRelease: () => Deferred.await(shutdownReady),
          },
        );
        const result = yield* stack.prepare().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StackPreparationError);
        }
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("classifies successful prepare by whether the temporary owner remains live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-effect-stack-prepare-start-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "prepare-start-session";
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            prepare: () => Effect.succeed({ capabilities: [] }),
            start: () => Effect.succeed(runningStatus),
            restart: () => Effect.succeed(runningStatus),
            destroy: () => Effect.void,
            logs: () => Stream.empty,
            watchStatus: () => Stream.empty,
          },
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
        });
        for (const retained of [true, false]) {
          let launched = false;
          const stack = yield* makeHandle(
            stackId,
            {},
            {
              resolveOwner: (launch) =>
                Effect.sync(() => {
                  if (launch) {
                    launched = true;
                    return Option.some(owner);
                  }
                  return retained && launched ? Option.some(owner) : Option.none();
                }),
              waitForRelease: () =>
                Effect.fail(
                  new StackOwnershipConflictError({
                    message: "Supervisor is still shutting down",
                  }),
                ),
            },
          );

          const prepared = yield* stack.prepare().pipe(Effect.exit);
          expect(Exit.isSuccess(prepared)).toBe(retained);
          if (Exit.isFailure(prepared)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(prepared.cause));
            expect(error).toBeInstanceOf(StackOwnershipConflictError);
            expect(error?.message).toBe("Supervisor is still shutting down");
          }
          yield* stack.close();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("does not change crashed running intent while preparing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const state = yield* store.read(stack.id);
        if (state === undefined) return yield* Effect.die("stack state was not initialized");
        yield* store.replace(stack.id, { ...state, desiredLifecycle: "running" });

        const prepared = yield* stack.prepare().pipe(Effect.exit);

        expect(Exit.isFailure(prepared)).toBe(true);
        if (Exit.isFailure(prepared)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(prepared.cause));
          expect(error).toBeInstanceOf(StackOwnershipConflictError);
        }
        expect((yield* store.read(stack.id))?.desiredLifecycle).toBe("running");
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        yield* stack.close();
      }),
    ),
  );

  it("does not publish the internal handle through the Effect barrel", () => {
    expect(Object.hasOwn(effectApi, "makeHandle")).toBe(false);
  });

  it.live("omits undefined optional RPC payload keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-rpc-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "session";
        const payloads: {
          prepare: Array<unknown>;
          start: Array<unknown>;
          restart: Array<unknown>;
        } = {
          prepare: [],
          start: [],
          restart: [],
        };
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          prepare: (payload) => {
            payloads.prepare.push(payload);
            return Effect.succeed({ capabilities: [] });
          },
          start: (payload) => {
            payloads.start.push(payload);
            return Effect.succeed(runningStatus);
          },
          restart: (payload) => {
            payloads.restart.push(payload);
            return Effect.succeed(runningStatus);
          },
          destroy: () => Effect.void,
          logs: () => Stream.empty,
          watchStatus: () => Stream.empty,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers,
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            } as const),
            stop: Effect.succeed({ ok: true, op: "stop" } as const),
          },
        });
        const stack = yield* makeHandle(stackId, {
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        });
        yield* stack.prepare();
        yield* stack.start();
        yield* stack.restart();
        yield* stack.prepare({ config: {} });
        yield* stack.start({ config: {} });
        yield* stack.restart({ config: {} });
        expect(payloads.prepare).toEqual([{}, { config: {} }]);
        expect(payloads.start).toEqual([{}, { config: {} }]);
        expect(payloads.restart).toEqual([{}, { config: {} }]);
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("launches a compatible Supervisor when restart finds no live owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-restart-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "restart-session";
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            prepare: () => Effect.succeed({ capabilities: [] }),
            start: () => Effect.succeed(runningStatus),
            restart: () => Effect.succeed(runningStatus),
            destroy: () => Effect.void,
            logs: () => Stream.empty,
            watchStatus: () => Stream.empty,
          },
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
        });
        let launched = false;
        const stack = yield* makeHandle(
          stackId,
          {},
          {
            resolveOwner: (launch) =>
              Effect.sync(() => {
                launched ||= launch;
                return launched ? Option.some(owner) : Option.none();
              }),
          },
        );
        expect((yield* stack.restart()).lifecycle).toBe("running");
        expect(launched).toBe(true);
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("completes destroy after the owner closes its control socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "session";
        const responseSent = yield* Deferred.make<void>();
        const ownerScope = yield* Scope.make();
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          prepare: () => Effect.succeed({ capabilities: [] }),
          start: () => Effect.succeed(runningStatus),
          restart: () => Effect.succeed(runningStatus),
          destroy: () => Effect.void,
          logs: () => Stream.empty,
          watchStatus: () => Stream.concat(Stream.make(runningStatus), Stream.never),
        };
        const maintenanceHandlers = {
          probe: Effect.succeed({
            ok: true,
            op: "probe",
            stackId,
            ownerSessionId,
            rpcRelease: STACK_RPC_RELEASE,
          } as const),
          stop: Effect.succeed({ ok: true, op: "stop" } as const),
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers,
          maintenanceHandlers,
          onShutdownReady: Deferred.succeed(responseSent, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeHandle(stackId, {
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        });
        const destroyFiber = yield* Effect.forkChild(stack.destroy(), { startImmediately: true });
        yield* Deferred.await(responseSent);
        yield* Scope.close(ownerScope, Exit.void);
        const destroyed = yield* Fiber.join(destroyFiber).pipe(Effect.exit);
        expect(Exit.isSuccess(destroyed)).toBe(true);
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("continues an explicit replacement after the restart waiter is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const endpoint = { kind: "unix" as const, path: "/tmp/unreachable-replacement.sock" };
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId: "replacement-owner",
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeHandle(stackId, owner, {
          replacement: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              yield* Deferred.succeed(completed, undefined);
              return runningStatus;
            }),
        });
        const first = yield* Effect.forkChild(stack.restart(), { startImmediately: true });
        yield* Deferred.await(started);
        const concurrent = yield* stack.restart().pipe(Effect.exit);
        expect(Exit.isFailure(concurrent)).toBe(true);
        if (Exit.isFailure(concurrent)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(concurrent.cause));
          expect(error).toBeInstanceOf(StackLifecycleConflictError);
        }
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(completed);
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("fails destroy when the owner control endpoint is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const stack = yield* makeHandle(stackId, {
          endpoint: { kind: "unix", path: path.join(root, "missing.sock") },
          ownerSessionId: "session",
          rpcRelease: STACK_RPC_RELEASE,
        });
        const result = yield* stack.destroy().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackDestructionError);
            expect(error.value.message).toContain("control connection");
          }
        }
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live(
    "replaces an incompatible owner only through explicit restart",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const env = yield* StackRuntimeEnvironment;
          const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const identity = yield* resolveStackIdentity({ projectRoot: project });
          const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
          yield* ensureSupervisor({
            identity,
            stackId: stack.id,
            stateStore: store,
            environment: env,
          });
          const owner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
          expect(owner).toBeDefined();
          if (owner === undefined) return;
          const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
          const incompatibleOwner = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            ...owner,
            rpcRelease: "stack-rpc-v0@0.0.1",
          }).pipe(
            Effect.mapError(
              (cause) =>
                new StackDestructionError({ message: "Unable to encode test owner", cause }),
            ),
          );
          yield* fs.writeFileString(paths.controlMetadata, incompatibleOwner);

          const oldOwner = yield* openStack(stack.id);
          expect(Exit.isFailure(yield* oldOwner.status().pipe(Effect.exit))).toBe(true);
          yield* oldOwner.close();
          const ordinaryCreate = yield* createStack({ projectRoot: project });
          expect(ordinaryCreate.id).toBe(stack.id);
          yield* ordinaryCreate.close();
          const restarted = yield* openStack(stack.id, { replaceIncompatibleOwner: true });
          yield* Effect.addFinalizer(() => restarted.destroy().pipe(Effect.ignore));
          const status = yield* restarted.restart({ config: { capabilities: {} } });
          const currentOwner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
          expect(currentOwner?.rpcRelease).toBe(STACK_RPC_RELEASE);
          expect(currentOwner?.ownerSessionId).not.toBe(owner.ownerSessionId);
          expect(status.id).toBe(stack.id);
          expect(status.runtime).toEqual({ kind: "native" });
          expect((yield* restarted.status()).lifecycle).toBe("running");
          const observed = yield* restarted.watchStatus().pipe(Stream.runHead);
          expect(Option.isSome(observed)).toBe(true);
          if (Option.isSome(observed)) expect(observed.value.lifecycle).toBe("running");
          const secondStatus = yield* restarted.restart({ config: { capabilities: {} } });
          expect(secondStatus.lifecycle).toBe("running");
          yield* restarted.stop();
          expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
          expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(false);
          const startedAgain = yield* restarted.start({ config: { capabilities: {} } });
          expect(startedAgain.lifecycle).toBe("running");
          yield* restarted.destroy();
          yield* restarted.close();
          yield* stack.close();
        }),
      ),
    240_000,
  );

  it.live(
    "reclaims a dead incompatible owner through create and explicit replacement",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const env = yield* StackRuntimeEnvironment;
          const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
          const makeDeadOwner = (projectRoot: string, rpcRelease: string) =>
            Effect.gen(function* () {
              const identity = yield* resolveStackIdentity({ projectRoot });
              const id = yield* deriveStackId(identity);
              yield* store.initialize(id, {
                format: "supabase-stack-state-v1",
                identity: toPersistedIdentity(identity, id),
                runtime: { kind: "native" },
                desiredLifecycle: "unconfigured",
                ports: [],
                privatePorts: [],
                secrets: {},
              });
              const encodedEnvironment = yield* Schema.encodeEffect(
                Schema.fromJsonString(Schema.Unknown),
              )({
                stateRoot: env.stateRoot,
                tempRoot: env.tempRoot,
                platform: env.platform,
              });
              const child = yield* ChildProcess.make(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `
                  const { Effect } = await import("effect");
                  const { NodeServices } = await import("@effect/platform-node");
                  const { acquireOwnership, publishOwnership } = await import(process.env.OWNERSHIP_MODULE);
                  const environment = JSON.parse(process.env.OWNERSHIP_ENVIRONMENT);
                  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
                    const lease = yield* acquireOwnership({
                      stateRoot: environment.stateRoot,
                      stackId: process.env.OWNERSHIP_STACK_ID,
                      ownerSessionId: "crashed-owner",
                      rpcRelease: process.env.OWNERSHIP_RPC_RELEASE,
                      environment,
                    });
                    yield* publishOwnership(lease);
                    process.stdout.write("READY\\n");
                    yield* Effect.never;
                  }).pipe(Effect.provide(NodeServices.layer))));
                `,
                ],
                {
                  cwd: process.cwd(),
                  env: {
                    OWNERSHIP_MODULE: new URL("../state/Ownership.ts", import.meta.url).href,
                    OWNERSHIP_STACK_ID: id,
                    OWNERSHIP_RPC_RELEASE: rpcRelease,
                    OWNERSHIP_ENVIRONMENT: encodedEnvironment,
                  },
                  extendEnv: true,
                  stdout: "pipe",
                  stderr: "pipe",
                },
              );
              const ready = yield* Deferred.make<void>();
              const output = yield* child.stdout.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runForEach((line) =>
                  line === "READY"
                    ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkChild({ startImmediately: true }),
              );
              const stderr = yield* child.stderr.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runDrain,
                Effect.forkChild({ startImmediately: true }),
              );
              try {
                yield* Deferred.await(ready).pipe(
                  Effect.timeoutOrElse({
                    duration: "5 seconds",
                    orElse: () =>
                      Effect.fail(new StackStateInvalidError({ message: "owner child not ready" })),
                  }),
                );
                expect(yield* ownerLockExists(env.stateRoot, id)).toBe(true);
                yield* child.kill({ killSignal: "SIGKILL" });
                yield* child.exitCode.pipe(Effect.ignore);
                return id;
              } finally {
                yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
                yield* Fiber.interrupt(output);
                yield* Fiber.interrupt(stderr);
              }
            });

          const createProject = path.join(project, "create");
          const openProject = path.join(project, "open");
          yield* fs.makeDirectory(createProject);
          yield* fs.makeDirectory(openProject);
          const createId = yield* makeDeadOwner(createProject, "stack-rpc-v0@0.0.1");
          const created = yield* createStack({ projectRoot: createProject });
          yield* Effect.addFinalizer(() => created.destroy().pipe(Effect.ignore));
          expect(created.id).toBe(createId);
          // Creating a handle is intentionally lightweight; prepare probes the
          // stale owner, reclaims it, and cleans up its temporary Supervisor.
          yield* created.prepare({
            capabilities: [],
            config: { listeners: { api: { enabled: false } } },
          });
          expect(yield* readOwnerMetadata(env.stateRoot, createId, env)).toBeUndefined();
          expect(yield* ownerLockExists(env.stateRoot, createId)).toBe(false);
          yield* created.close();

          const openId = yield* makeDeadOwner(openProject, "stack-rpc-v0@0.0.1");
          const replaced = yield* openStack(openId, { replaceIncompatibleOwner: true });
          yield* Effect.addFinalizer(() => replaced.destroy().pipe(Effect.ignore));
          yield* replaced.restart({ config: { capabilities: {} } });
          expect((yield* readOwnerMetadata(env.stateRoot, openId, env))?.rpcRelease).toBe(
            STACK_RPC_RELEASE,
          );
          yield* replaced.destroy();
          yield* replaced.close();
        }),
      ),
    300_000,
  );

  it.live("accepts maintenance stop requests from an older RPC owner", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        yield* ensureSupervisor({
          identity,
          stackId: stack.id,
          stateStore: store,
          environment: env,
        });
        const owner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
        expect(owner).toBeDefined();
        if (owner === undefined) return;
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const incompatibleOwner = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          {
            ...owner,
            rpcRelease: "stack-rpc-v0@0.0.1",
          },
        ).pipe(
          Effect.mapError(
            (cause) => new StackDestructionError({ message: "Unable to encode test owner", cause }),
          ),
        );
        yield* fs.writeFileString(paths.controlMetadata, incompatibleOwner);
        const oldOwnerHandle = yield* openStack(stack.id);
        yield* oldOwnerHandle.stop();
        yield* oldOwnerHandle.close();
        yield* stack.close();
      }),
    ),
  );
});
