import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Queue,
  Redacted,
  Ref,
  Scheduler,
  Scope,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/unstable/http";
import { Rpc } from "effect/unstable/rpc";
import { RequestId } from "effect/unstable/rpc/RpcMessage";
import type { LogQuery, StackLogEntry } from "../public/Logs.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { ArtifactPreparationStatus, StackStatus } from "../public/Status.ts";
import {
  GatewayActivationError,
  InvalidLogCursorError,
  PortUnavailableError,
  StackLifecycleConflictError,
  StackNotRunningError,
  StackRuntimeError,
  StackCleanupError,
  StackStateInvalidError,
  StackMustBeStoppedError,
  StackVersionUnsupportedError,
  ArtifactIntegrityError,
  ContainerEngineError,
} from "../public/Errors.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type ObservedWorkload,
} from "../runtime/RuntimeDriver.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { StackRpcGroup, type StackRpcError } from "../control/StackRpc.ts";
import { makeSupervisor, type Supervisor, type SupervisorRuntime } from "./Supervisor.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import type { GatewayActivity } from "../gateway/ActivityTracker.ts";

const identity = {
  projectRoot: "/tmp/supabase-supervisor",
  branchContext: "ordinary-workspace",
  stackName: "supervisor",
} as const;

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const invokeCredentials = (
  supervisor: Supervisor,
): Effect.Effect<EffectStackCredentials, StackRpcError, Scope.Scope> =>
  Effect.gen(function* () {
    const handler = yield* StackRpcGroup.accessHandler("credentials").pipe(
      Effect.provide(
        StackRpcGroup.toLayerHandler("credentials", supervisor.rpcHandlers.credentials),
      ),
    );
    const value = yield* handler(undefined, {
      client: new Rpc.ServerClient(1),
      requestId: RequestId(1),
      headers: Headers.empty,
    });
    if (Deferred.isDeferred<EffectStackCredentials, StackRpcError>(value))
      return yield* Deferred.await(value);
    return value;
  });

type ReadGate = {
  readonly started: Deferred.Deferred<void>;
  readonly gate: Deferred.Deferred<void>;
};

const makeFixture = (
  fixtureOptions: {
    readonly ingress?: SupervisorIngress;
    readonly timeline?: Ref.Ref<ReadonlyArray<string>>;
    readonly logRecords?: Ref.Ref<ReadonlyArray<string>>;
    readonly logWritten?: Deferred.Deferred<void>;
    readonly logWrittenFor?: string;
    readonly logWrittenAdditional?: Deferred.Deferred<void>;
    readonly logWrittenAdditionalFor?: string;
    readonly logQueue?: Queue.Queue<string>;
    readonly runtime?: StackRuntime;
    readonly supervisorScope?: Scope.Scope;
    readonly startGate?: Deferred.Deferred<void>;
    readonly startStarted?: Deferred.Deferred<void>;
    readonly startWorkload?: string;
    readonly startFinished?: Deferred.Deferred<void>;
    readonly activationGate?: Deferred.Deferred<void>;
    readonly activationGateAfterFirst?: Deferred.Deferred<void>;
    readonly activationStarted?: Deferred.Deferred<void>;
    readonly activationStartedAfterFirst?: Deferred.Deferred<void>;
    readonly activationCalls?: Ref.Ref<number>;
    readonly activationFailFirst?: Ref.Ref<boolean>;
    readonly startFailures?: Ref.Ref<number>;
    readonly startFailureWorkload?: string;
    readonly preflightFailFirst?: Ref.Ref<boolean>;
    readonly preflightCalls?: Ref.Ref<number>;
    readonly preflightGate?: Deferred.Deferred<void>;
    readonly preflightStarted?: Deferred.Deferred<void>;
    readonly stopGate?: Deferred.Deferred<void>;
    readonly stopStarted?: Deferred.Deferred<void>;
    readonly workloadStopFailFirst?: Ref.Ref<boolean>;
    readonly workloadStopGate?: Deferred.Deferred<void>;
    readonly workloadStopStarted?: Deferred.Deferred<void>;
    readonly workloadRemoveFailFirst?: Ref.Ref<boolean>;
    readonly workloadRemoveFailWorkload?: string;
    readonly workloadRemoveDieFirst?: Ref.Ref<boolean>;
    readonly stopFailFirst?: Ref.Ref<boolean>;
    readonly destroyGate?: Deferred.Deferred<void>;
    readonly destroyStarted?: Deferred.Deferred<void>;
    readonly destroyPreFenceFail?: Ref.Ref<boolean>;
    readonly observeFailure?: Ref.Ref<boolean>;
    readonly stoppedReplaceFail?: Ref.Ref<boolean>;
    readonly startQueue?: Queue.Queue<string>;
    readonly shutdownReadArmed?: Ref.Ref<boolean>;
    readonly shutdownReadStarted?: Deferred.Deferred<void>;
    readonly shutdownReadGate?: Deferred.Deferred<void>;
    readonly readGateQueue?: Ref.Ref<ReadonlyArray<ReadGate>>;
    readonly readCalls?: Ref.Ref<number>;
    readonly prefetchStarted?: Deferred.Deferred<void>;
    readonly prefetchFinished?: Deferred.Deferred<void>;
    readonly prefetchGate?: Deferred.Deferred<void>;
    readonly prefetchInterrupted?: Deferred.Deferred<void>;
    readonly prefetchCalls?: Ref.Ref<number>;
    readonly prepareStarted?: Deferred.Deferred<void>;
    readonly prepareActivationStarted?: Deferred.Deferred<void>;
    readonly prepareGate?: Deferred.Deferred<void>;
    readonly prepareGateEnabledRef?: Ref.Ref<boolean>;
    readonly prepareFailure?: boolean;
    readonly prepareFailureRef?: Ref.Ref<boolean>;
    readonly artifactStatuses?: Ref.Ref<ReadonlyArray<ArtifactPreparationStatus>>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-supervisor-" });
    const id = yield* deriveStackId(identity);
    const baseStore = yield* makeStackStateStore({ stateRoot: root });
    const destroyPreFenceFail = fixtureOptions.destroyPreFenceFail;
    const stoppedReplaceFail = fixtureOptions.stoppedReplaceFail;
    const persistedStore =
      destroyPreFenceFail === undefined && stoppedReplaceFail === undefined
        ? baseStore
        : {
            ...baseStore,
            replace: (stackId: string, state: Parameters<typeof baseStore.replace>[1]) =>
              Effect.gen(function* () {
                if (state.desiredLifecycle === "destroying" && destroyPreFenceFail !== undefined) {
                  const fail = yield* Ref.get(destroyPreFenceFail);
                  if (fail) {
                    yield* Ref.set(destroyPreFenceFail, false);
                    return yield* new StackStateInvalidError({
                      message: "injected destroy fence failure",
                    });
                  }
                }
                if (state.desiredLifecycle === "stopped" && stoppedReplaceFail !== undefined) {
                  const fail = yield* Ref.get(stoppedReplaceFail);
                  if (fail) {
                    yield* Ref.set(stoppedReplaceFail, false);
                    return yield* new StackStateInvalidError({
                      message: "injected stopped-state persistence failure",
                    });
                  }
                }
                return yield* baseStore.replace(stackId, state);
              }),
          };
    const runtimeStore =
      fixtureOptions.readGateQueue !== undefined
        ? {
            ...persistedStore,
            read: (stackId: string) =>
              Effect.gen(function* () {
                const state = yield* persistedStore.read(stackId);
                const gate = yield* Ref.modify(fixtureOptions.readGateQueue!, (gates) => [
                  gates[0],
                  gates.slice(1),
                ]);
                if (gate !== undefined) {
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.gate);
                }
                return state;
              }),
          }
        : fixtureOptions.shutdownReadArmed === undefined ||
            fixtureOptions.shutdownReadStarted === undefined ||
            fixtureOptions.shutdownReadGate === undefined
          ? persistedStore
          : {
              ...persistedStore,
              read: (stackId: string) =>
                Effect.gen(function* () {
                  const armed = yield* Ref.modify(fixtureOptions.shutdownReadArmed!, (value) => [
                    value,
                    false,
                  ]);
                  if (armed) {
                    yield* Deferred.succeed(fixtureOptions.shutdownReadStarted!, undefined);
                    yield* Deferred.await(fixtureOptions.shutdownReadGate!);
                  }
                  return yield* persistedStore.read(stackId);
                }),
            };
    const store =
      fixtureOptions.readCalls === undefined
        ? runtimeStore
        : {
            ...runtimeStore,
            read: (stackId: string) =>
              Ref.update(fixtureOptions.readCalls!, (count) => count + 1).pipe(
                Effect.andThen(runtimeStore.read(stackId)),
              ),
          };
    yield* store.initialize(id, {
      format: "supabase-stack-state-v1",
      identity,
      runtime: fixtureOptions.runtime ?? { kind: "native" },
      desiredLifecycle: "unconfigured",
      ports: [],
      privatePorts: [],
      secrets: {},
    });
    const resources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const logOptions = yield* Ref.make<ReadonlyArray<LogQuery | undefined>>([]);
    const entry: StackLogEntry = {
      cursor: { opaque: "v1_1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "auth",
      stream: "internal",
      message: "hello",
    };
    const finalEntry: StackLogEntry = {
      ...entry,
      cursor: { opaque: "v1_2" },
      timestamp: "2026-01-01T00:00:01.000Z",
      message: "stopped",
    };
    const logEntries = yield* Ref.make<ReadonlyArray<StackLogEntry>>([entry]);
    const failDestroy = yield* Ref.make(false);
    let gateStopCleanup = false;
    const driver: RuntimeDriver = {
      observe: () =>
        Effect.gen(function* () {
          if (
            fixtureOptions.observeFailure !== undefined &&
            (yield* Ref.get(fixtureOptions.observeFailure))
          )
            return yield* new RuntimeDriverError({
              cause: new ContainerEngineError({
                engine: "docker",
                message: "injected observe failure",
              }),
              message: "injected observe failure",
            });
          return yield* Ref.get(resources);
        }),
      start: (key, workload: PlannedWorkload) =>
        Effect.gen(function* () {
          gateStopCleanup = true;
          if (fixtureOptions.timeline !== undefined)
            yield* Ref.update(fixtureOptions.timeline, (current) => [
              ...current,
              `start:${workload.id}`,
            ]);
          yield* Ref.update(calls, (current) => [...current, `start:${workload.id}`]);
          if (
            fixtureOptions.startStarted !== undefined &&
            (fixtureOptions.startWorkload === undefined ||
              fixtureOptions.startWorkload === workload.id)
          )
            yield* Deferred.succeed(fixtureOptions.startStarted, undefined);
          if (
            fixtureOptions.startGate !== undefined &&
            (fixtureOptions.startWorkload === undefined ||
              fixtureOptions.startWorkload === workload.id)
          )
            yield* Deferred.await(fixtureOptions.startGate);
          if (
            fixtureOptions.startFailures !== undefined &&
            key.workloadId === (fixtureOptions.startFailureWorkload ?? "functions:edge-runtime")
          ) {
            const remaining = yield* Ref.get(fixtureOptions.startFailures);
            if (remaining > 0) {
              yield* Ref.set(fixtureOptions.startFailures, remaining - 1);
              if (fixtureOptions.stopFailFirst !== undefined)
                yield* Ref.set(fixtureOptions.stopFailFirst, true);
              const failed = { ...key, state: "failed" as const, error: "injected start failure" };
              yield* Ref.update(resources, (current) => [
                ...current.filter((entry) => entry.workloadId !== key.workloadId),
                failed,
              ]);
              return yield* new RuntimeDriverError({
                message: "injected start failure",
                stackId: key.stackId,
                workloadId: key.workloadId,
              });
            }
          }
          const ready = { ...key, state: "ready" as const };
          yield* Ref.update(resources, (current) => [
            ...current.filter((entry) => entry.workloadId !== key.workloadId),
            ready,
          ]);
          if (
            fixtureOptions.startFinished !== undefined &&
            workload.id === (fixtureOptions.startWorkload ?? "rest:rest")
          )
            yield* Deferred.succeed(fixtureOptions.startFinished, undefined);
          if (fixtureOptions.startQueue !== undefined)
            yield* Queue.offer(fixtureOptions.startQueue, workload.id);
          return ready;
        }),
      stop: (key) =>
        Effect.gen(function* () {
          if (fixtureOptions.workloadStopStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.workloadStopStarted, undefined);
          if (fixtureOptions.workloadStopGate !== undefined)
            yield* Deferred.await(fixtureOptions.workloadStopGate);
          if (fixtureOptions.workloadStopFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.workloadStopFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.workloadStopFailFirst, false);
              return yield* new RuntimeDriverError({
                message: "injected workload stop failure",
                stackId: key.stackId,
                workloadId: key.workloadId,
              });
            }
          }
          if (fixtureOptions.timeline !== undefined)
            yield* Ref.update(fixtureOptions.timeline, (current) => [
              ...current,
              `stop:${key.workloadId}`,
            ]);
          yield* Ref.update(resources, (current) =>
            current.map((entry) =>
              entry.workloadId === key.workloadId ? { ...entry, state: "stopped" as const } : entry,
            ),
          );
        }),
      remove: (key) =>
        Effect.gen(function* () {
          if (
            fixtureOptions.workloadRemoveFailFirst !== undefined &&
            (fixtureOptions.workloadRemoveFailWorkload === undefined ||
              fixtureOptions.workloadRemoveFailWorkload === key.workloadId)
          ) {
            const fail = yield* Ref.get(fixtureOptions.workloadRemoveFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.workloadRemoveFailFirst, false);
              return yield* new RuntimeDriverError({
                message: "injected workload remove failure",
                stackId: key.stackId,
                workloadId: key.workloadId,
              });
            }
          }
          if (fixtureOptions.workloadRemoveDieFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.workloadRemoveDieFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.workloadRemoveDieFirst, false);
              return yield* Effect.die("injected workload remove defect");
            }
          }
          yield* Ref.update(resources, (current) =>
            current.filter((entry) => entry.workloadId !== key.workloadId),
          );
        }),
      cleanup: ({ destroy }) =>
        Effect.gen(function* () {
          if (destroy && (yield* Ref.get(failDestroy)))
            return yield* new RuntimeDriverError({ message: "destroy failed" });
          if (!destroy && fixtureOptions.stopFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.stopFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.stopFailFirst, false);
              return yield* new RuntimeDriverError({ message: "injected stop cleanup failure" });
            }
          }
          if (fixtureOptions.timeline !== undefined)
            yield* Ref.update(fixtureOptions.timeline, (current) => [
              ...current,
              `cleanup:${destroy ? "destroy" : "stop"}`,
            ]);
          yield* Ref.update(calls, (current) => [
            ...current,
            `cleanup:${destroy ? "destroy" : "stop"}`,
          ]);
          if (destroy && fixtureOptions.destroyStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.destroyStarted, undefined);
          if (destroy && fixtureOptions.destroyGate !== undefined)
            yield* Deferred.await(fixtureOptions.destroyGate);
          if (!destroy && gateStopCleanup && fixtureOptions.stopStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.stopStarted, undefined);
          if (!destroy && gateStopCleanup && fixtureOptions.stopGate !== undefined)
            yield* Deferred.await(fixtureOptions.stopGate);
          yield* Ref.set(resources, []);
          if (!destroy && gateStopCleanup)
            yield* Ref.update(logEntries, (current) => [...current, finalEntry]);
        }),
    };
    const runtime: SupervisorRuntime = {
      driver,
      preflight: (_input) =>
        Effect.gen(function* () {
          if (fixtureOptions.preflightCalls !== undefined)
            yield* Ref.update(fixtureOptions.preflightCalls, (count) => count + 1);
          if (fixtureOptions.preflightStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.preflightStarted, undefined);
          if (fixtureOptions.preflightGate !== undefined)
            yield* Deferred.await(fixtureOptions.preflightGate);
          if (fixtureOptions.preflightFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.preflightFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.preflightFailFirst, false);
              return yield* new StackRuntimeError({ message: "injected preflight failure" });
            }
          }
        }),
      prepare: () =>
        fixtureOptions.prepareStarted === undefined && fixtureOptions.prepareGate === undefined
          ? Effect.void
          : Effect.gen(function* () {
              if (fixtureOptions.prepareStarted !== undefined)
                yield* Deferred.succeed(fixtureOptions.prepareStarted, undefined);
              if (
                fixtureOptions.prepareActivationStarted !== undefined &&
                fixtureOptions.prepareGateEnabledRef !== undefined &&
                (yield* Ref.get(fixtureOptions.prepareGateEnabledRef))
              )
                yield* Deferred.succeed(fixtureOptions.prepareActivationStarted, undefined);
              if (
                fixtureOptions.prepareGate !== undefined &&
                (fixtureOptions.prepareGateEnabledRef === undefined ||
                  (yield* Ref.get(fixtureOptions.prepareGateEnabledRef)))
              )
                yield* Deferred.await(fixtureOptions.prepareGate);
              if (
                fixtureOptions.prepareFailure === true ||
                (fixtureOptions.prepareFailureRef !== undefined &&
                  (yield* Ref.get(fixtureOptions.prepareFailureRef)))
              )
                return yield* new StackRuntimeError({ message: "injected preparation failure" });
            }),
      prefetch: (state) => {
        if (state.definition?.preparation === "on-demand") return Effect.void;
        return Effect.gen(function* () {
          if (fixtureOptions.prefetchCalls !== undefined)
            yield* Ref.update(fixtureOptions.prefetchCalls, (count) => count + 1);
          if (fixtureOptions.artifactStatuses !== undefined)
            yield* Ref.set(fixtureOptions.artifactStatuses, [
              { workloadId: "rest:rest", capability: "rest", state: "downloading" },
            ]);
          if (fixtureOptions.prefetchStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.prefetchStarted, undefined);
          if (fixtureOptions.prefetchGate !== undefined)
            yield* Deferred.await(fixtureOptions.prefetchGate);
          if (fixtureOptions.artifactStatuses !== undefined)
            yield* Ref.set(fixtureOptions.artifactStatuses, [
              { workloadId: "rest:rest", capability: "rest", state: "ready" },
            ]);
          if (fixtureOptions.prefetchFinished !== undefined)
            yield* Deferred.succeed(fixtureOptions.prefetchFinished, undefined);
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (fixtureOptions.artifactStatuses !== undefined)
                yield* Ref.set(fixtureOptions.artifactStatuses, []);
              if (fixtureOptions.prefetchInterrupted !== undefined)
                yield* Deferred.succeed(fixtureOptions.prefetchInterrupted, undefined);
            }),
          ),
        );
      },
      artifacts:
        fixtureOptions.artifactStatuses === undefined
          ? Effect.succeed([])
          : Ref.get(fixtureOptions.artifactStatuses),
      activate: () =>
        Effect.gen(function* () {
          const callNumber =
            fixtureOptions.activationCalls === undefined
              ? undefined
              : yield* Ref.updateAndGet(fixtureOptions.activationCalls, (count) => count + 1);
          if (fixtureOptions.activationStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.activationStarted, undefined);
          if (fixtureOptions.activationGateAfterFirst !== undefined && callNumber !== 1) {
            if (fixtureOptions.activationStartedAfterFirst !== undefined)
              yield* Deferred.succeed(fixtureOptions.activationStartedAfterFirst, undefined);
            yield* Deferred.await(fixtureOptions.activationGateAfterFirst);
          } else if (fixtureOptions.activationGate !== undefined)
            yield* Deferred.await(fixtureOptions.activationGate);
          if (fixtureOptions.activationFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.activationFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.activationFailFirst, false);
              return yield* new GatewayActivationError({ message: "injected activation failure" });
            }
          }
          return { host: "127.0.0.1", port: 9999 };
        }),
      ingress: fixtureOptions.ingress ?? {
        acquire: () =>
          Effect.succeed({
            assignments: {},
            privateAssignments: [],
            hostListeners: [],
            fresh: false,
            ownershipToken: Symbol(),
          }),
        open: () => Effect.void,
        close: Effect.void,
      },
      logStore: {
        path: "memory://logs",
        append: (record) =>
          (fixtureOptions.logRecords === undefined
            ? Effect.void
            : Ref.update(fixtureOptions.logRecords, (current) => [...current, record.message])
          ).pipe(
            Effect.andThen(
              fixtureOptions.logQueue === undefined
                ? Effect.void
                : Queue.offer(fixtureOptions.logQueue, record.message),
            ),
            Effect.andThen(
              fixtureOptions.logWritten === undefined ||
                (fixtureOptions.logWrittenFor !== undefined &&
                  !record.message.includes(fixtureOptions.logWrittenFor))
                ? Effect.void
                : Deferred.succeed(fixtureOptions.logWritten, undefined),
            ),
            Effect.andThen(
              fixtureOptions.logWrittenAdditional === undefined ||
                (fixtureOptions.logWrittenAdditionalFor !== undefined &&
                  !record.message.includes(fixtureOptions.logWrittenAdditionalFor))
                ? Effect.void
                : Deferred.succeed(fixtureOptions.logWrittenAdditional, undefined),
            ),
            Effect.andThen(
              Effect.succeed({
                ...entry,
                source: record.source,
                stream: record.stream,
                message: record.message,
              }),
            ),
          ),
        read: (options) =>
          options?.cursor?.opaque === "not-a-cursor"
            ? Effect.fail(new InvalidLogCursorError({ message: "Log cursor is invalid" }))
            : Ref.update(logOptions, (current) => [...current, options]).pipe(
                Effect.andThen(Ref.get(logEntries)),
              ),
      },
    };
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | import("effect").Crypto.Crypto
    >();
    const supervisorEffect = makeSupervisor({
      stackId: id,
      ownerSessionId: "owner-session",
      stateStore: store,
      context,
      runtime,
    });
    const supervisor =
      fixtureOptions.supervisorScope === undefined
        ? yield* supervisorEffect
        : yield* supervisorEffect.pipe(
            Effect.provideService(Scope.Scope, fixtureOptions.supervisorScope),
          );
    yield* Ref.set(calls, []);
    return {
      supervisor,
      calls,
      logOptions,
      failDestroy,
      context,
      store,
      id,
      runtime,
      resources,
      root,
    };
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const makeCredentialsFixture = ({ authEnabled = true }: { readonly authEnabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    yield* fixture.supervisor.start({
      config: { capabilities: { rest: {}, auth: { enabled: authEnabled } } },
    });
    const running = yield* fixture.store
      .read(fixture.id)
      .pipe(Effect.provideContext(fixture.context));
    if (running === undefined)
      return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
    if (running.definition === undefined)
      return yield* new StackStateInvalidError({ message: "running definition is missing" });
    const state = {
      ...running,
      ports: [
        { field: "api", port: 55433, intent: "exact" as const },
        { field: "database", port: 55432, intent: "exact" as const },
      ] as const,
    };
    yield* fixture.store.replace(fixture.id, state).pipe(Effect.provideContext(fixture.context));
    const baseSecrets = {
      ...state.secrets,
      "secret:auth.settings.publishable_key": {
        policy: "managed" as const,
        value: "publishable",
      },
      "secret:auth.settings.secret_key": { policy: "managed" as const, value: "secret" },
      "secret:auth.settings.anon_key": { policy: "managed" as const, value: "anon" },
      "secret:auth.settings.service_role_key": { policy: "managed" as const, value: "service" },
    };
    return { fixture, state, definition: running.definition, baseSecrets };
  });

describe("Supervisor composition", () => {
  it.live("rejects new work after owner shutdown begins", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.shutdownIfIdle;

        const start = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(start)).toBeInstanceOf(StackLifecycleConflictError);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("does not admit a lifecycle while idle shutdown makes its final decision", () =>
    run(
      Effect.gen(function* () {
        const readArmed = yield* Ref.make(false);
        const readStarted = yield* Deferred.make<void>();
        const readGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          shutdownReadArmed: readArmed,
          shutdownReadStarted: readStarted,
          shutdownReadGate: readGate,
        });
        yield* Ref.set(readArmed, true);
        const shutdown = yield* Effect.forkChild(fixture.supervisor.shutdownIfIdle);
        yield* Deferred.await(readStarted);
        const start = yield* Effect.forkChild(fixture.supervisor.start({ config: {} }));
        yield* Deferred.succeed(readGate, undefined);
        yield* Fiber.join(shutdown);
        expect(errorOf(yield* Fiber.join(start).pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
      }),
    ),
  );

  it.live("starts through the composed lifecycle and reports observed readiness", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        expect((yield* fixture.supervisor.status).lifecycle).toBe("unconfigured");
        const status = yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
      }),
    ),
  );

  it.live("publishes starting until an eager workload reaches readiness", () =>
    run(
      Effect.gen(function* () {
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ startStarted, startGate });
        const starting = yield* Effect.forkChild(
          fixture.supervisor.start({ config: { capabilities: { rest: { activation: "eager" } } } }),
          { startImmediately: true },
        );
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("starting");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("starting");
        yield* Deferred.succeed(startGate, undefined);
        const ready = yield* Fiber.join(starting);
        expect(ready.lifecycle).toBe("running");
        expect(ready.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
      }),
    ),
  );

  it.live("retires lazy traffic after its lease ends and reactivates on demand", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const activationStarted = yield* Deferred.make<void>();
        const logWritten = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          timeline,
          activationStarted,
          logWritten,
          logWrittenFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy", idleTimeoutSeconds: 1 },
              auth: { activation: "lazy" },
            },
          },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        const release = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          tracker.track(
            "rest",
            fixture.supervisor.activate("rest").pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(activationStarted);
        yield* TestClock.adjust("1 second");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(request);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(logWritten);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
        expect(yield* Ref.get(timeline)).toContain("stop:rest:rest");
        yield* fixture.supervisor.activate("rest");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("keeps a lazy dependency pinned until its dependent retires", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const activationStarted = yield* Deferred.make<void>();
        const logWritten = yield* Deferred.make<void>();
        const restLogWritten = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          timeline,
          activationStarted,
          logWritten,
          logWrittenFor: "Stopped studio after inactivity",
          logWrittenAdditional: restLogWritten,
          logWrittenAdditionalFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy", idleTimeoutSeconds: 1 },
              studio: { activation: "lazy", idleTimeoutSeconds: 1 },
            },
          },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        const release = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          tracker.track(
            "studio",
            fixture.supervisor.activate("studio").pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(activationStarted);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(request);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(logWritten);
        const afterStudio = yield* fixture.supervisor.status;
        expect(afterStudio.capabilities.find(({ name }) => name === "studio")?.state).toBe(
          "dormant",
        );
        expect(afterStudio.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(restLogWritten);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
        expect(yield* Ref.get(timeline)).toEqual(
          expect.arrayContaining(["stop:studio:pgmeta", "stop:rest:rest"]),
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("re-arms a dependency idle timer after a pinned dependent retires", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const restReady = yield* Deferred.make<void>();
        const studioReady = yield* Deferred.make<void>();
        const restStopped = yield* Deferred.make<void>();
        const studioStopped = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          timeline,
          logWritten: studioStopped,
          logWrittenFor: "Stopped studio after inactivity",
          logWrittenAdditional: restStopped,
          logWrittenAdditionalFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy", idleTimeoutSeconds: 1 },
              studio: { activation: "lazy", idleTimeoutSeconds: 1 },
            },
          },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");

        const releaseRest = yield* Deferred.make<void>();
        const restRequest = yield* Effect.forkChild(
          tracker.track(
            "rest",
            fixture.supervisor.activate("rest").pipe(
              Effect.tap(() => Deferred.succeed(restReady, undefined)),
              Effect.andThen(Deferred.await(releaseRest)),
            ),
          ),
        );
        yield* TestClock.withLive(Deferred.await(restReady).pipe(Effect.timeout("5 seconds")));
        yield* Deferred.succeed(releaseRest, undefined);
        yield* TestClock.withLive(Fiber.join(restRequest).pipe(Effect.timeout("5 seconds")));

        const releaseStudio = yield* Deferred.make<void>();
        const studioRequest = yield* Effect.forkChild(
          tracker.track(
            "studio",
            fixture.supervisor.activate("studio").pipe(
              Effect.tap(() => Deferred.succeed(studioReady, undefined)),
              Effect.andThen(Deferred.await(releaseStudio)),
            ),
          ),
        );
        yield* TestClock.withLive(Deferred.await(studioReady).pipe(Effect.timeout("5 seconds")));
        yield* TestClock.adjust("1 second");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
        yield* Deferred.succeed(releaseStudio, undefined);
        yield* TestClock.withLive(Fiber.join(studioRequest).pipe(Effect.timeout("5 seconds")));
        yield* TestClock.adjust("1 second");
        yield* TestClock.withLive(Deferred.await(studioStopped).pipe(Effect.timeout("5 seconds")));
        yield* TestClock.adjust("1 second");
        yield* TestClock.withLive(Deferred.await(restStopped).pipe(Effect.timeout("5 seconds")));
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
        expect(yield* Ref.get(timeline)).toEqual(
          expect.arrayContaining(["stop:studio:pgmeta", "stop:rest:rest"]),
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("retires an unresolved dependency after its cancelled lookup waiter finishes", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const lookupStarted = yield* Deferred.make<void>();
        const lookupStartedAfterFirst = yield* Deferred.make<void>();
        const lookupGate = yield* Deferred.make<void>();
        const activationCalls = yield* Ref.make(0);
        const studioStopped = yield* Deferred.make<void>();
        const restStopped = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          activationGateAfterFirst: lookupGate,
          activationStarted: lookupStarted,
          activationStartedAfterFirst: lookupStartedAfterFirst,
          activationCalls,
          logWritten: studioStopped,
          logWrittenFor: "Stopped studio after inactivity",
          logWrittenAdditional: restStopped,
          logWrittenAdditionalFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy", idleTimeoutSeconds: 1 },
              studio: { activation: "lazy", idleTimeoutSeconds: 1 },
            },
          },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");

        yield* tracker.track("studio", fixture.supervisor.activate("studio"));
        yield* TestClock.adjust("1 second");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "studio")
            ?.state,
        ).toBe("dormant");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");

        const cancelled = yield* Effect.forkChild(
          tracker.track("rest", fixture.supervisor.activate("rest")),
        );
        yield* TestClock.withLive(
          Deferred.await(lookupStartedAfterFirst).pipe(Effect.timeout("5 seconds")),
        );
        yield* Fiber.interrupt(cancelled);
        const owner = yield* Effect.forkChild(fixture.supervisor.activate("rest"));
        yield* Deferred.succeed(lookupGate, undefined);
        yield* TestClock.withLive(Fiber.join(owner).pipe(Effect.timeout("5 seconds")));
        yield* TestClock.adjust("1 second");
        yield* TestClock.withLive(Deferred.await(restStopped).pipe(Effect.timeout("5 seconds")));
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("joins concurrent activation while a lazy dependency is starting", () =>
    run(
      Effect.gen(function* () {
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          startStarted,
          startGate,
          startWorkload: "rest:rest",
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy" },
              studio: { activation: "lazy" },
            },
          },
        });
        const studio = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"));
        const rest = yield* Effect.forkChild(fixture.supervisor.activate("rest"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(startGate, undefined);
        yield* Fiber.join(rest).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.join(studio).pipe(Effect.timeout("5 seconds"));
        const status = yield* fixture.supervisor.status;
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        expect(status.capabilities.find(({ name }) => name === "studio")?.state).toBe("ready");
      }),
    ),
  );

  it.live(
    "propagates a recovered owner read failure instead of fabricating an empty running stack",
    () =>
      run(
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          yield* fixture.supervisor.start({ config: {} });
          const failRead = yield* Ref.make(false);
          const stateStore = {
            ...fixture.store,
            read: (stackId: string) =>
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(failRead, false))
                  return yield* new StackStateInvalidError({
                    message: "transient state read failure",
                  });
                return yield* fixture.store.read(stackId);
              }),
          };
          const successor = yield* makeSupervisor({
            stackId: fixture.id,
            ownerSessionId: "successor-session",
            stateStore,
            context: fixture.context,
            runtime: fixture.runtime,
          });
          yield* Ref.set(failRead, true);
          const failed = yield* successor.start().pipe(Effect.exit);
          expect(Exit.isFailure(failed)).toBe(true);
          expect((yield* successor.status).lifecycle).toBe("stopping");
          expect(Exit.isFailure(yield* successor.start().pipe(Effect.exit))).toBe(true);
          expect((yield* successor.maintenanceHandlers.stop).ok).toBe(true);
          const restarted = yield* successor.start().pipe(Effect.exit);
          expect(Exit.isSuccess(restarted)).toBe(true);
          if (Exit.isSuccess(restarted)) expect(restarted.value.lifecycle).toBe("running");
          expect(yield* Ref.get(fixture.resources)).toContainEqual(
            expect.objectContaining({ workloadId: "database:database", state: "ready" }),
          );
        }),
      ),
  );

  it.live("retries lazy activation after a preclaim state read failure", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failRead = yield* Ref.make(false);
        const stateStore = {
          ...fixture.store,
          read: (stackId: string) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(failRead, false))
                return yield* new StackStateInvalidError({
                  message: "transient activation state read failure",
                });
              return yield* fixture.store.read(stackId);
            }),
        };
        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          stateStore,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        yield* successor.start();
        const before = yield* Ref.get(fixture.resources);
        yield* Ref.set(failRead, true);
        const failed = yield* successor
          .activate("functions")
          .pipe(Effect.timeout("5 seconds"), Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(errorOf(failed)).toBeInstanceOf(StackStateInvalidError);
        expect(errorOf(failed)?.message).toBe("transient activation state read failure");
        expect(yield* Ref.get(fixture.resources)).toEqual(before);
        const retry = yield* successor.activate("functions").pipe(Effect.timeout("5 seconds"));
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(
          (yield* successor.status).capabilities.find(({ name }) => name === "functions")?.state,
        ).toBe("ready");
      }),
    ),
  );

  it.live("shares the original workload start failure with concurrent dependency callers", () =>
    run(
      Effect.gen(function* () {
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const startFailures = yield* Ref.make(1);
        const fixture = yield* makeFixture({
          startStarted,
          startGate,
          startWorkload: "rest:rest",
          startFailures,
          startFailureWorkload: "rest:rest",
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy" },
              studio: { activation: "lazy" },
            },
          },
        });
        const studio = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        const rest = yield* Effect.forkChild(fixture.supervisor.activate("rest"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(startGate, undefined);
        const studioExit = yield* Fiber.join(studio).pipe(Effect.exit);
        const restExit = yield* Fiber.join(rest).pipe(Effect.exit);
        expect(Exit.isFailure(studioExit)).toBe(true);
        expect(Exit.isFailure(restExit)).toBe(true);
        expect(errorOf(studioExit)?._tag).toBe(errorOf(restExit)?._tag);
        expect(errorOf(studioExit)?.message).toBe(errorOf(restExit)?.message);
      }),
    ),
  );

  it.live("fences a lazy launch when root rollback removal is unproven", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const workloadRemoveFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({
          startFailures,
          startFailureWorkload: "studio:pgmeta",
          workloadRemoveFailFirst,
          workloadRemoveFailWorkload: "studio:pgmeta",
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy" },
              studio: { activation: "lazy" },
            },
          },
        });
        const activation = yield* fixture.supervisor.activate("studio").pipe(Effect.exit);
        expect(Exit.isFailure(activation)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("failed");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "studio")
            ?.state,
        ).toBe("failed");
        expect(Exit.isFailure(yield* fixture.supervisor.activate("rest").pipe(Effect.exit))).toBe(
          true,
        );
        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
      }),
    ),
  );

  it.live("rejects activation of a disabled capability without changing its state", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: {
            capabilities: { rest: { enabled: false }, studio: { enabled: false } },
          },
        });
        const activation = yield* fixture.supervisor.activate("rest").pipe(Effect.exit);
        expect(Exit.isFailure(activation)).toBe(true);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("disabled");
      }),
    ),
  );

  it.live("re-arms an idle timer after a failed root activation releases execution", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const prepareGateEnabledRef = yield* Ref.make(false);
        const prepareActivationStarted = yield* Deferred.make<void>();
        const prepareGate = yield* Deferred.make<void>();
        const prepareFailureRef = yield* Ref.make(false);
        const logWritten = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          prepareGateEnabledRef,
          prepareActivationStarted,
          prepareGate,
          prepareFailureRef,
          logWritten,
          logWrittenFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy", idleTimeoutSeconds: 1 },
              auth: { activation: "lazy" },
              studio: { activation: "lazy", idleTimeoutSeconds: 1 },
            },
          },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* Ref.set(prepareGateEnabledRef, true);
        const auth = yield* Effect.forkChild(
          tracker.track("auth", fixture.supervisor.activate("auth")),
          { startImmediately: true },
        );
        yield* Deferred.await(prepareActivationStarted);
        yield* TestClock.adjust("1 second");
        const studio = yield* Effect.forkChild(
          tracker.track("studio", fixture.supervisor.activate("studio")),
          { startImmediately: true },
        );
        const beforeRelease = yield* fixture.supervisor.status;
        expect(beforeRelease.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        expect(beforeRelease.capabilities.find(({ name }) => name === "studio")?.state).toBe(
          "starting",
        );
        yield* Ref.set(prepareFailureRef, true);
        yield* Deferred.succeed(prepareGate, undefined);
        const authResult = yield* Fiber.join(auth).pipe(Effect.exit);
        expect(Exit.isFailure(authResult)).toBe(true);
        expect(errorOf(authResult)).toBeInstanceOf(StackRuntimeError);
        const studioResult = yield* Fiber.join(studio).pipe(Effect.exit);
        expect(Exit.isFailure(studioResult)).toBe(true);
        expect(errorOf(studioResult)).toBeInstanceOf(StackRuntimeError);
        const afterFailure = yield* fixture.supervisor.status;
        expect(afterFailure.lifecycle).toBe("running");
        expect(afterFailure.capabilities.find(({ name }) => name === "studio")?.state).toBe(
          "dormant",
        );
        yield* TestClock.adjust("1 second");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
        yield* Deferred.await(logWritten);
        expect(yield* Ref.get(fixture.resources)).toEqual(
          expect.not.arrayContaining([expect.objectContaining({ workloadId: "rest:rest" })]),
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("accepts very small idle timeout values", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const logWritten = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          logWritten,
          logWrittenFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1e-7 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(logWritten);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("rearms a zero-rounded idle timeout after its first retirement", () =>
    run(
      Effect.gen(function* () {
        const logs = yield* Queue.unbounded<string>();
        const fixture = yield* makeFixture({
          logQueue: logs,
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1e-12 } } },
        });
        yield* fixture.supervisor.activate("rest");
        yield* TestClock.adjust("1 millis");
        expect(yield* Queue.take(logs)).toContain("Stopped rest after inactivity");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");

        yield* fixture.supervisor.activate("rest");
        yield* TestClock.adjust("1 millis");
        expect(yield* Queue.take(logs)).toContain("Stopped rest after inactivity");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("resets the idle deadline when a second request arrives", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const activationStarted = yield* Deferred.make<void>();
        const logWritten = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          activationStarted,
          logWritten,
          logWrittenFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        const first = yield* Effect.forkChild(
          tracker.track("rest", fixture.supervisor.activate("rest")),
        );
        yield* Deferred.await(activationStarted);
        yield* Fiber.join(first);
        yield* TestClock.adjust("500 millis");
        yield* tracker.track("rest", Effect.void);
        yield* TestClock.adjust("500 millis");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(logWritten);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("queues traffic arriving during idle cleanup for a fresh activation", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const activationCalls = yield* Ref.make(0);
        const logQueue = yield* Queue.unbounded<string>();
        const stopStarted = yield* Deferred.make<void>();
        const stopGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          activationCalls,
          logQueue,
          workloadStopStarted: stopStarted,
          workloadStopGate: stopGate,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(stopStarted);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "auth")
            ?.state,
        ).toBe("dormant");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("stopping");

        const requestStarted = yield* Deferred.make<void>();
        const cancelled = yield* Effect.forkChild(
          Deferred.succeed(requestStarted, undefined).pipe(
            Effect.andThen(tracker.track("rest", fixture.supervisor.activate("rest"))),
          ),
        );
        yield* Deferred.await(requestStarted);
        expect(yield* Ref.get(activationCalls)).toBe(1);
        yield* Fiber.interrupt(cancelled);

        const survivorReady = yield* Deferred.make<void>();
        const survivorRelease = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          tracker.track(
            "rest",
            fixture.supervisor
              .activate("rest")
              .pipe(
                Effect.andThen(Deferred.succeed(survivorReady, undefined)),
                Effect.andThen(Deferred.await(survivorRelease)),
              ),
          ),
        );

        yield* Deferred.succeed(stopGate, undefined);
        expect(yield* Queue.take(logQueue)).toContain("Stopped rest after inactivity");
        yield* Deferred.await(survivorReady);
        expect(yield* Ref.get(activationCalls)).toBe(2);
        yield* TestClock.adjust("1 second");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
        yield* Deferred.succeed(survivorRelease, undefined);
        yield* Fiber.join(request);
        yield* TestClock.adjust("1 second");
        expect(yield* Queue.take(logQueue)).toContain("Stopped rest after inactivity");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("rejects an idempotent start admitted during idle retirement", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const stopStarted = yield* Deferred.make<void>();
        const stopGate = yield* Deferred.make<void>();
        const workloadRemoveFailFirst = yield* Ref.make(true);
        const config = {
          capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } },
        } as const;
        const fixture = yield* makeFixture({
          workloadStopStarted: stopStarted,
          workloadStopGate: stopGate,
          workloadRemoveFailFirst,
          workloadRemoveFailWorkload: "rest:rest",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({ config });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(stopStarted);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("stopping");

        const admitted = yield* Effect.forkChild(fixture.supervisor.start({ config }), {
          startImmediately: true,
        });
        yield* Effect.yieldNow;
        const rejected = yield* fixture.supervisor.start({ config }).pipe(Effect.exit);
        expect(errorOf(rejected)).toBeInstanceOf(StackLifecycleConflictError);

        yield* Deferred.succeed(stopGate, undefined);
        const failed = yield* Fiber.join(admitted).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("failed");
        expect((yield* Ref.get(fixture.calls)).filter((call) => call.startsWith("start:"))).toEqual(
          ["start:database:database", "start:rest:rest"],
        );
        expect(
          errorOf(yield* fixture.supervisor.start({ config }).pipe(Effect.exit)),
        ).toBeInstanceOf(StackLifecycleConflictError);

        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("keeps a ready capability alive while an overlapping request lease remains", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const firstAcquired = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondAcquired = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        const logQueue = yield* Queue.unbounded<string>();
        const fixture = yield* makeFixture({
          logQueue,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        const first = yield* Effect.forkChild(
          tracker.track(
            "rest",
            fixture.supervisor
              .activate("rest")
              .pipe(
                Effect.andThen(Deferred.succeed(firstAcquired, undefined)),
                Effect.andThen(Deferred.await(firstRelease)),
              ),
          ),
        );
        yield* Deferred.await(firstAcquired);
        const second = yield* Effect.forkChild(
          tracker.track(
            "rest",
            Deferred.succeed(secondAcquired, undefined).pipe(
              Effect.andThen(Deferred.await(secondRelease)),
            ),
          ),
        );
        yield* Deferred.await(secondAcquired);
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Fiber.join(first);
        yield* TestClock.adjust("2 seconds");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
        yield* Deferred.succeed(secondRelease, undefined);
        yield* Fiber.join(second);
        yield* TestClock.adjust("1 second");
        expect(yield* Queue.take(logQueue)).toContain("Stopped rest after inactivity");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("settles activation waiters when the owner scope is interrupted during retirement", () =>
    run(
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        const stopStarted = yield* Deferred.make<void>();
        const stopGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          workloadStopStarted: stopStarted,
          workloadStopGate: stopGate,
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        yield* fixture.supervisor.activate("rest");
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(stopStarted);

        const waiter = yield* Effect.forkChild(fixture.supervisor.activate("rest"), {
          startImmediately: true,
        });
        yield* TestClock.withLive(
          Scope.close(ownerScope, Exit.void).pipe(Effect.timeout("5 seconds")),
        );
        const settled = yield* TestClock.withLive(
          Fiber.await(waiter).pipe(Effect.timeout("5 seconds")),
        );
        expect(Exit.isFailure(settled)).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("settles overlapping dependency activation when launch owner scope closes", () =>
    run(
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          startStarted,
          startGate,
          startWorkload: "rest:rest",
          supervisorScope: ownerScope,
        });
        const config = {
          capabilities: {
            rest: { activation: "lazy" as const },
            studio: { activation: "lazy" as const },
          },
        };
        yield* fixture.supervisor.start({ config });
        const studio = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(startStarted);
        const rest = yield* Effect.forkChild(fixture.supervisor.activate("rest"), {
          startImmediately: true,
        });
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("starting");

        yield* Scope.close(ownerScope, Exit.void).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("owner scope did not close"),
          }),
        );
        const studioExit = yield* Fiber.await(studio).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("Studio activation remained pending after owner scope close"),
          }),
        );
        const restExit = yield* Fiber.await(rest).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("REST activation remained pending after owner scope close"),
          }),
        );
        expect(Exit.isFailure(studioExit)).toBe(true);
        if (Exit.isFailure(studioExit)) expect(Cause.hasInterrupts(studioExit.cause)).toBe(true);
        expect(Exit.isFailure(restExit)).toBe(true);
        if (Exit.isFailure(restExit)) expect(Cause.hasInterrupts(restExit.cause)).toBe(true);
      }),
    ),
  );

  it.live("rejects lifecycle admission after the owner scope closes", () =>
    run(
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        const fixture = yield* makeFixture({ supervisorScope: ownerScope });
        const config = { capabilities: { rest: { activation: "lazy" as const } } };
        yield* fixture.supervisor.start({ config });
        yield* Scope.close(ownerScope, Exit.void);
        const activation = yield* Effect.exit(fixture.supervisor.activate("rest"));
        expect(errorOf(activation)).toBeInstanceOf(StackLifecycleConflictError);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
        const retry = yield* Effect.exit(fixture.supervisor.start({ config }));
        expect(errorOf(retry)).toBeInstanceOf(StackLifecycleConflictError);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopping");
        expect(status.recovery).toEqual({
          operation: "stop",
          message: "Stack owner scope is closed",
        });
      }),
    ),
  );

  it.live("settles endpoint activation when launch owner scope closes", () =>
    run(
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const activationGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          startStarted,
          startGate,
          startWorkload: "rest:rest",
          activationStarted,
          activationGate,
          supervisorScope: ownerScope,
        });
        const config = {
          capabilities: {
            rest: { activation: "lazy" as const },
            studio: { activation: "lazy" as const },
          },
        };
        yield* fixture.supervisor.start({ config });
        const studio = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(startStarted);
        const rest = yield* Effect.forkChild(fixture.supervisor.activate("rest"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(startGate, undefined);
        yield* Deferred.await(activationStarted);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
        expect(yield* Ref.get(fixture.resources)).toContainEqual(
          expect.objectContaining({ workloadId: "rest:rest", state: "ready" }),
        );

        yield* Scope.close(ownerScope, Exit.void).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("owner scope did not close"),
          }),
        );
        const studioExit = yield* Fiber.await(studio).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("Studio activation remained pending after owner scope close"),
          }),
        );
        expect(Exit.isFailure(studioExit)).toBe(true);
        if (Exit.isFailure(studioExit)) expect(Cause.hasInterrupts(studioExit.cause)).toBe(true);
        expect(yield* Ref.get(fixture.resources)).toContainEqual(
          expect.objectContaining({ workloadId: "rest:rest", state: "ready" }),
        );
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopping");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("failed");
        const restExit = yield* Fiber.await(rest).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.die("REST activation remained pending after endpoint owner scope close"),
          }),
        );
        expect(Exit.isFailure(restExit)).toBe(true);
      }),
    ),
  );

  it.live("settles lazy activation interrupted while waiting for admission", () =>
    run(
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        const readGateQueue = yield* Ref.make<ReadonlyArray<ReadGate>>([]);
        const activationReadStarted = yield* Deferred.make<void>();
        const activationReadGate = yield* Deferred.make<void>();
        const shutdownReadStarted = yield* Deferred.make<void>();
        const shutdownReadGate = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          readGateQueue,
          supervisorScope: ownerScope,
          activationStarted,
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy" } } },
        });
        yield* Ref.set(readGateQueue, [
          { started: activationReadStarted, gate: activationReadGate },
        ]);

        const activation = yield* Effect.forkChild(
          fixture.supervisor
            .activate("rest")
            .pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
          { startImmediately: true },
        );
        yield* Deferred.await(activationReadStarted).pipe(
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        yield* Ref.update(readGateQueue, (gates) => [
          ...gates,
          { started: shutdownReadStarted, gate: shutdownReadGate },
        ]);
        const shutdown = yield* Effect.forkChild(fixture.supervisor.shutdownIfIdle, {
          startImmediately: true,
        });
        yield* Deferred.await(shutdownReadStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);

        // Deferred resumes synchronously to the masked wait; wake-up is queued.
        // Only FiberSet has a live finalizer, so scope close installs interruption first.
        yield* Deferred.succeed(activationReadGate, undefined);
        const closing = yield* Effect.forkChild(
          Scope.close(ownerScope, Exit.void).pipe(
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
          ),
          { startImmediately: true },
        );
        yield* Deferred.succeed(shutdownReadGate, undefined);

        yield* Fiber.join(closing).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("owner scope did not close"),
          }),
        );
        const activationExit = yield* Fiber.await(activation).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("activation remained pending after owner scope close"),
          }),
        );
        yield* Fiber.join(shutdown);
        expect(Exit.isFailure(activationExit)).toBe(true);
        if (Exit.isFailure(activationExit))
          expect(Cause.hasInterrupts(activationExit.cause)).toBe(true);
        expect(yield* Deferred.isDone(activationStarted)).toBe(false);

        const status = yield* fixture.supervisor.status;
        expect(status.recovery?.operation).toBe("stop");
      }),
    ),
  );

  it.live("keeps unrelated ready traffic flowing during idle cleanup", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const stopStarted = yield* Deferred.make<void>();
        const stopGate = yield* Deferred.make<void>();
        const authCompleted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          workloadStopStarted: stopStarted,
          workloadStopGate: stopGate,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        const body = Effect.gen(function* () {
          yield* fixture.supervisor.start({
            config: {
              capabilities: {
                rest: { activation: "lazy", idleTimeoutSeconds: 1 },
                auth: { activation: "eager" },
              },
            },
          });
          const tracker = yield* Ref.get(activity);
          if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
          yield* tracker.track("auth", fixture.supervisor.activate("auth"));
          yield* tracker.track("rest", fixture.supervisor.activate("rest"));
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(stopStarted);

          const authRequest = yield* Effect.forkChild(
            tracker.track(
              "auth",
              fixture.supervisor
                .activate("auth")
                .pipe(Effect.andThen(Deferred.succeed(authCompleted, undefined))),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(authCompleted);
          yield* Deferred.succeed(stopGate, undefined);
          yield* Fiber.join(authRequest);
        });
        yield* body.pipe(Effect.ensuring(Deferred.succeed(stopGate, undefined)));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("rejects queued demand when explicit stop wins idle retirement", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const stopStarted = yield* Deferred.make<void>();
        const stopGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          workloadStopStarted: stopStarted,
          workloadStopGate: stopGate,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(stopStarted);
        const request = yield* Effect.forkChild(
          tracker.track("rest", fixture.supervisor.activate("rest")),
          {
            startImmediately: true,
          },
        );
        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop, {
          startImmediately: true,
        });
        yield* Deferred.succeed(stopGate, undefined);
        expect((yield* Fiber.join(stopping)).ok).toBe(true);
        const requestResult = yield* Fiber.join(request).pipe(Effect.exit);
        expect(Exit.isFailure(requestResult)).toBe(true);
        expect(yield* Ref.get(fixture.resources)).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("records the original cause when idle cleanup fails", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const logRecords = yield* Ref.make<ReadonlyArray<string>>([]);
        const logWritten = yield* Deferred.make<void>();
        const workloadStopFailFirst = yield* Ref.make(true);
        const workloadStopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          logRecords,
          logWritten,
          workloadStopFailFirst,
          workloadStopStarted,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(workloadStopStarted).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("workload stop did not start"),
          }),
        );
        yield* Deferred.await(logWritten);
        const messages = yield* Ref.get(logRecords);
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Failed to stop rest after inactivity"),
            expect.stringContaining("injected workload stop failure"),
          ]),
        );
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopping");
        expect(status.recovery).toEqual({
          operation: "stop",
          message: expect.stringContaining("injected workload stop failure"),
        });
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("fences the session after an idle cleanup defect", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const logRecords = yield* Ref.make<ReadonlyArray<string>>([]);
        const logWritten = yield* Deferred.make<void>();
        const workloadRemoveDieFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({
          logRecords,
          logWritten,
          workloadRemoveDieFirst,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(logWritten);

        const messages = yield* Ref.get(logRecords);
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Failed to stop rest after inactivity"),
            expect.stringContaining("injected workload remove defect"),
          ]),
        );
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        const activation = yield* fixture.supervisor.activate("rest").pipe(Effect.exit);
        expect(errorOf(activation)).toBeInstanceOf(StackLifecycleConflictError);

        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const restartedTracker = yield* Ref.get(activity);
        if (restartedTracker === undefined)
          return yield* Effect.die("restarted gateway activity was not installed");
        yield* restartedTracker.track("rest", fixture.supervisor.activate("rest"));
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("cancels idle timers when a stack session stops", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const firstTracker = yield* Ref.get(activity);
        if (firstTracker === undefined)
          return yield* Effect.die("first gateway activity was not installed");
        yield* firstTracker.track("rest", fixture.supervisor.activate("rest"));
        yield* fixture.supervisor.maintenanceHandlers.stop;

        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 10 } } },
        });
        const secondTracker = yield* Ref.get(activity);
        if (secondTracker === undefined)
          return yield* Effect.die("second gateway activity was not installed");
        yield* secondTracker.track("rest", fixture.supervisor.activate("rest"));
        yield* TestClock.adjust("1 second");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("ready");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("restores idle deadlines after a rejected running start", () =>
    run(
      Effect.gen(function* () {
        const activity = yield* Ref.make<GatewayActivity | undefined>(undefined);
        const logWritten = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          logWritten,
          logWrittenFor: "Stopped rest after inactivity",
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: false,
                ownershipToken: Symbol(),
              }),
            open: (_input, _reservation, _activate, tracker) =>
              tracker === undefined ? Effect.void : Ref.set(activity, tracker),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy", idleTimeoutSeconds: 1 } } },
        });
        const tracker = yield* Ref.get(activity);
        if (tracker === undefined) return yield* Effect.die("gateway activity was not installed");
        yield* tracker.track("rest", fixture.supervisor.activate("rest"));
        const rejected = yield* fixture.supervisor
          .start({ config: { capabilities: { rest: { settings: { schemas: ["private"] } } } } })
          .pipe(Effect.exit);
        expect(errorOf(rejected)).toBeInstanceOf(StackMustBeStoppedError);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(logWritten);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("dormant");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("persists stopped after startup ingress failure", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.fail(
                new PortUnavailableError({
                  field: "api",
                  port: 54_321,
                  message: "injected ingress failure",
                }),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        expect(
          Exit.isFailure(yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit)),
        ).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.desiredLifecycle).toBe("stopped");
        expect(status.lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("persists stopped after a restart ingress failure", () =>
    run(
      Effect.gen(function* () {
        const acquireCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Ref.updateAndGet(acquireCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count !== 2
                    ? Effect.succeed({
                        assignments: {},
                        privateAssignments: [],
                        hostListeners: [],
                        fresh: true,
                        ownershipToken: Symbol(),
                      })
                    : Effect.fail(
                        new PortUnavailableError({
                          field: "api",
                          port: 54_321,
                          message: "injected start ingress failure",
                        }),
                      ),
                ),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({ config: {} });
        yield* fixture.supervisor.maintenanceHandlers.stop;

        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.desiredLifecycle).toBe("stopped");
        expect(status.lifecycle).toBe("stopped");
        expect(errorOf(yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit))?.tag).toBe(
          "StackNotRunningError",
        );
        yield* fixture.supervisor.shutdownIfIdle;
        const retry = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(retry)).toBeInstanceOf(StackLifecycleConflictError);
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
      }),
    ),
  );

  it.live("exits after a stopped-owner restart ingress failure", () =>
    run(
      Effect.gen(function* () {
        const acquireCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Ref.updateAndGet(acquireCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count !== 2
                    ? Effect.succeed({
                        assignments: {},
                        privateAssignments: [],
                        hostListeners: [],
                        fresh: true,
                        ownershipToken: Symbol(),
                      })
                    : Effect.fail(
                        new PortUnavailableError({
                          field: "api",
                          port: 54_321,
                          message: "injected stopped-owner ingress failure",
                        }),
                      ),
                ),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({ config: {} });
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);

        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        yield* fixture.supervisor.shutdownIfIdle;
        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
      }),
    ),
  );

  it.live("starts only database by default and keeps other capabilities dormant", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const status = yield* fixture.supervisor.start({ config: {} });
        expect(status.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);
        expect(status.capabilities.find(({ name }) => name === "database")?.state).toBe("ready");
        for (const name of [
          "rest",
          "auth",
          "realtime",
          "storage",
          "functions",
          "studio",
          "mail",
          "analytics",
          "pooler",
        ] as const)
          expect(status.capabilities.find((capability) => capability.name === name)?.state).toBe(
            "dormant",
          );
      }),
    ),
  );

  it.live("returns database readiness while background preparation remains observable", () =>
    run(
      Effect.gen(function* () {
        const prefetchStarted = yield* Deferred.make<void>();
        const prefetchGate = yield* Deferred.make<void>();
        const prefetchInterrupted = yield* Deferred.make<void>();
        const prefetchCalls = yield* Ref.make(0);
        const artifactStatuses = yield* Ref.make<ReadonlyArray<ArtifactPreparationStatus>>([]);
        const fixture = yield* makeFixture({
          prefetchStarted,
          prefetchGate,
          prefetchInterrupted,
          prefetchCalls,
          artifactStatuses,
        });
        const startReturned = yield* Deferred.make<StackStatus>();
        yield* Effect.forkChild(
          fixture.supervisor
            .start({ config: {} })
            .pipe(
              Effect.tap((status) => Deferred.succeed(startReturned, status).pipe(Effect.asVoid)),
            ),
          { startImmediately: true },
        );
        const started = yield* Deferred.await(startReturned).pipe(
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        expect(started.capabilities.find(({ name }) => name === "database")?.state).toBe("ready");
        expect(started.capabilities.find(({ name }) => name === "rest")?.state).toBe("dormant");
        yield* Deferred.await(prefetchStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        const during = yield* fixture.supervisor.status;
        expect(during.capabilities.find(({ name }) => name === "rest")?.state).toBe("dormant");
        expect(during.artifacts).toEqual([
          { workloadId: "rest:rest", capability: "rest", state: "downloading" },
        ]);

        const repeated = yield* fixture.supervisor.start();
        expect(repeated.artifacts).toEqual(during.artifacts);
        expect(yield* Ref.get(prefetchCalls)).toBe(1);

        const stopped = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(stopped.ok).toBe(true);
        yield* Deferred.await(prefetchInterrupted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
      }),
    ),
  );

  it.live("launches workloads while selected preparation is still in flight", () =>
    run(
      Effect.gen(function* () {
        const prepareStarted = yield* Deferred.make<void>();
        const prepareGate = yield* Deferred.make<void>();
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          prepareStarted,
          prepareGate,
          startStarted,
          startGate,
        });
        const starting = yield* Effect.forkChild(fixture.supervisor.start({ config: {} }), {
          startImmediately: true,
        });
        yield* Deferred.await(prepareStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.succeed(startGate, undefined);
        yield* Deferred.succeed(prepareGate, undefined);
        const status = yield* Fiber.join(starting);
        expect(status.lifecycle).toBe("running");
      }),
    ),
  );

  it.live("cleans launched workloads when preparation fails after launch completes", () =>
    run(
      Effect.gen(function* () {
        const prepareStarted = yield* Deferred.make<void>();
        const prepareGate = yield* Deferred.make<void>();
        const startFinished = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          prepareStarted,
          prepareGate,
          prepareFailure: true,
          startFinished,
        });
        const starting = yield* Effect.forkChild(
          fixture.supervisor.start({
            config: { capabilities: { rest: { activation: "eager" } } },
          }),
          { startImmediately: true },
        );
        yield* Deferred.await(prepareStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.await(startFinished).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.succeed(prepareGate, undefined);
        const result = yield* Fiber.join(starting).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("cancels a blocked launcher when preparation fails first", () =>
    run(
      Effect.gen(function* () {
        const prepareFailureRef = yield* Ref.make(false);
        const prepareGateEnabledRef = yield* Ref.make(false);
        const prepareStarted = yield* Deferred.make<void>();
        const prepareActivationStarted = yield* Deferred.make<void>();
        const prepareGate = yield* Deferred.make<void>();
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          prepareStarted,
          prepareActivationStarted,
          prepareGate,
          prepareGateEnabledRef,
          prepareFailureRef,
          startStarted,
          startGate,
          startWorkload: "studio:studio",
        });
        const starting = yield* Effect.forkChild(
          fixture.supervisor.start({
            config: {
              capabilities: {
                rest: { activation: "eager" },
                studio: { activation: "lazy" },
              },
            },
          }),
          { startImmediately: true },
        );
        yield* Fiber.join(starting).pipe(Effect.timeout("5 seconds"));
        yield* Ref.set(prepareFailureRef, true);
        yield* Ref.set(prepareGateEnabledRef, true);
        const activation = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(prepareActivationStarted).pipe(
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.succeed(prepareGate, undefined);
        const result = yield* Fiber.join(activation).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const statusAfterFailure = yield* fixture.supervisor.status;
        expect(statusAfterFailure.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.resources)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ workloadId: "database:database", state: "ready" }),
            expect.objectContaining({ workloadId: "rest:rest", state: "ready" }),
          ]),
        );
        yield* Deferred.succeed(startGate, undefined);
        yield* Ref.set(prepareFailureRef, false);
        expect((yield* fixture.supervisor.activate("studio")).endpoint).toEqual({
          host: "127.0.0.1",
          port: 9999,
        });
      }),
    ),
  );

  it.live("retains preparation and cleanup causes after a launched workload", () =>
    run(
      Effect.gen(function* () {
        const prepareFailureRef = yield* Ref.make(false);
        const prepareGateEnabledRef = yield* Ref.make(false);
        const prepareActivationStarted = yield* Deferred.make<void>();
        const prepareGate = yield* Deferred.make<void>();
        const startStarted = yield* Deferred.make<void>();
        const startFinished = yield* Deferred.make<void>();
        const workloadRemoveFailFirst = yield* Ref.make(true);
        const ingressCloseFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({
          prepareActivationStarted,
          prepareGate,
          prepareGateEnabledRef,
          prepareFailureRef,
          startStarted,
          startWorkload: "studio:studio",
          startFinished,
          workloadRemoveFailFirst,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
                ownershipToken: Symbol(),
              }),
            open: () => Effect.void,
            close: Effect.gen(function* () {
              if (yield* Ref.get(ingressCloseFailFirst)) {
                yield* Ref.set(ingressCloseFailFirst, false);
                return yield* new StackCleanupError({ message: "injected ingress close failure" });
              }
            }),
          },
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "eager" },
              studio: { activation: "lazy" },
            },
          },
        });
        yield* Ref.set(ingressCloseFailFirst, true);
        yield* Ref.set(prepareFailureRef, true);
        yield* Ref.set(prepareGateEnabledRef, true);
        const activation = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(prepareActivationStarted).pipe(
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.await(startFinished).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.succeed(prepareGate, undefined);

        const failed = yield* Fiber.join(activation).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) {
          const message = Cause.pretty(failed.cause);
          expect(message).toContain("injected preparation failure");
          expect(message).toContain("injected workload remove failure");
          expect(message).toContain("injected ingress close failure");
        }
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("keeps accepted start work alive when its caller is interrupted", () =>
    run(
      Effect.gen(function* () {
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const prefetchStarted = yield* Deferred.make<void>();
        const prefetchGate = yield* Deferred.make<void>();
        const prefetchFinished = yield* Deferred.make<void>();
        const artifactStatuses = yield* Ref.make<ReadonlyArray<ArtifactPreparationStatus>>([]);
        const fixture = yield* makeFixture({
          startStarted,
          startGate,
          prefetchStarted,
          prefetchGate,
          prefetchFinished,
          artifactStatuses,
        });
        const waiter = yield* Effect.forkChild(fixture.supervisor.start({ config: {} }), {
          startImmediately: true,
        });
        yield* Deferred.await(startStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Fiber.interrupt(waiter);
        const interrupted = yield* Fiber.join(waiter).pipe(Effect.exit);
        expect(Exit.isFailure(interrupted)).toBe(true);
        yield* Deferred.succeed(startGate, undefined);
        yield* Deferred.await(prefetchStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        const during = yield* fixture.supervisor.status;
        expect(during.lifecycle).toBe("running");
        expect(during.artifacts).toEqual([
          { workloadId: "rest:rest", capability: "rest", state: "downloading" },
        ]);
        yield* Deferred.succeed(prefetchGate, undefined);
        yield* Deferred.await(prefetchFinished).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("running");
        yield* fixture.supervisor.maintenanceHandlers.stop;
      }),
    ),
  );

  it.live("interrupts background preparation before destroying the stack", () =>
    run(
      Effect.gen(function* () {
        const prefetchStarted = yield* Deferred.make<void>();
        const prefetchGate = yield* Deferred.make<void>();
        const prefetchInterrupted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          prefetchStarted,
          prefetchGate,
          prefetchInterrupted,
        });
        yield* fixture.supervisor.start({ config: {} });
        yield* Deferred.await(prefetchStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        const destroying = yield* Effect.forkChild(fixture.supervisor.destroy, {
          startImmediately: true,
        });
        yield* Deferred.await(prefetchInterrupted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Fiber.join(destroying);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("skips background preparation for on-demand and failed starts", () =>
    run(
      Effect.gen(function* () {
        const onDemandStarted = yield* Deferred.make<void>();
        const onDemandCalls = yield* Ref.make(0);
        const onDemand = yield* makeFixture({
          prefetchStarted: onDemandStarted,
          prefetchCalls: onDemandCalls,
        });
        yield* onDemand.supervisor.start({ config: { preparation: "on-demand" } });
        expect(Option.isNone(yield* Deferred.poll(onDemandStarted))).toBe(true);
        expect(yield* Ref.get(onDemandCalls)).toBe(0);

        const failedStarted = yield* Deferred.make<void>();
        const failedCalls = yield* Ref.make(0);
        const startFailures = yield* Ref.make(1);
        const failed = yield* makeFixture({
          prefetchStarted: failedStarted,
          prefetchCalls: failedCalls,
          startFailures,
        });
        const result = yield* failed.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(Option.isNone(yield* Deferred.poll(failedStarted))).toBe(true);
        expect(yield* Ref.get(failedCalls)).toBe(0);
      }),
    ),
  );

  it.live("reports starting while relaunching a stopped owner", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);

        const blocked = yield* Ref.make(false);
        const launchStarted = yield* Deferred.make<void>();
        const launchGate = yield* Deferred.make<void>();
        const baseDriver = fixture.runtime.driver;
        const driver: RuntimeDriver = {
          ...baseDriver,
          start: (key, workload) =>
            Effect.gen(function* () {
              if (yield* Ref.get(blocked)) {
                yield* Deferred.succeed(launchStarted, undefined);
                yield* Deferred.await(launchGate);
              }
              return yield* baseDriver.start(key, workload);
            }),
        };
        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "stopped-relaunch-successor",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: { ...fixture.runtime, driver },
        });
        yield* successor.start({ config: {} });
        expect((yield* successor.maintenanceHandlers.stop).ok).toBe(true);
        yield* Ref.set(blocked, true);

        const starting = yield* Effect.forkChild(successor.start(), { startImmediately: true });
        yield* Deferred.await(launchStarted);
        expect((yield* successor.status).lifecycle).toBe("starting");
        expect((yield* successor.logs()).running).toBe(true);
        yield* Deferred.succeed(launchGate, undefined);
        expect((yield* Fiber.join(starting)).lifecycle).toBe("running");
        yield* successor.maintenanceHandlers.stop;
        yield* successor.shutdownIfIdle;
        yield* fixture.supervisor.shutdownIfIdle;
      }),
    ),
  );

  it.live("cleans stale runtime resources before the first start of a new supervisor", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(fixture.calls, []);
        yield* Ref.set(fixture.resources, [
          {
            stackId: fixture.id,
            workloadId: "database:database",
            state: "ready",
          },
        ]);

        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        yield* successor.start();
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);

        yield* Ref.set(fixture.calls, []);
        yield* successor.start();
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
      }),
    ),
  );

  it.live("skips preflight for a live session and preflights a new owner", () =>
    run(
      Effect.gen(function* () {
        const preflightCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({ preflightCalls });
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(preflightCalls, 0);

        yield* fixture.supervisor.start();
        expect(yield* Ref.get(preflightCalls)).toBe(0);
        yield* fixture.supervisor.maintenanceHandlers.stop;
        yield* fixture.supervisor.start();
        expect(yield* Ref.get(preflightCalls)).toBe(1);

        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        yield* Ref.set(preflightCalls, 0);
        yield* successor.start();
        expect(yield* Ref.get(preflightCalls)).toBe(1);
      }),
    ),
  );

  it.live("keeps the owner for retryable first-start cleanup", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ stopFailFirst });
        const failed = yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("unconfigured");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("keeps the owner when eager launch cleanup is unproven", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ startFailures, stopFailFirst });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");

        const retry = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(retry.ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("shuts down after a proven eager launch failure", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const fixture = yield* makeFixture({ startFailures });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        const stopped = yield* fixture.supervisor.status;
        expect(stopped.lifecycle).toBe("stopped");
        expect(stopped.capabilities.find(({ name }) => name === "database")?.state).toBe("stopped");
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown;
      }),
    ),
  );

  it.live("publishes stopped after launch cleanup retry succeeds", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ startFailures, stopFailFirst });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        const stopped = yield* fixture.supervisor.status;
        expect(stopped.lifecycle).toBe("stopped");
        expect(stopped.capabilities.some(({ state }) => state === "failed")).toBe(false);
        expect((yield* fixture.supervisor.start()).lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.resources)).not.toEqual([]);
      }),
    ),
  );

  it.live("persists stopped after a proven fresh-session preflight failure", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ preflightFailFirst });
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(preflightFailFirst, true);

        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        const failed = yield* successor.start().pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect((yield* successor.status).lifecycle).toBe("stopped");
        yield* successor.shutdownIfIdle;
        yield* successor.shutdown;

        const retryOwner = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "retry-session",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        expect((yield* retryOwner.start()).lifecycle).toBe("running");
      }),
    ),
  );

  it.live("persists stopped after a proven fresh-session materialization failure", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(fixture.calls, []);
        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "materialization-successor",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        const failed = yield* successor
          .start({ config: { capabilities: { database: { version: "99" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(errorOf(failed)).toBeInstanceOf(StackVersionUnsupportedError);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect((yield* successor.status).lifecycle).toBe("stopped");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop"]);
        yield* successor.shutdownIfIdle;
        yield* successor.shutdown;
        const retryOwner = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "materialization-retry",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        expect((yield* retryOwner.start()).lifecycle).toBe("running");
      }),
    ),
  );

  it.live("persists stopped after a proven fresh-session changed-input rejection", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "changed-input-successor",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        const failed = yield* successor
          .start({ config: { capabilities: { rest: { settings: { schemas: ["private"] } } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(errorOf(failed)).toBeInstanceOf(StackMustBeStoppedError);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect((yield* successor.status).lifecycle).toBe("stopped");
        yield* successor.shutdownIfIdle;
        yield* successor.shutdown;
      }),
    ),
  );

  it.live("keeps stopping when fresh-ingress cleanup fails, then recovers on explicit stop", () =>
    run(
      Effect.gen(function* () {
        const closeFailures = yield* Ref.make(2);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
                ownershipToken: Symbol(),
              }),
            open: () => Effect.void,
            close: Effect.gen(function* () {
              const remaining = yield* Ref.get(closeFailures);
              if (remaining > 0) {
                yield* Ref.set(closeFailures, remaining - 1);
                return yield* new StackCleanupError({ message: "injected close failure" });
              }
            }),
          },
        });
        const failed = yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(false);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("keeps stopping when persisting the stopped fence fails", () =>
    run(
      Effect.gen(function* () {
        const stoppedReplaceFail = yield* Ref.make(true);
        const fixture = yield* makeFixture({ stoppedReplaceFail });
        yield* fixture.supervisor.start({ config: {} });
        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "stopped-fence-successor",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        const failed = yield* successor.maintenanceHandlers.stop;
        expect(failed.ok).toBe(false);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("running");
        expect((yield* successor.status).lifecycle).toBe("stopping");
        expect(errorOf(yield* successor.activate("functions").pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* successor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* successor.status).lifecycle).toBe("stopped");
        yield* successor.shutdownIfIdle;
        yield* fixture.supervisor.shutdownIfIdle;
      }),
    ),
  );

  it.live("requires stop recovery when a cold start cannot persist its stopped fence", () =>
    run(
      Effect.gen(function* () {
        const stoppedReplaceFail = yield* Ref.make(true);
        const acquireCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          stoppedReplaceFail,
          ingress: {
            acquire: () =>
              Ref.updateAndGet(acquireCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Effect.fail(
                        new PortUnavailableError({
                          field: "api",
                          port: 54_321,
                          message: "injected cold start failure",
                        }),
                      )
                    : Effect.succeed({
                        assignments: {},
                        privateAssignments: [],
                        hostListeners: [],
                        fresh: true,
                        ownershipToken: Symbol(),
                      }),
                ),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.start()).lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.resources)).not.toEqual([]);
      }),
    ),
  );

  it.live("clears failed capability status after successful cleanup retry", () =>
    run(
      Effect.gen(function* () {
        const removeFailure = yield* Ref.make(true);
        const fixture = yield* makeFixture({ workloadRemoveFailFirst: removeFailure });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        const failed = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(failed.ok).toBe(false);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopped");
        expect(status.capabilities.some(({ state }) => state === "failed")).toBe(false);
        expect((yield* fixture.supervisor.start()).lifecycle).toBe("running");
      }),
    ),
  );

  it.live("returns persisted database, API, and storage credentials while running", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined || running.definition === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        yield* fixture.store
          .replace(fixture.id, {
            ...running,
            ports: [
              { field: "api", port: 55433, intent: "exact" },
              { field: "database", port: 55432, intent: "exact" },
            ] as const,
          })
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(credentials.database.url).toEqual(expect.anything());
        expect(Redacted.value(credentials.database.url)).toMatch(
          /^postgresql:\/\/postgres:.+@127\.0\.0\.1:\d+\/postgres$/,
        );
        expect(Redacted.value(credentials.database.password)).toEqual(expect.any(String));
        if (credentials.api === undefined)
          return yield* new StackStateInvalidError({ message: "API credentials are missing" });
        expect(credentials.api.publishableKey).toEqual(expect.any(String));
        expect(Redacted.value(credentials.api.secretKey)).toEqual(expect.any(String));
        expect(credentials.api.anonJwt).toEqual(expect.any(String));
        expect(Redacted.value(credentials.api.serviceRoleJwt)).toEqual(expect.any(String));
        expect(credentials.storage).toEqual(
          expect.objectContaining({
            region: "local",
            accessKeyId: "625729a08b95bf1b7ff351a663f3a23c",
          }),
        );
        if (credentials.storage === undefined)
          return yield* new StackStateInvalidError({ message: "storage credentials are missing" });
        const persistedStorageSecret =
          running.secrets["secret:storage.settings.s3_protocol.secret_access_key"]?.value;
        expect(persistedStorageSecret).toEqual(expect.any(String));
        expect(Redacted.value(credentials.storage.secretAccessKey)).toBe(persistedStorageSecret);
      }),
    ),
  );

  it.live("URL-encodes persisted database credentials and brackets IPv6 listeners", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined || running.definition === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const definition = {
          ...running.definition,
          listeners: {
            ...running.definition.listeners,
            database: { ...running.definition.listeners.database, address: "2001:db8::1" },
          },
        };
        const state = {
          ...running,
          definition,
          ports: [
            { field: "api", port: 55433, intent: "exact" as const },
            { field: "database", port: 55432, intent: "exact" as const },
          ] as const,
          secrets: {
            ...running.secrets,
            "secret:database.internal.password": {
              policy: "managed" as const,
              value: "p@ss:word",
            },
          },
        };
        yield* fixture.store
          .replace(fixture.id, state)
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(Redacted.value(credentials.database.url)).toBe(
          "postgresql://postgres:p%40ss%3Aword@[2001:db8::1]:55432/postgres",
        );
      }),
    ),
  );

  it.live("omits storage credentials when Storage is disabled", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: {}, storage: { enabled: false } } },
        });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const state = {
          ...running,
          ports: [
            { field: "api", port: 55433, intent: "exact" as const },
            { field: "database", port: 55432, intent: "exact" as const },
          ] as const,
        };
        yield* fixture.store
          .replace(fixture.id, state)
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(credentials.storage).toBeUndefined();
      }),
    ),
  );

  it.live(
    "returns database credentials when Auth is disabled and fails closed for missing secrets",
    () =>
      run(
        Effect.gen(function* () {
          const { fixture } = yield* makeCredentialsFixture({ authEnabled: false });
          const authDisabled = yield* invokeCredentials(fixture.supervisor);
          expect(authDisabled.database.url).toEqual(expect.anything());
          expect(authDisabled.api).toBeUndefined();
        }),
      ),
  );

  it.live("fails closed when an enabled Auth secret slot is absent", () =>
    run(
      Effect.gen(function* () {
        const { fixture, state, baseSecrets } = yield* makeCredentialsFixture();
        const missingSecret = {
          ...state,
          secrets: Object.fromEntries(
            Object.entries(baseSecrets).filter(
              ([slot]) => slot !== "secret:auth.settings.publishable_key",
            ),
          ),
        };
        yield* fixture.store
          .replace(fixture.id, missingSecret)
          .pipe(Effect.provideContext(fixture.context));
        const failed = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(failed)).toMatchObject({ tag: "StackSecretMismatchError" });
      }),
    ),
  );

  it.live("fails closed when a required Storage secret slot is absent", () =>
    run(
      Effect.gen(function* () {
        const { fixture, state, baseSecrets } = yield* makeCredentialsFixture();
        const missingSecret = {
          ...state,
          secrets: Object.fromEntries(
            Object.entries(baseSecrets).filter(
              ([slot]) => slot !== "secret:storage.settings.s3_protocol.secret_access_key",
            ),
          ),
        };
        yield* fixture.store
          .replace(fixture.id, missingSecret)
          .pipe(Effect.provideContext(fixture.context));
        const failed = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(failed)).toMatchObject({ tag: "StackSecretMismatchError" });
      }),
    ),
  );

  it.live("fails closed when the API listener is absent", () =>
    run(
      Effect.gen(function* () {
        const { fixture, state, baseSecrets } = yield* makeCredentialsFixture();
        const missingApiListener = {
          ...state,
          secrets: baseSecrets,
          ports: [{ field: "database", port: 55432, intent: "exact" as const }] as const,
        };
        yield* fixture.store
          .replace(fixture.id, missingApiListener)
          .pipe(Effect.provideContext(fixture.context));
        const failed = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(failed)).toMatchObject({ tag: "InvalidStackConfigError" });
      }),
    ),
  );

  it.live("fails closed when the database listener is disabled", () =>
    run(
      Effect.gen(function* () {
        const { fixture, state, definition, baseSecrets } = yield* makeCredentialsFixture();
        const disabledDatabase = {
          ...state,
          secrets: baseSecrets,
          definition: {
            ...definition,
            listeners: {
              ...definition.listeners,
              database: { ...definition.listeners.database, enabled: false },
            },
          },
        };
        yield* fixture.store
          .replace(fixture.id, disabledDatabase)
          .pipe(Effect.provideContext(fixture.context));
        const failed = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(failed)).toMatchObject({ tag: "InvalidStackConfigError" });
      }),
    ),
  );

  it.live("acknowledges stop only after runtime cleanup", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response.ok).toBe(true);
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");
      }),
    ),
  );

  it.live("reports stopping while stop cleanup is still in progress", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: {}, auth: { activation: "lazy" } } },
        });

        const stop = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "auth")
            ?.state,
        ).toBe("dormant");
        const duringStop = yield* fixture.supervisor.logs();
        expect(duringStop.running).toBe(true);
        expect(duringStop.entries).toHaveLength(1);

        yield* Deferred.succeed(stopGate, undefined);
        expect((yield* Fiber.join(stop)).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "auth")
            ?.state,
        ).toBe("stopped");
        const afterStop = yield* fixture.supervisor.logs();
        expect(afterStop.running).toBe(false);
        expect(afterStop.entries).toHaveLength(2);
        expect(afterStop.entries.filter(({ message }) => message === "stopped")).toHaveLength(1);
      }),
    ),
  );

  it.live("settles stop when the owner scope closes during workload cleanup", () =>
    run(
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        const workloadStopStarted = yield* Deferred.make<void>();
        const workloadStopGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          supervisorScope: ownerScope,
          workloadStopStarted,
          workloadStopGate,
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop, {
          startImmediately: true,
        });
        yield* Deferred.await(workloadStopStarted);
        yield* Scope.close(ownerScope, Exit.void).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("owner scope did not close"),
          }),
        );
        const result = yield* Fiber.await(stopping).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die("stop remained pending after owner scope close"),
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopping");
        expect(status.recovery).toMatchObject({
          operation: "stop",
          message: expect.any(String),
        });
        expect(status.recovery?.message.length).toBeGreaterThan(0);
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("failed");
      }),
    ),
  );

  it.live("preserves stop cleanup diagnostics through maintenance responses", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(stopFailFirst, true);

        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response).toEqual({
          ok: false,
          error: {
            tag: "operation-failed",
            message: "injected stop cleanup failure",
            stackErrorTag: "StackCleanupError",
          },
        });
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
      }),
    ),
  );

  it.live("attempts runtime cleanup when session workload stop fails", () =>
    run(
      Effect.gen(function* () {
        const workloadStopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ workloadStopFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        yield* Ref.set(fixture.calls, []);

        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response).toEqual({
          ok: false,
          error: {
            tag: "operation-failed",
            message: "Session cleanup is unresolved for rest:rest: injected workload stop failure",
            stackErrorTag: "StackCleanupError",
          },
        });
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
      }),
    ),
  );

  it.live("stops the launched session in reverse dependency order", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({ timeline });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        yield* Ref.set(timeline, []);

        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect(yield* Ref.get(timeline)).toEqual([
          "stop:rest:rest",
          "stop:database:database",
          "cleanup:stop",
        ]);
      }),
    ),
  );

  it.live("keeps stopping state while an explicit stop is active", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        yield* Deferred.succeed(stopGate, undefined);
        yield* Fiber.join(stopping);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        yield* fixture.supervisor.shutdownIfIdle;
        const restart = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(restart)).toBeInstanceOf(StackLifecycleConflictError);
      }),
    ),
  );

  it.live("reports destroying while persistent data cleanup is in progress", () =>
    run(
      Effect.gen(function* () {
        const destroyGate = yield* Deferred.make<void>();
        const destroyStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ destroyGate, destroyStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const destroy = yield* Effect.forkChild(fixture.supervisor.destroy);
        yield* Deferred.await(destroyStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("destroying");

        yield* Deferred.succeed(destroyGate, undefined);
        yield* Fiber.join(destroy);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("fences activation when the destroy durable pre-fence fails", () =>
    run(
      Effect.gen(function* () {
        const destroyPreFenceFail = yield* Ref.make(true);
        const fixture = yield* makeFixture({ destroyPreFenceFail });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "lazy" } } },
        });
        expect((yield* fixture.supervisor.status).lifecycle).toBe("running");
        const destroyed = yield* fixture.supervisor.destroy.pipe(Effect.exit);
        expect(Exit.isFailure(destroyed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("running");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("destroying");
        const resourcesBefore = yield* Ref.get(fixture.resources);
        const activation = yield* fixture.supervisor.activate("rest").pipe(Effect.exit);
        expect(errorOf(activation)).toBeInstanceOf(StackLifecycleConflictError);
        const readyActivation = yield* fixture.supervisor.activate("database").pipe(Effect.exit);
        expect(errorOf(readyActivation)).toBeInstanceOf(StackLifecycleConflictError);
        expect(yield* Ref.get(fixture.resources)).toEqual(resourcesBefore);
        expect(yield* Ref.get(fixture.calls)).not.toContain("start:rest:rest");
        yield* fixture.supervisor.destroy;
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("requires destroy retry after persistent cleanup fails", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(fixture.failDestroy, true);

        const failed = yield* fixture.supervisor.destroy.pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("destroying");
        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(false);

        yield* Ref.set(fixture.failDestroy, false);
        yield* fixture.supervisor.destroy;
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("propagates typed workload observation failures while running", () =>
    run(
      Effect.gen(function* () {
        const observeFailure = yield* Ref.make(false);
        const fixture = yield* makeFixture({ observeFailure });
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(observeFailure, true);
        const status = yield* fixture.supervisor.status.pipe(Effect.exit);
        expect(Exit.isFailure(status)).toBe(true);
        expect(errorOf(status)).toBeInstanceOf(ContainerEngineError);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("running");
      }),
    ),
  );

  it.live("preserves stopping recovery status when observation also fails", () =>
    run(
      Effect.gen(function* () {
        const observeFailure = yield* Ref.make(false);
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ observeFailure, stopFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        yield* Ref.set(stopFailFirst, true);
        const failedStop = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(failedStop.ok).toBe(false);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");

        yield* Ref.set(observeFailure, true);
        const status = yield* fixture.supervisor.status.pipe(Effect.exit);
        expect(Exit.isSuccess(status)).toBe(true);
        if (Exit.isSuccess(status)) {
          expect(status.value.lifecycle).toBe("stopping");
          const rest = status.value.capabilities.find(({ name }) => name === "rest");
          expect(rest?.state).toBe("failed");
          expect(rest?.error).toContain("injected stop cleanup failure");
        }

        yield* Ref.set(observeFailure, false);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
      }),
    ),
  );

  it.live("projects an observed empty workload as stopped", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(fixture.resources, []);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "database")?.state).toBe("stopped");
      }),
    ),
  );

  it.live("destroys observed remnants from an unconfigured supervisor", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Ref.set(fixture.resources, [
          { stackId: fixture.id, workloadId: "database:database", state: "ready" },
        ]);
        yield* fixture.supervisor.destroy;
        expect(yield* Ref.get(fixture.resources)).toEqual([]);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("shuts down after a start rejects missing state following destroy", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        yield* fixture.supervisor.destroy;
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();

        const failed = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackStateInvalidError);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown.pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.die("destroyed Supervisor did not shut down"),
          }),
        );
      }),
    ),
  );

  it.live("removes a runtime remnant when state disappears before supervisor initialization", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* resolveStackPaths({ stateRoot: fixture.root, stackId: fixture.id });
        yield* fixture.store.cleanup(fixture.id);
        yield* fs.makeDirectory(paths.runtime, { recursive: true });

        const failed = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "missing-state-session",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        }).pipe(Effect.exit);

        expect(errorOf(failed)).toBeInstanceOf(StackStateInvalidError);
        expect(yield* fs.exists(paths.runtime)).toBe(false);
      }),
    ),
  );

  it.live("passes log query through the Supervisor log batch", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const options: LogQuery = { capabilities: ["auth"] };
        expect((yield* fixture.supervisor.logs(options)).entries).toHaveLength(1);
        expect(yield* Ref.get(fixture.logOptions)).toEqual([undefined]);
      }),
    ),
  );

  it.live("returns filtered log batches with a running marker", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const batch = yield* fixture.supervisor.logs({ capabilities: ["auth"], tail: 20 });
        expect(batch.entries.every((entry) => entry.source === "auth")).toBe(true);
        expect(batch.running).toBe(false);
      }),
    ),
  );

  it.live("keeps running state and explicit stop guidance for changed start input", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { rest: { settings: { schemas: ["private"] } } } } })
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackMustBeStoppedError);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("running");
      }),
    ),
  );

  it.live("keeps the owner when stop cannot prove its cleanup", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(stopFailFirst, true);

        const stopped = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(stopped.ok).toBe(false);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");

        const shutdown = yield* Effect.forkChild(fixture.supervisor.shutdown, {
          startImmediately: true,
        });
        yield* fixture.supervisor.shutdownIfIdle;
        expect(shutdown.pollUnsafe()).toBeUndefined();

        const stoppedAgain = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(stoppedAgain.ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* Fiber.join(shutdown);
        expect(yield* Ref.get(fixture.resources)).toEqual([]);
      }),
    ),
  );

  it.live("requires explicit stop cleanup before starting again", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(stopFailFirst, true);
        const failedStop = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(failedStop.ok).toBe(false);

        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        yield* Ref.set(fixture.calls, []);
        const started = yield* fixture.supervisor.start();

        expect(started.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
      }),
    ),
  );

  it.live("keeps lazy capabilities dormant until explicit activation", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const status = yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { activation: "lazy" },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("dormant");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);
        const activation = yield* fixture.supervisor.activate("functions");
        expect(activation.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("ready");
      }),
    ),
  );

  it.live("preserves lazy artifact preparation failures during activation", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const artifactFailure = new ArtifactIntegrityError({
          message: "functions artifact checksum mismatch",
        });
        const baseDriver = fixture.runtime.driver;
        const driver: RuntimeDriver = {
          ...baseDriver,
          start: (key, workload) =>
            key.workloadId === "functions:edge-runtime"
              ? Effect.fail(
                  new RuntimeDriverError({
                    message: artifactFailure.message,
                    stackId: key.stackId,
                    workloadId: key.workloadId,
                    cause: artifactFailure,
                  }),
                )
              : baseDriver.start(key, workload),
        };
        const supervisor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "artifact-failure-supervisor",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: { ...fixture.runtime, driver },
        });
        yield* supervisor.start({
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { activation: "lazy" },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const result = yield* supervisor.activate("functions").pipe(Effect.exit);
        expect(errorOf(result)).toBeInstanceOf(ArtifactIntegrityError);
        yield* supervisor.maintenanceHandlers.stop;
        yield* supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdownIfIdle;
      }),
    ),
  );

  it.live("keeps accepted start work alive when its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const startGate = yield* Deferred.make<void>();
        const startStarted = yield* Deferred.make<void>();
        const startFinished = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ startGate, startStarted, startFinished });
        const config = {
          capabilities: { rest: { activation: "eager" } },
        } satisfies import("../public/Config.ts").StackConfig;
        const waiter = yield* Effect.forkChild(fixture.supervisor.start({ config }));
        yield* Deferred.await(startStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(startGate, undefined);
        yield* Deferred.await(startFinished);
        // shutdownIfIdle acquires the lifecycle admission permit, so it waits until the accepted
        // owner operation has released admission after publishing its running phase.
        yield* fixture.supervisor.shutdownIfIdle;

        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        const starts = (yield* Ref.get(fixture.calls)).filter((call) => call.startsWith("start:"));
        expect(starts).toContain("start:database:database");
        expect(starts).toContain("start:rest:rest");
      }),
    ),
  );

  it.live("shuts down after an interrupted pre-commit start later fails", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(true);
        const preflightGate = yield* Deferred.make<void>();
        const preflightStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          preflightFailFirst,
          preflightGate,
          preflightStarted,
        });
        const waiter = yield* Effect.forkChild(fixture.supervisor.start({ config: {} }));
        yield* Deferred.await(preflightStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(preflightGate, undefined);
        yield* Effect.yieldNow;
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown.pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.die("idle Supervisor did not shut down"),
          }),
        );
      }),
    ),
  );

  it.live("rejects concurrent starts even with identical input", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(true);
        const preflightGate = yield* Deferred.make<void>();
        const preflightStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          preflightFailFirst,
          preflightGate,
          preflightStarted,
        });
        const firstConfig = { capabilities: {} };
        const first = yield* Effect.forkChild(fixture.supervisor.start({ config: firstConfig }));
        yield* Deferred.await(preflightStarted);
        const second = yield* fixture.supervisor.start({ config: firstConfig }).pipe(Effect.exit);
        expect(Exit.isFailure(second)).toBe(true);
        expect(errorOf(second)).toBeInstanceOf(StackLifecycleConflictError);
        yield* Deferred.succeed(preflightGate, undefined);
        const firstExit = yield* Fiber.join(first).pipe(Effect.exit);
        expect(Exit.isFailure(firstExit)).toBe(true);
        expect(yield* Ref.get(preflightFailFirst)).toBe(false);
      }),
    ),
  );

  it.live("does not join concurrent starts with distinct secret values", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(true);
        const preflightGate = yield* Deferred.make<void>();
        const preflightStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          preflightFailFirst,
          preflightGate,
          preflightStarted,
        });
        const firstConfig = {
          security: {
            jwt: { signing: { kind: "symmetric" as const, secret: Redacted.make("a") } },
          },
        };
        const distinctConfig = {
          security: {
            jwt: { signing: { kind: "symmetric" as const, secret: Redacted.make("b") } },
          },
        };
        const first = yield* Effect.forkChild(fixture.supervisor.start({ config: firstConfig }));
        yield* Deferred.await(preflightStarted);
        const secondExit = yield* fixture.supervisor
          .start({ config: distinctConfig })
          .pipe(Effect.exit);
        expect(Exit.isFailure(secondExit)).toBe(true);
        expect(errorOf(secondExit)).toBeInstanceOf(StackLifecycleConflictError);
        yield* Deferred.succeed(preflightGate, undefined);
        const firstExit = yield* Fiber.join(first).pipe(Effect.exit);
        expect(Exit.isFailure(firstExit)).toBe(true);
      }),
    ),
  );

  it.live("single-flights lazy activation and retains its endpoint", () =>
    run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const activationCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          activationGate: gate,
          activationStarted: started,
          activationCalls,
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { activation: "lazy" },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const first = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.succeed(gate, undefined);
        const [left, right] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(left).toEqual(right);
        expect(yield* Ref.get(activationCalls)).toBe(1);
        expect(yield* fixture.supervisor.activate("functions")).toEqual(left);
        expect(yield* Ref.get(activationCalls)).toBe(1);
      }),
    ),
  );

  it.live("keeps a ready capability while concurrent endpoint lookup is shared", () =>
    run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const activationCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          activationGate: gate,
          activationStarted,
          activationCalls,
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { activation: "eager" },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("ready");
        const first = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.await(activationStarted);
        const second = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("ready");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Ref.get(activationCalls)).toBe(1);
      }),
    ),
  );

  it.live("reuses a ready lazy activation without rereading durable state", () =>
    run(
      Effect.gen(function* () {
        const readCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({ readCalls });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              functions: { activation: "lazy" },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        yield* Ref.set(readCalls, 0);

        yield* fixture.supervisor.activate("functions");
        const afterFirst = yield* Ref.get(readCalls);
        yield* fixture.supervisor.activate("functions");

        expect(yield* Ref.get(readCalls)).toBe(afterFirst);
      }),
    ),
  );

  it.live("keeps activated lazy workloads ready across an idempotent start", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const config = {
          capabilities: {
            rest: { enabled: false },
            auth: { enabled: false },
            realtime: { enabled: false },
            storage: { enabled: false },
            functions: { activation: "lazy" as const },
            studio: { enabled: false },
            mail: { enabled: false },
            analytics: { enabled: false },
            pooler: { enabled: false },
          },
        };
        yield* fixture.supervisor.start({ config });
        yield* fixture.supervisor.activate("functions");
        yield* Ref.set(fixture.calls, []);

        const status = yield* fixture.supervisor.start({ config });

        expect(yield* Ref.get(fixture.calls)).toEqual([]);
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("ready");
      }),
    ),
  );

  it.live("keeps a dependency ready when its overlapping endpoint activation fails", () =>
    run(
      Effect.gen(function* () {
        const startStarted = yield* Deferred.make<void>();
        const startGate = yield* Deferred.make<void>();
        const activationCalls = yield* Ref.make(0);
        const activationStartedAfterFirst = yield* Deferred.make<void>();
        const activationGateAfterFirst = yield* Deferred.make<void>();
        const activationFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({
          startStarted,
          startGate,
          startWorkload: "rest:rest",
          activationCalls,
          activationStartedAfterFirst,
          activationGateAfterFirst,
          activationFailFirst,
        });
        const config = {
          capabilities: {
            rest: { activation: "lazy" as const },
            studio: { activation: "lazy" as const },
          },
        };
        yield* fixture.supervisor.start({ config });
        const studio = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(startStarted);
        const rest = yield* Effect.forkChild(fixture.supervisor.activate("rest"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(startGate, undefined);
        yield* Deferred.await(activationStartedAfterFirst);
        expect(yield* Ref.get(activationCalls)).toBe(2);
        yield* Ref.set(activationFailFirst, true);
        yield* Deferred.succeed(activationGateAfterFirst, undefined);

        const studioResult = yield* Fiber.join(studio).pipe(Effect.exit);
        const restResult = yield* Fiber.join(rest).pipe(Effect.exit);
        expect(Exit.isSuccess(studioResult)).toBe(true);
        expect(errorOf(restResult)).toBeInstanceOf(GatewayActivationError);
        expect(yield* Ref.get(fixture.resources)).toContainEqual(
          expect.objectContaining({ workloadId: "rest:rest", state: "ready" }),
        );
        expect(yield* Ref.get(fixture.resources)).toContainEqual(
          expect.objectContaining({ workloadId: "studio:pgmeta", state: "ready" }),
        );
        const status = yield* fixture.supervisor.status;
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        expect(status.capabilities.find(({ name }) => name === "studio")?.state).toBe("ready");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live(
    "reports a post-ready workload failure without restarting it or stopping unrelated services",
    () =>
      run(
        Effect.gen(function* () {
          const starts = yield* Queue.unbounded<string>();
          const fixture = yield* makeFixture({ startQueue: starts });
          yield* fixture.supervisor.start({
            config: { capabilities: { rest: { activation: "eager" } } },
          });
          yield* Queue.take(starts);
          yield* Queue.take(starts);
          yield* Ref.set(fixture.calls, []);
          yield* Ref.update(fixture.resources, (current) =>
            current.map((entry) =>
              entry.workloadId === "database:database"
                ? { ...entry, state: "failed" as const, error: "crashed" }
                : entry,
            ),
          );
          const status = yield* fixture.supervisor.status;
          expect(status.capabilities.find(({ name }) => name === "database")?.state).toBe("failed");
          expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
          expect(yield* Ref.get(fixture.calls)).toEqual([]);
        }),
      ),
  );

  it.live("allows a failed activation to retry", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const activationCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({ activationFailFirst, activationCalls });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        const retry = yield* fixture.supervisor.activate("functions");
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(yield* Ref.get(activationCalls)).toBe(2);
        expect(
          (yield* Ref.get(fixture.calls)).filter((call) => call === "start:functions:edge-runtime"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.live("reports a failed lazy activation as dormant until it is retried", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const fixture = yield* makeFixture({ startFailures });
        yield* fixture.supervisor.start({ config: { capabilities: { functions: {} } } });

        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("dormant");
        const retry = yield* fixture.supervisor.activate("functions");
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("ready");
        expect(
          (yield* Ref.get(fixture.calls)).filter((call) => call === "start:functions:edge-runtime"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.live("rolls back a lazy launch when ingress opening fails", () =>
    run(
      Effect.gen(function* () {
        const openCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
                ownershipToken: Symbol(),
              }),
            open: () =>
              Ref.updateAndGet(openCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2
                    ? Effect.fail(new GatewayActivationError({ message: "injected open failure" }))
                    : Effect.void,
                ),
              ),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* Ref.get(fixture.resources)).toEqual([
          expect.objectContaining({ workloadId: "database:database", state: "ready" }),
        ]);
        yield* fixture.supervisor.activate("functions");
        expect(
          (yield* Ref.get(fixture.calls)).filter((call) => call === "start:functions:edge-runtime"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.live("fences fresh ingress when open failure cleanup is not proven", () =>
    run(
      Effect.gen(function* () {
        const openCalls = yield* Ref.make(0);
        const closeFailures = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
                ownershipToken: Symbol(),
              }),
            open: () =>
              Ref.updateAndGet(openCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2
                    ? Effect.fail(new GatewayActivationError({ message: "injected open failure" }))
                    : Effect.void,
                ),
              ),
            close: Effect.gen(function* () {
              const remaining = yield* Ref.get(closeFailures);
              if (remaining > 0) {
                yield* Ref.set(closeFailures, remaining - 1);
                return yield* new StackCleanupError({ message: "injected close failure" });
              }
            }),
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        yield* Ref.set(closeFailures, 1);
        expect(
          Exit.isFailure(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBe(true);
        expect(yield* Ref.get(fixture.resources)).toEqual([
          expect.objectContaining({ workloadId: "database:database", state: "ready" }),
        ]);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("rolls back fresh ingress after activation failure and retries", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const openCalls = yield* Ref.make(0);
        const closeCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          activationFailFirst,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
                ownershipToken: Symbol(),
              }),
            open: () => Ref.update(openCalls, (count) => count + 1),
            close: Ref.update(closeCalls, (count) => count + 1),
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        expect(
          Exit.isFailure(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBe(true);
        expect(yield* Ref.get(closeCalls)).toBe(2);
        expect(yield* Ref.get(fixture.resources)).toEqual([
          expect.objectContaining({ workloadId: "database:database", state: "ready" }),
        ]);
        const retry = yield* fixture.supervisor.activate("functions");
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(yield* Ref.get(openCalls)).toBe(3);
      }),
    ),
  );

  it.live("fences the owner when lazy rollback cannot be proven", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const workloadStopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ activationFailFirst, workloadStopFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          errorOf(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBeInstanceOf(StackLifecycleConflictError);
        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown;
        const successor = yield* makeSupervisor({
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        yield* Ref.set(fixture.calls, []);
        const restarted = yield* successor.start().pipe(Effect.exit);
        expect(Exit.isSuccess(restarted)).toBe(true);
        if (Exit.isSuccess(restarted)) expect(restarted.value.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
        expect((yield* successor.maintenanceHandlers.stop).ok).toBe(true);
      }),
    ),
  );

  it.live("fences a lazy activation when endpoint rollback removal fails", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const workloadRemoveFailFirst = yield* Ref.make(true);
        const activationStarted = yield* Deferred.make<void>();
        const activationGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          activationFailFirst,
          activationStarted,
          activationGate,
          workloadRemoveFailFirst,
          workloadRemoveFailWorkload: "rest:rest",
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { activation: "lazy" },
              studio: { activation: "lazy" },
            },
          },
        });
        const activation = yield* Effect.forkChild(fixture.supervisor.activate("studio"), {
          startImmediately: true,
        });
        yield* Deferred.await(activationStarted);
        expect(yield* Ref.get(fixture.resources)).toContainEqual(
          expect.objectContaining({ workloadId: "rest:rest", state: "ready" }),
        );
        yield* Deferred.succeed(activationGate, undefined);
        const failed = yield* Fiber.join(activation).pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(GatewayActivationError);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* Ref.get(fixture.resources)).toContainEqual(
          expect.objectContaining({ workloadId: "rest:rest", state: "stopped" }),
        );
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "rest")
            ?.state,
        ).toBe("failed");
        expect(
          errorOf(yield* fixture.supervisor.activate("rest").pipe(Effect.exit)),
        ).toBeInstanceOf(StackLifecycleConflictError);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("fences the owner when lazy rollback remove fails", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const workloadRemoveFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ activationFailFirst, workloadRemoveFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("validates lifecycle before cached lazy activation results", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(false);
        const workloadRemoveFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ activationFailFirst, workloadRemoveFailFirst });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              functions: { activation: "lazy" },
              auth: { activation: "lazy" },
            },
          },
        });
        yield* fixture.supervisor.activate("functions");
        yield* Ref.set(activationFailFirst, true);
        yield* Ref.set(workloadRemoveFailFirst, true);
        expect(Exit.isFailure(yield* fixture.supervisor.activate("auth").pipe(Effect.exit))).toBe(
          true,
        );
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          errorOf(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBeInstanceOf(StackLifecycleConflictError);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect(
          errorOf(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBeInstanceOf(StackNotRunningError);
      }),
    ),
  );

  it.live("rejects activation while an explicit lifecycle transition is active", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: {}, functions: { activation: "lazy" } } },
        });

        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        const activation = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(errorOf(activation)).toBeInstanceOf(StackLifecycleConflictError);

        yield* Deferred.succeed(stopGate, undefined);
        yield* Fiber.join(stopping);
      }),
    ),
  );

  it.live("fences activation against a concurrent stop", () =>
    run(
      Effect.gen(function* () {
        const activationGate = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ activationGate, activationStarted });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const activation = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.await(activationStarted);
        const stop = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.succeed(activationGate, undefined);
        yield* Fiber.join(activation);
        yield* Fiber.join(stop);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopped");
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("stopped");
      }),
    ),
  );

  it.live("stops cleanly when stop is queued during activation", () =>
    run(
      Effect.gen(function* () {
        const activationStarted = yield* Deferred.make<void>();
        const activationGate = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          activationStarted,
          activationGate,
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const activation = yield* Effect.forkChild(fixture.supervisor.activate("functions"), {
          startImmediately: true,
        });
        yield* Deferred.await(activationStarted).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop, {
          startImmediately: true,
        });
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");

        yield* Deferred.succeed(activationGate, undefined);
        expect(Exit.isSuccess(yield* Fiber.join(activation).pipe(Effect.exit))).toBe(true);
        expect((yield* Fiber.join(stopping)).ok).toBe(true);

        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopped");
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("stopped");
      }),
    ),
  );

  it.live("completes accepted stop after its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const waiter = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(stopGate, undefined);
        yield* Effect.yieldNow;
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown;
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("completes accepted destroy after its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const destroyGate = yield* Deferred.make<void>();
        const destroyStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ destroyGate, destroyStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const waiter = yield* Effect.forkChild(fixture.supervisor.destroy);
        yield* Deferred.await(destroyStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(destroyGate, undefined);
        yield* Effect.yieldNow;
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown;
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );
});
