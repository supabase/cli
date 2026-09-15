import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  FiberSet,
  Match,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Semaphore,
  Scope,
} from "effect";
import { rebuildExecutionPlan } from "../model/Compiler.ts";
import {
  activeExecutionPlan,
  dependencyClosure,
  eagerCapabilities,
  type ExecutionPlan,
} from "../model/ExecutionPlan.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { StackConfig } from "../public/Config.ts";
import {
  GatewayActivationError,
  ContainerEngineError,
  InvalidLogCursorError,
  StackLifecycleConflictError,
  StackNotRunningError,
  StackRuntimeError,
  StackCleanupError,
  StackStateInvalidError,
  isStackError,
  isStackErrorTag,
  type StackErrorTag,
  type StackError,
} from "../public/Errors.ts";
import type { ArtifactPreparationStatus, StackStatus } from "../public/Status.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogQuery, StackLogBatch } from "../public/Logs.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import {
  RuntimeDriverError,
  type ObservedWorkload,
  type RuntimeDriver,
} from "../runtime/RuntimeDriver.ts";
import { withLeftoverPersistentDataGuidance } from "../runtime/Diagnostics.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { isMissingStateRemnantError, type StackStateStore } from "../state/StackStateStore.ts";
import {
  makeSessionLauncher,
  SessionCleanupError,
  type SessionCleanupOutcome,
  type SessionLaunchOutcome,
  type SessionLauncher,
} from "./SessionLauncher.ts";
import {
  makeLifecycleController,
  type CleanupOutcome,
  type LifecycleLaunchResult,
  type LifecycleBackend,
  type LifecycleInput,
} from "./Lifecycle.ts";
import { EMPTY_LOG_CURSOR, selectLogBatch, type LogStore } from "./LogStore.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import {
  STACK_RPC_RELEASE,
  StackRpcGroup,
  type StackRpcError,
  type StackRpcHandlers,
} from "../control/StackRpc.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";
import { statusForSnapshot, type ActualPhase, type ObservedStatus } from "./StatusProjection.ts";
import {
  publicPhase,
  command,
  isTransitioning,
  recoveryForState,
  type LifecycleKind,
  type SupervisorSnapshot,
} from "./SupervisorState.ts";
import {
  beginStarting,
  beginStopping,
  cleanupFailed,
  completeStarting,
  dormant,
  dormantFromReady,
  promoteStartingPrior,
  ready,
  restoreStarting,
  type CapabilityState,
} from "./CapabilityState.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
  DATABASE_INTERNAL_PASSWORD_SLOT,
} from "../state/SecretStore.ts";

import type { ActivationResult } from "../gateway/Gateway.ts";
import { makeGatewayActivity } from "../gateway/ActivityTracker.ts";
import {
  settleActivationOwner,
  settleLifecycleOwner,
  settleRetirementOwner,
  stopRecoverySnapshot,
  type ActivationOwner,
  type ActivationExit,
  type CommandResult,
  type EndpointExit,
  matchesActivationOwner,
  type SettlementOwner,
} from "./OperationSettlement.ts";

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
  readonly preflight: (input: LifecycleInput) => Effect.Effect<void, StackError>;
  /** Prepares artifacts before launching a newly selected workload closure. */
  readonly prepare: (
    input: LifecycleInput,
    selected: ReadonlySet<CapabilityName>,
  ) => Effect.Effect<void, StackError>;
  /** Best-effort preparation of lazy artifacts after a stack reaches running. */
  readonly prefetch: (state: PersistedStackState) => Effect.Effect<void>;
  /** Current in-memory preparation state; completed cache entries outlive the session. */
  readonly artifacts: Effect.Effect<ReadonlyArray<ArtifactPreparationStatus>>;
  readonly activate: (
    capability: CapabilityName,
    input: LifecycleInput,
  ) => Effect.Effect<ActivationResult["endpoint"], GatewayActivationError | StackError>;
  /** Supervisor-owned public ingress and lazy route activation lifecycle. */
  readonly ingress: SupervisorIngress;
  readonly logStore: LogStore;
}

export interface Supervisor {
  readonly status: Effect.Effect<StackStatus, StackError>;
  readonly start: (options?: {
    readonly config?: StackConfig;
  }) => Effect.Effect<StackStatus, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  /** Wipes Postgres data for the running stack and bootstraps a fresh cluster. */
  readonly resetDatabase: Effect.Effect<StackStatus, StackError>;
  /** Completes after a successful stop or destroy shutdown signal. */
  readonly shutdown: Effect.Effect<void>;
  /** Shuts down only when durable state is absent or cleanly non-running. */
  readonly shutdownIfIdle: Effect.Effect<void>;
  readonly logs: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackError>;
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
  readonly maintenanceHandlers: {
    readonly probe: Effect.Effect<MaintenanceResponse>;
    readonly stop: Effect.Effect<MaintenanceResponse>;
  };
  readonly rpcHandlers: StackRpcHandlers;
}

export type SupervisorOptions = {
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
  readonly runtime: SupervisorRuntime;
};

const RESET_DATABASE_BOUNCE_CAPABILITIES: ReadonlySet<CapabilityName> = new Set([
  "auth",
  "storage",
  "realtime",
  "pooler",
  "analytics",
]);

const rpcError = (tag: StackRpcError["tag"], message: string): StackRpcError => ({ tag, message });
const credentialsUnavailable = rpcError(
  "StackNotRunningError",
  "Stack credentials are unavailable",
);
const stateErrorMessage = (error: StackError | { readonly message?: string }): string =>
  typeof error.message === "string" ? error.message : "Stack operation failed";

const sessionCleanupMessage = (error: SessionCleanupError): string => {
  const failure = Cause.findErrorOption(error.cause);
  if (Option.isSome(failure)) {
    if (failure.value instanceof RuntimeDriverError) {
      const workload =
        failure.value.workloadId === undefined ? "" : ` for ${failure.value.workloadId}`;
      return `Session cleanup is unresolved${workload}: ${failure.value.message}`;
    }
    return sessionCleanupMessage(failure.value);
  }
  const details = Cause.pretty(error.cause);
  return details.length === 0
    ? "Session cleanup is unresolved"
    : `Session cleanup is unresolved: ${details}`;
};

const credentialHost = (address: string): string =>
  address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;

const mapRuntimeError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  if (error instanceof ContainerEngineError) return error;
  if (error instanceof RuntimeDriverError && isStackError(error.cause)) return error.cause;
  if (error instanceof SessionCleanupError)
    return new StackCleanupError({ message: sessionCleanupMessage(error), cause: error });
  return new StackRuntimeError({
    message: withLeftoverPersistentDataGuidance(
      error instanceof Error ? error.message : String(error),
    ),
    cause: error,
  });
};

const mapCleanupError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  if (error instanceof SessionCleanupError)
    return new StackCleanupError({ message: sessionCleanupMessage(error), cause: error });
  return new StackCleanupError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const combineCleanupOutcome = (left: CleanupOutcome, right: CleanupOutcome): CleanupOutcome =>
  Predicate.isTagged(left, "proven") && Predicate.isTagged(right, "proven")
    ? { _tag: "proven" }
    : {
        _tag: "unproven",
        cause: Cause.combine(
          Predicate.isTagged(left, "unproven") ? left.cause : Cause.empty,
          Predicate.isTagged(right, "unproven") ? right.cause : Cause.empty,
        ),
      };

const rpcTag = (error: StackError): StackRpcError["tag"] => error._tag;
const maintenanceStackErrorTag = (error: unknown): StackErrorTag | undefined =>
  Predicate.hasProperty(error, "_tag") &&
  typeof error._tag === "string" &&
  isStackErrorTag(error._tag)
    ? error._tag
    : undefined;

/** Compose one owner process around the durable lifecycle controller and a runtime driver. */
export const makeSupervisor = (
  options: SupervisorOptions,
): Effect.Effect<Supervisor, StackError, Scope.Scope> =>
  Effect.gen(function* () {
    const read = () =>
      options.stateStore.read(options.stackId).pipe(Effect.provideContext(options.context));
    const initial = yield* read().pipe(
      Effect.catchIf(isMissingStateRemnantError, () =>
        options.stateStore
          .recoverRuntimeRemnant(options.stackId)
          .pipe(Effect.provideContext(options.context), Effect.asVoid),
      ),
    );
    if (initial === undefined)
      return yield* new StackStateInvalidError({ message: "Stack state is missing" });
    const runtime = options.runtime;
    const launcher: SessionLauncher = yield* makeSessionLauncher({
      stackId: options.stackId,
      driver: runtime.driver,
    });
    const machine = yield* Ref.make<SupervisorSnapshot>({
      stack:
        initial.desiredLifecycle === "destroying"
          ? { _tag: "destroy-required", evidence: { _tag: "persisted-intent" } }
          : { _tag: "stopped", session: "uninitialized" },
      sessionId: Symbol("stack-session"),
      plan: undefined,
      capabilities: new Map(),
    });
    const currentPhase = (): Effect.Effect<ActualPhase> =>
      Ref.get(machine).pipe(Effect.map((snapshot) => publicPhase(snapshot.stack)));
    type LifecycleResult = Deferred.Deferred<Exit.Exit<void, StackError>, never>;
    type ActiveLifecycle = Readonly<{ kind: LifecycleKind; result: LifecycleResult }>;
    const activeCommand = (): Effect.Effect<ActiveLifecycle | undefined> =>
      Ref.get(machine).pipe(
        Effect.map(({ stack }) =>
          Match.value(stack).pipe(
            Match.tag("starting", "start-recovery", (state) => ({
              kind: "start" as const,
              result: state.completion,
            })),
            Match.when({ _tag: "stopping" }, (state) => ({
              kind: "stop" as const,
              result: state.completion,
            })),
            Match.when({ _tag: "destroying" }, (state) => ({
              kind: "destroy" as const,
              result: state.completion,
            })),
            Match.tag("stopped", "running", "stop-required", "destroy-required", () => undefined),
            Match.exhaustive,
          ),
        ),
      );
    type ActivationHandler = (
      capability: CapabilityName,
    ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
    // The ingress opens during an explicit lifecycle operation. A one-shot handoff keeps a request
    // waiting for the handler instead of exposing a construction-time race.
    const activationHandler = yield* Deferred.make<ActivationHandler, never>();
    const initializeActivationInAdmission = (input: LifecycleInput) =>
      Effect.gen(function* () {
        const { plan } = input;
        const roots = new Set(
          CAPABILITY_NAMES.filter(
            (name) =>
              input.definition.capabilities[name].enabled && plan.activation[name] === "eager",
          ),
        );
        const eager = eagerCapabilities(plan);
        const startupCompletions = new Map<
          CapabilityName,
          Deferred.Deferred<Exit.Exit<void, StackError>, never>
        >();
        for (const name of eager)
          startupCompletions.set(name, yield* Deferred.make<Exit.Exit<void, StackError>, never>());
        yield* Ref.update(machine, (snapshot) => {
          const sessionId = Symbol("stack-session");
          const capabilities = new Map<CapabilityName, CapabilityState>();
          for (const name of CAPABILITY_NAMES) {
            const configured = input.definition.capabilities[name];
            if (!configured.enabled) capabilities.set(name, { _tag: "disabled" });
            else if (eager.has(name)) {
              const completion = startupCompletions.get(name);
              if (completion === undefined) capabilities.set(name, dormant(sessionId));
              else
                capabilities.set(
                  name,
                  beginStarting(
                    dormant(sessionId),
                    Symbol("startup"),
                    { _tag: "workload", deferred: completion },
                    roots.has(name),
                  ),
                );
            } else capabilities.set(name, dormant(sessionId));
          }
          return { ...snapshot, sessionId, plan, capabilities };
        });
        yield* Ref.set(
          idleTimeouts,
          new Map(
            CAPABILITY_NAMES.map((name) => [
              name,
              input.definition.capabilities[name].idleTimeoutSeconds,
            ]),
          ),
        );
      });
    const initializeActivation = (input: LifecycleInput) =>
      admission.withPermit(initializeActivationInAdmission(input));
    const resetForSession = (input: LifecycleInput) => initializeActivation(input);
    const observe = () =>
      runtime.driver.observe(options.stackId).pipe(Effect.mapError(mapRuntimeError));
    const observedForStatus = () =>
      Ref.get(machine).pipe(
        Effect.flatMap(({ stack }) => {
          const available = (workloads: ReadonlyArray<ObservedWorkload>): ObservedStatus => ({
            _tag: "available",
            workloads,
          });
          const fallback: Effect.Effect<ObservedStatus> = observe().pipe(
            Effect.map(available),
            Effect.orElseSucceed(() => ({ _tag: "unavailable" as const })),
          );
          return Match.value(stack).pipe(
            Match.when({ _tag: "stopped" }, () => Effect.succeed(available([]))),
            Match.when({ _tag: "running" }, () => observe().pipe(Effect.map(available))),
            Match.when({ _tag: "starting", prior: { _tag: "running" } }, () =>
              observe().pipe(Effect.map(available)),
            ),
            Match.when({ _tag: "starting" }, () => fallback),
            Match.when({ _tag: "stopping" }, () => fallback),
            Match.when({ _tag: "destroying" }, () => fallback),
            Match.when({ _tag: "stop-required" }, () => fallback),
            Match.when({ _tag: "start-recovery" }, () => fallback),
            Match.when({ _tag: "destroy-required" }, () => fallback),
            Match.exhaustive,
          );
        }),
      );

    const snapshot = (): Effect.Effect<StackStatus, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const status = yield* statusForSnapshot(
          options.stackId,
          state,
          yield* observedForStatus(),
          yield* Ref.get(machine),
          yield* runtime.artifacts,
        );
        return status;
      });

    // Admission rejects every overlapping lifecycle operation while execution serializes
    // lifecycle and activation work against runtime access.
    const admission = yield* Semaphore.make(1);
    // Activation and lifecycle operations share one execution gate so they cannot race cleanup.
    const execution = yield* Semaphore.make(1);
    const supervisorScope = yield* Effect.scope;
    const ownedFibers = yield* FiberSet.make().pipe(
      Effect.provideService(Scope.Scope, supervisorScope),
    );
    const backgroundPreparation = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
    const startBackgroundPreparation = (state: PersistedStackState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(backgroundPreparation);
        if (existing !== undefined) return;
        const fiber = yield* Effect.forkIn(runtime.prefetch(state), supervisorScope, {
          startImmediately: true,
        });
        yield* Ref.set(backgroundPreparation, fiber);
      });
    const joinExit = <A, E>(result: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause);
    const idleTimeouts = yield* Ref.make<ReadonlyMap<CapabilityName, number | false>>(new Map());

    const readySet = (): Effect.Effect<ReadonlySet<CapabilityName>> =>
      Ref.get(machine).pipe(
        Effect.map(
          (snapshot) =>
            new Set(
              [...snapshot.capabilities].flatMap(([name, state]) =>
                Predicate.isTagged(state, "ready") ? [name] : [],
              ),
            ),
        ),
      );
    const selectedSet = (): Effect.Effect<ReadonlySet<CapabilityName>> =>
      Ref.get(machine).pipe(
        Effect.map(
          (snapshot) =>
            new Set(
              [...snapshot.capabilities].flatMap(([name, state]) =>
                Predicate.isTagged(state, "ready") || Predicate.isTagged(state, "starting")
                  ? [name]
                  : [],
              ),
            ),
        ),
      );
    const rootSet = (): Effect.Effect<ReadonlySet<CapabilityName>> =>
      Ref.get(machine).pipe(
        Effect.map(
          (snapshot) =>
            new Set(
              [...snapshot.capabilities].flatMap(([name, state]) =>
                "root" in state && state.root ? [name] : [],
              ),
            ),
        ),
      );
    const planValue = (): Effect.Effect<ExecutionPlan | undefined> =>
      Ref.get(machine).pipe(Effect.map((snapshot) => snapshot.plan));
    const setReadySetInAdmission = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const capabilities = new Map(snapshot.capabilities);
        const completions: Array<Deferred.Deferred<Exit.Exit<void, StackError>, never>> = [];
        for (const [name, state] of capabilities) {
          if (Predicate.isTagged(state, "dormant") && names.has(name))
            capabilities.set(name, ready(state.sessionId, state.traffic, state.root));
          else if (
            Predicate.isTagged(state, "starting") &&
            Predicate.isTagged(state.completion, "workload") &&
            names.has(name)
          ) {
            completions.push(state.completion.deferred);
            capabilities.set(name, completeStarting(state));
          }
        }
        yield* Ref.set(machine, { ...snapshot, capabilities });
        yield* Effect.forEach(
          completions,
          (completion) => Deferred.succeed(completion, Exit.void),
          {
            discard: true,
          },
        );
      });
    const setReadySet = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      admission.withPermit(setReadySetInAdmission(names));
    const promoteActivationSet = (
      names: ReadonlySet<CapabilityName>,
      activationOwner: CapabilityName,
    ): Effect.Effect<void> =>
      admission.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(machine);
          const capabilities = new Map(snapshot.capabilities);
          for (const name of names) {
            const state = capabilities.get(name);
            if (
              name !== activationOwner &&
              Predicate.isTagged(state, "starting") &&
              Predicate.isTagged(state.completion, "activation")
            )
              capabilities.set(name, promoteStartingPrior(state));
          }
          yield* Ref.set(machine, { ...snapshot, capabilities });
        }),
      );
    type ClaimedWorkload = Readonly<{
      readonly name: CapabilityName;
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly prior: Extract<CapabilityState, { readonly _tag: "dormant" }>;
    }>;
    const claimWorkloads = (
      names: ReadonlySet<CapabilityName>,
    ): Effect.Effect<ReadonlyArray<ClaimedWorkload>> =>
      admission.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(machine);
          const capabilities = new Map(snapshot.capabilities);
          const claimed: Array<ClaimedWorkload> = [];
          for (const name of names) {
            const current = capabilities.get(name);
            if (!Predicate.isTagged(current, "dormant")) continue;
            const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
            claimed.push({ name, completion, prior: current });
            capabilities.set(
              name,
              beginStarting(current, Symbol("dependency-startup"), {
                _tag: "workload",
                deferred: completion,
              }),
            );
          }
          yield* Ref.set(machine, { ...snapshot, capabilities });
          return claimed;
        }),
      );
    const restoreActivationFailureInAdmission = (
      capability: CapabilityName,
      claimed: ReadonlyArray<ClaimedWorkload>,
      affected: ReadonlySet<CapabilityName>,
      result: Exit.Exit<void, StackError>,
      cleanup: CleanupOutcome,
      activationPriorRoot?: boolean,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const capabilities = new Map(snapshot.capabilities);
        const completions: Array<Deferred.Deferred<Exit.Exit<void, StackError>, never>> = [];
        const activationCompletions: Array<Effect.Effect<void>> = [];
        for (const entry of claimed) {
          const current = capabilities.get(entry.name);
          if (
            Predicate.isTagged(current, "starting") &&
            Predicate.isTagged(current.completion, "workload") &&
            current.completion.deferred === entry.completion
          ) {
            capabilities.set(
              entry.name,
              Predicate.isTagged(cleanup, "unproven")
                ? cleanupFailed(current, cleanup.cause)
                : dormant(entry.prior.sessionId, current.traffic, entry.prior.root),
            );
            completions.push(entry.completion);
          } else if (Predicate.isTagged(current, "ready")) {
            capabilities.set(
              entry.name,
              Predicate.isTagged(cleanup, "unproven")
                ? cleanupFailed(current, cleanup.cause)
                : dormantFromReady(current),
            );
          }
        }
        if (Predicate.isTagged(cleanup, "unproven"))
          for (const name of affected) {
            if (name === capability) continue;
            const current = capabilities.get(name);
            if (
              !Predicate.isTagged(current, "starting") ||
              !Predicate.isTagged(current.completion, "activation")
            )
              continue;
            capabilities.set(name, cleanupFailed(current, cleanup.cause));
            activationCompletions.push(
              Deferred.succeed(current.completion.deferred, Exit.failCause(cleanup.cause)),
            );
          }
        const currentRoot = capabilities.get(capability);
        const savedActivationRoot =
          Predicate.isTagged(currentRoot, "starting") &&
          Predicate.isTagged(currentRoot.completion, "activation")
            ? currentRoot.prior.root
            : activationPriorRoot;
        if (
          Predicate.isTagged(currentRoot, "starting") &&
          Predicate.isTagged(currentRoot.completion, "activation")
        )
          capabilities.set(
            capability,
            Predicate.isTagged(cleanup, "unproven")
              ? cleanupFailed(currentRoot, cleanup.cause)
              : restoreStarting(currentRoot),
          );
        if (Predicate.isTagged(currentRoot, "ready") && savedActivationRoot !== undefined)
          capabilities.set(capability, { ...currentRoot, root: savedActivationRoot });
        const next = Predicate.isTagged(cleanup, "unproven")
          ? stopRecoverySnapshot({ ...snapshot, capabilities }, cleanup.cause)
          : { ...snapshot, capabilities };
        yield* Ref.set(machine, next);
        yield* Effect.forEach(completions, (completion) => Deferred.succeed(completion, result), {
          discard: true,
        });
        yield* Effect.forEach(activationCompletions, (completion) => completion, {
          discard: true,
        });
      });
    const restoreActivationFailure = (
      capability: CapabilityName,
      claimed: ReadonlyArray<ClaimedWorkload>,
      affected: ReadonlySet<CapabilityName>,
      result: Exit.Exit<void, StackError>,
      cleanup: CleanupOutcome,
      activationPriorRoot?: boolean,
    ): Effect.Effect<void, never> =>
      admission.withPermit(
        restoreActivationFailureInAdmission(
          capability,
          claimed,
          affected,
          result,
          cleanup,
          activationPriorRoot,
        ),
      );
    const setRootSetInAdmission = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      Ref.update(machine, (snapshot) => {
        const capabilities = new Map(snapshot.capabilities);
        for (const [name, state] of capabilities) {
          capabilities.set(
            name,
            Match.value(state).pipe(
              Match.tag("disabled", "stopped", (value) => value),
              Match.tag("dormant", "starting", "ready", "stopping", "cleanup-failed", (value) => ({
                ...value,
                root: names.has(name),
              })),
              Match.exhaustive,
            ),
          );
        }
        return { ...snapshot, capabilities };
      });
    const setRootSet = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      admission.withPermit(setRootSetInAdmission(names));
    const updateCapability = (
      name: CapabilityName,
      update: (
        state: CapabilityState | undefined,
        sessionId: symbol,
      ) => CapabilityState | undefined,
    ): Effect.Effect<void> =>
      Ref.update(machine, (snapshot) => {
        const capabilities = new Map(snapshot.capabilities);
        const next = update(capabilities.get(name), snapshot.sessionId);
        if (next === undefined) capabilities.delete(name);
        else capabilities.set(name, next);
        return { ...snapshot, capabilities };
      });
    const enterCapabilityCleanupInAdmission = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const capabilities = new Map(snapshot.capabilities);
        for (const [name, state] of capabilities) {
          if (!Predicate.isTagged(state, "ready") && !Predicate.isTagged(state, "cleanup-failed"))
            continue;
          const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
          capabilities.set(name, beginStopping(state, Symbol("cleanup"), completion));
        }
        yield* Ref.set(machine, { ...snapshot, capabilities });
      });
    const settleCapabilityCleanupInAdmission = (
      result: Exit.Exit<void, StackError>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const capabilities = new Map(snapshot.capabilities);
        const completions: Array<Deferred.Deferred<Exit.Exit<void, StackError>, never>> = [];
        for (const [name, state] of capabilities) {
          if (!Predicate.isTagged(state, "stopping")) continue;
          const next: CapabilityState = Exit.isSuccess(result)
            ? { _tag: "stopped" }
            : cleanupFailed(state, result.cause);
          capabilities.set(name, next);
          completions.push(state.completion);
        }
        yield* Ref.set(machine, { ...snapshot, capabilities });
        yield* Effect.forEach(completions, (completion) => Deferred.succeed(completion, result), {
          discard: true,
        });
      });
    const enterCapabilityCleanup = (): Effect.Effect<void> =>
      admission.withPermit(enterCapabilityCleanupInAdmission());
    const settleCapabilityCleanup = (result: Exit.Exit<void, StackError>): Effect.Effect<void> =>
      admission.withPermit(settleCapabilityCleanupInAdmission(result));
    const completeDormantCleanupInAdmission = (): Effect.Effect<void> =>
      Ref.update(machine, (snapshot) => {
        const capabilities = new Map(snapshot.capabilities);
        for (const [name, state] of capabilities)
          if (Predicate.isTagged(state, "dormant")) capabilities.set(name, { _tag: "stopped" });
        return { ...snapshot, capabilities };
      });
    const completeDormantCleanup = (): Effect.Effect<void> =>
      admission.withPermit(completeDormantCleanupInAdmission());
    const settleStartupFailures = (
      cause: Cause.Cause<StackError>,
      cleanup: CleanupOutcome,
      durable: "stopped" | "unsafe",
    ): Effect.Effect<void> =>
      admission.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(machine);
          const capabilities = new Map(snapshot.capabilities);
          const completions: Array<Deferred.Deferred<Exit.Exit<void, StackError>, never>> = [];
          for (const [name, state] of capabilities) {
            if (
              !Predicate.isTagged(state, "starting") ||
              !Predicate.isTagged(state.completion, "workload")
            )
              continue;
            completions.push(state.completion.deferred);
            capabilities.set(
              name,
              Predicate.isTagged(cleanup, "proven")
                ? durable === "stopped"
                  ? { _tag: "stopped" }
                  : state.prior
                : cleanupFailed(state, cause),
            );
          }
          yield* Ref.set(machine, { ...snapshot, capabilities });
          const result = Exit.failCause(cause);
          yield* Effect.forEach(completions, (completion) => Deferred.succeed(completion, result), {
            discard: true,
          });
        }),
      );
    const idleTimeout = (
      timeouts: ReadonlyMap<CapabilityName, number | false>,
      plan: ExecutionPlan,
      capability: CapabilityName,
    ): number | false => {
      if (plan.activation[capability] !== "lazy") return false;
      return timeouts.get(capability) ?? false;
    };

    const canRetire = (
      plan: ExecutionPlan,
      roots: ReadonlySet<CapabilityName>,
      capability: CapabilityName,
    ): boolean =>
      ![...roots].some(
        (root) => root !== capability && dependencyClosure(plan, [root]).has(capability),
      );

    const appendIdleLog = (message: string): Effect.Effect<void> =>
      options.runtime.logStore
        .append({
          source: "supervisor",
          stream: "internal",
          message,
        })
        .pipe(
          Effect.catchTag("LogStoreError", (error) => Effect.logWarning(message, error)),
          Effect.asVoid,
        );

    function retireIdle(
      capability: CapabilityName,
      epoch: symbol,
    ): Effect.Effect<boolean, StackError> {
      return execution.withPermit(
        Effect.gen(function* () {
          const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
          const operation = Symbol("retirement");
          const retire = Effect.gen(function* () {
            const fenced = yield* admission.withPermit(
              Effect.gen(function* () {
                const snapshot = yield* Ref.get(machine);
                const currentControl = snapshot.capabilities.get(capability);
                const count =
                  currentControl !== undefined && "traffic" in currentControl
                    ? currentControl.traffic
                    : 0;
                const plan = snapshot.plan;
                const roots = new Set(
                  [...snapshot.capabilities].flatMap(([name, state]) =>
                    "root" in state && state.root ? [name] : [],
                  ),
                );
                const eligible =
                  count === 0 &&
                  plan !== undefined &&
                  publicPhase(snapshot.stack) === "running" &&
                  !isTransitioning(snapshot.stack) &&
                  Predicate.isTagged(currentControl, "ready") &&
                  Predicate.isTagged(currentControl.retirement, "armed") &&
                  currentControl.retirement.epoch === epoch &&
                  canRetire(plan, roots, capability);
                if (!eligible) {
                  if (
                    Predicate.isTagged(currentControl, "ready") &&
                    Predicate.isTagged(currentControl.retirement, "armed") &&
                    currentControl.retirement.epoch === epoch
                  )
                    yield* Ref.set(machine, {
                      ...snapshot,
                      capabilities: new Map(snapshot.capabilities).set(capability, {
                        ...currentControl,
                        retirement: { _tag: "disarmed" },
                      }),
                    });
                  return false;
                }
                const current = snapshot.capabilities.get(capability);
                if (!Predicate.isTagged(current, "ready")) return false;
                const stopping = beginStopping(current, operation, completion, false);
                yield* Ref.set(machine, {
                  ...snapshot,
                  capabilities: new Map(snapshot.capabilities).set(capability, stopping),
                });
                return true;
              }),
            );
            if (!fenced) return false;
            yield* launcher
              .stopCapabilities(new Set([capability]))
              .pipe(Effect.mapError(mapCleanupError));
            return true;
          }).pipe(
            Effect.onExit((result) =>
              settleOwner({
                _tag: "retirement",
                capability,
                operation,
                completion,
                result,
              }),
            ),
          );
          const stopped = yield* Effect.exit(retire);
          if (Exit.isFailure(stopped)) {
            const logged = yield* appendIdleLog(
              `Failed to stop ${capability} after inactivity: ${Cause.pretty(stopped.cause)}`,
            ).pipe(Effect.exit);
            if (Exit.isFailure(logged))
              return yield* Effect.failCause(Cause.combine(stopped.cause, logged.cause));
            if (Cause.hasInterrupts(stopped.cause) || Cause.hasDies(stopped.cause))
              return yield* Effect.failCause(stopped.cause);
            return false;
          }
          if (!stopped.value) return false;

          yield* appendIdleLog(`Stopped ${capability} after inactivity`);
          return true;
        }),
      );
    }

    function armIdleTimerInAdmission(capability: CapabilityName): Effect.Effect<void> {
      return Effect.gen(function* () {
        const plan = yield* planValue();
        if (plan === undefined) return;
        const timeout = idleTimeout(yield* Ref.get(idleTimeouts), plan, capability);
        if (timeout === false) return;
        const snapshot = yield* Ref.get(machine);
        if (!Predicate.isTagged(snapshot.stack, "running")) return;
        const current = snapshot.capabilities.get(capability);
        if (
          !Predicate.isTagged(current, "ready") ||
          current.traffic !== 0 ||
          Predicate.isTagged(current.retirement, "armed") ||
          !canRetire(plan, yield* rootSet(), capability)
        )
          return;
        const token = Symbol();
        yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<void, never>();
            const fiber = yield* Effect.forkIn(
              Deferred.await(started).pipe(
                Effect.andThen(
                  Effect.sleep(Duration.seconds(timeout)).pipe(
                    Effect.andThen(
                      FiberSet.run(ownedFibers, retireIdle(capability, token), {
                        startImmediately: true,
                      }).pipe(Effect.asVoid),
                    ),
                  ),
                ),
              ),
              supervisorScope,
              { startImmediately: true },
            );
            const latest = yield* Ref.get(machine);
            const current = latest.capabilities.get(capability);
            if (Predicate.isTagged(current, "ready"))
              yield* Ref.set(machine, {
                ...latest,
                capabilities: new Map(latest.capabilities).set(capability, {
                  ...current,
                  retirement: { _tag: "armed", epoch: token, fiber },
                }),
              });
            yield* Deferred.succeed(started, undefined);
          }),
        );
      });
    }

    function reevaluateIdleTimersInAdmission(): Effect.Effect<void> {
      return readySet().pipe(
        Effect.flatMap((capabilities) =>
          Effect.forEach(capabilities, armIdleTimerInAdmission, {
            discard: true,
          }),
        ),
      );
    }

    function armIdleTimer(capability: CapabilityName): Effect.Effect<void> {
      return admission.withPermit(armIdleTimerInAdmission(capability));
    }

    const cancelIdleTimers: Effect.Effect<void> = Effect.gen(function* () {
      const timers = yield* admission.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(machine);
          const timers: Array<Fiber.Fiber<void, unknown>> = [];
          const capabilities = new Map(snapshot.capabilities);
          for (const [name, state] of capabilities) {
            if (
              Predicate.isTagged(state, "ready") &&
              Predicate.isTagged(state.retirement, "armed")
            ) {
              timers.push(state.retirement.fiber);
              capabilities.set(name, { ...state, retirement: { _tag: "disarmed" } });
            }
          }
          yield* Ref.set(machine, { ...snapshot, capabilities });
          return timers;
        }),
      );
      yield* Effect.forEach(timers, (fiber) => Fiber.interrupt(fiber), {
        concurrency: "unbounded",
        discard: true,
      });
    });

    type TrafficLease = Readonly<{ readonly sessionId: symbol }>;
    const beginTraffic = (capability: CapabilityName): Effect.Effect<TrafficLease> =>
      Effect.gen(function* () {
        const acquired = yield* admission.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* Ref.get(machine);
            const current = snapshot.capabilities.get(capability);
            const entry =
              Predicate.isTagged(current, "ready") &&
              Predicate.isTagged(current.retirement, "armed")
                ? current.retirement.fiber
                : undefined;
            if (
              Predicate.isTagged(current, "ready") &&
              Predicate.isTagged(current.retirement, "armed")
            )
              yield* Ref.set(machine, {
                ...snapshot,
                capabilities: new Map(snapshot.capabilities).set(capability, {
                  ...current,
                  traffic: current.traffic + 1,
                  retirement: { _tag: "disarmed" },
                }),
              });
            else if (Predicate.isTagged(current, "ready"))
              yield* Ref.set(machine, {
                ...snapshot,
                capabilities: new Map(snapshot.capabilities).set(
                  capability,
                  ready(current.sessionId, current.traffic + 1, current.root, current.endpoint),
                ),
              });
            else if (
              Predicate.isTagged(current, "dormant") ||
              Predicate.isTagged(current, "starting") ||
              Predicate.isTagged(current, "stopping") ||
              Predicate.isTagged(current, "cleanup-failed")
            )
              yield* updateCapability(capability, (state) => {
                if (state === undefined) return state;
                return Match.value(state).pipe(
                  Match.tag("dormant", "starting", "stopping", "cleanup-failed", (value) => ({
                    ...value,
                    traffic: value.traffic + 1,
                  })),
                  Match.tag("disabled", "stopped", "ready", (value) => value),
                  Match.exhaustive,
                );
              });
            return { fiber: entry, lease: { sessionId: snapshot.sessionId } };
          }),
        );
        if (acquired.fiber !== undefined) yield* Fiber.interrupt(acquired.fiber);
        return acquired.lease;
      });
    const endTraffic = (capability: CapabilityName, lease: TrafficLease): Effect.Effect<void> =>
      Effect.gen(function* () {
        const shouldArm = yield* admission.withPermit(
          Effect.gen(function* () {
            const sessionId = (yield* Ref.get(machine)).sessionId;
            if (lease.sessionId !== sessionId) return false;
            const current = (yield* Ref.get(machine)).capabilities.get(capability);
            const count = current !== undefined && "traffic" in current ? current.traffic : 0;
            yield* updateCapability(capability, (state) => {
              if (state === undefined) return state;
              return Match.value(state).pipe(
                Match.tag(
                  "dormant",
                  "starting",
                  "ready",
                  "stopping",
                  "cleanup-failed",
                  (value) => ({
                    ...value,
                    traffic: Math.max(0, count - 1),
                  }),
                ),
                Match.tag("disabled", "stopped", (value) => value),
                Match.exhaustive,
              );
            });
            return count <= 1;
          }),
        );
        if (shouldArm) yield* armIdleTimer(capability);
      });

    const activity = yield* makeGatewayActivity({ begin: beginTraffic, end: endTraffic });
    const ingressActivate = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        // A request can reach the adopted gateway while the owning start operation is still
        // installing its workloads. Wait for that shared lifecycle result before attempting lazy
        // activation; otherwise the state check below would turn a valid cold request into 503.
        const lifecycle = yield* activeCommand();
        if (lifecycle?.kind === "start") {
          const started = yield* Deferred.await(lifecycle.result);
          yield* joinExit(started);
        }
        const handler = yield* Deferred.await(activationHandler);
        return yield* handler(capability);
      });
    const ensureActivationPhaseAllowed = (): Effect.Effect<
      void,
      GatewayActivationError | StackError
    > =>
      Effect.gen(function* () {
        const lifecycle = yield* activeCommand();
        if (lifecycle !== undefined)
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: `Cannot activate while ${lifecycle.kind} is in progress`,
          });
        const stack = (yield* Ref.get(machine)).stack;
        return yield* Match.value(stack).pipe(
          Match.when({ _tag: "running" }, () => Effect.void),
          Match.when({ _tag: "stopped" }, () =>
            Effect.fail(
              new StackNotRunningError({ message: "Stack must be running before activation" }),
            ),
          ),
          Match.when({ _tag: "starting" }, () =>
            Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Cannot activate while start is in progress",
              }),
            ),
          ),
          Match.when({ _tag: "stopping" }, () =>
            Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Cannot activate while exact cleanup is pending; stop the stack first",
              }),
            ),
          ),
          Match.when({ _tag: "destroying" }, () =>
            Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Cannot activate while destroy is in progress",
              }),
            ),
          ),
          Match.when({ _tag: "stop-required" }, (stack) =>
            Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Exact runtime cleanup is required; retry stop before activating",
                recovery: recoveryForState(stack),
              }),
            ),
          ),
          Match.when({ _tag: "start-recovery" }, () =>
            Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Start recovery requires exact cleanup; retry stop before activating",
              }),
            ),
          ),
          Match.when({ _tag: "destroy-required" }, (stack) =>
            Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Destructive cleanup is required; retry destroy before activating",
                recovery: recoveryForState(stack),
              }),
            ),
          ),
          Match.exhaustive,
        );
      });
    const ensureActivationStateAllowed = (): Effect.Effect<
      PersistedStackState,
      GatewayActivationError | StackError
    > =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        if (state.desiredLifecycle !== "running")
          return yield* new StackNotRunningError({
            message: "Stack must be running before activation",
          });
        return state;
      });
    const ensureActivationAllowed = (): Effect.Effect<
      PersistedStackState,
      GatewayActivationError | StackError
    > => ensureActivationPhaseAllowed().pipe(Effect.andThen(ensureActivationStateAllowed()));
    const shutdownSignal = yield* Deferred.make<void, never>();
    const signalShutdown = Deferred.succeed(shutdownSignal, undefined).pipe(Effect.asVoid);
    const ensureAcceptingOperations = Deferred.poll(shutdownSignal).pipe(
      Effect.flatMap((shutdown) =>
        Option.isNone(shutdown)
          ? Effect.void
          : Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Stack owner is shutting down",
              }),
            ),
      ),
    );

    const submitLifecycle = (
      kind: LifecycleKind,
      effect: Effect.Effect<CommandResult, StackError>,
    ): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        const owned = yield* admission.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* ensureAcceptingOperations;
              const current = yield* activeCommand();
              if (current !== undefined) {
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: `Lifecycle operation ${current.kind} is already active`,
                });
              }
              const deferred = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
              const snapshot = yield* Ref.get(machine);
              const admitted = command(snapshot.stack, kind, deferred);
              if (Predicate.isTagged(admitted, "rejected"))
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message:
                    admitted.reason === "stop-required"
                      ? "Exact runtime cleanup is required; retry stop before starting"
                      : admitted.reason === "destroy-required"
                        ? "Destructive cleanup is required; retry destroy before proceeding"
                        : `Lifecycle operation ${kind} is already in progress`,
                  recovery:
                    admitted.reason === "stop-required" || admitted.reason === "destroy-required"
                      ? recoveryForState(snapshot.stack)
                      : undefined,
                });
              yield* Ref.set(machine, { ...snapshot, stack: admitted.state });
              const owner = cancelIdleTimers.pipe(
                Effect.andThen(execution.withPermit(effect)),
                Effect.onExit((result) =>
                  Effect.gen(function* () {
                    const operation = Exit.isSuccess(result)
                      ? result.value
                      : {
                          _tag: "failed" as const,
                          cause: result.cause,
                          cleanup: { _tag: "unproven" as const, cause: result.cause },
                          durable: "unsafe" as const,
                        };
                    if (kind === "start" && Predicate.isTagged(operation, "failed"))
                      yield* settleStartupFailures(
                        operation.cause,
                        operation.cleanup,
                        operation.durable,
                      );
                    if (
                      Predicate.isTagged(operation, "failed") &&
                      (kind === "stop" || kind === "destroy")
                    )
                      yield* settleCapabilityCleanup(Exit.failCause(operation.cause));
                    yield* settleOwner({
                      _tag: "lifecycle",
                      completion: deferred,
                      result: operation,
                    });
                  }),
                ),
              );
              const ownerFiber = yield* FiberSet.run(ownedFibers, owner, {
                startImmediately: true,
              });
              // Effect rc112 has no safe Fiber.poll; FiberSet returns an already-interrupted fiber when closed.
              const ownerExit = yield* Effect.sync(() => ownerFiber.pollUnsafe());
              if (
                ownerExit !== undefined &&
                Exit.isFailure(ownerExit) &&
                Cause.hasInterruptsOnly(ownerExit.cause)
              ) {
                const conflict = new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: "Stack owner scope is closed",
                });
                const cause = Cause.fail(conflict);
                yield* settleOwnerInAdmission({
                  _tag: "lifecycle",
                  completion: deferred,
                  result: {
                    _tag: "failed",
                    cause,
                    cleanup: { _tag: "unproven", cause },
                    durable: "unsafe",
                  },
                });
              }
              return deferred;
            }),
          ),
        );
        return yield* joinExit(yield* Deferred.await(owned));
      });

    const launchBackend = (
      input: LifecycleInput,
      session: "fresh" | "current",
      selectedOverride?: ReadonlySet<CapabilityName>,
    ): Effect.Effect<LifecycleLaunchResult, StackError> =>
      Effect.gen(function* () {
        if (session === "fresh") yield* resetForSession(input);
        const selected = selectedOverride ?? (yield* selectedSet());
        const plan = activeExecutionPlan(input.plan, selected);
        const reservation = yield* runtime.ingress.acquire(input);
        const launchCancellation = yield* Deferred.make<void>();
        const preparedFiber = yield* Effect.forkChild(
          runtime.prepare(input, selected).pipe(Effect.exit),
          {
            startImmediately: true,
          },
        );
        const launchFiber = yield* Effect.forkChild(launcher.launch(plan, launchCancellation), {
          startImmediately: true,
        });
        const first = yield* Effect.raceFirst(
          Fiber.await(preparedFiber).pipe(
            Effect.map((value) => ({ _tag: "prepared", value }) as const),
          ),
          Fiber.await(launchFiber).pipe(
            Effect.map((value) => ({ _tag: "launch", value }) as const),
          ),
        );
        let prepared: Exit.Exit<void, StackError>;
        let launch: SessionLaunchOutcome;
        const preparedExit = (value: Exit.Exit<Exit.Exit<void, StackError>, never>) =>
          Exit.isSuccess(value) ? value.value : Exit.failCause(value.cause);
        const launchOutcome = (
          value: Exit.Exit<SessionLaunchOutcome, never>,
        ): SessionLaunchOutcome =>
          Exit.isSuccess(value)
            ? value.value
            : {
                _tag: "failed",
                cause: value.cause,
                cleanup: { _tag: "unproven", cause: value.cause },
              };
        if (Predicate.isTagged(first, "prepared")) {
          prepared = preparedExit(first.value);
          if (Exit.isFailure(prepared)) yield* Deferred.succeed(launchCancellation, undefined);
          launch = launchOutcome(yield* Fiber.await(launchFiber));
        } else {
          launch = launchOutcome(first.value);
          if (Predicate.isTagged(launch, "failed")) {
            yield* Fiber.interrupt(preparedFiber);
            prepared = preparedExit(yield* Fiber.await(preparedFiber));
          } else {
            prepared = preparedExit(yield* Fiber.await(preparedFiber));
          }
        }
        const mapSessionCleanup = (cleanup: SessionCleanupOutcome): CleanupOutcome =>
          Match.value(cleanup).pipe(
            Match.when({ _tag: "proven" }, () => ({ _tag: "proven" as const })),
            Match.when({ _tag: "unproven" }, (value) => ({
              _tag: "unproven" as const,
              cause: Cause.map(value.cause, mapRuntimeError),
            })),
            Match.exhaustive,
          );
        if (Exit.isFailure(prepared)) {
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          let cause: Cause.Cause<StackError> = Cause.map(prepared.cause, mapRuntimeError);
          let workloadCleanup: CleanupOutcome = { _tag: "proven" };
          if (Predicate.isTagged(launch, "started")) {
            workloadCleanup = mapSessionCleanup(yield* launch.launch.rollback);
            if (Predicate.isTagged(workloadCleanup, "unproven"))
              cause = Cause.combine(cause, workloadCleanup.cause);
          } else {
            const launchCause = Cause.map(launch.cause, mapRuntimeError);
            cause = Cause.combine(cause, launchCause);
            workloadCleanup = mapSessionCleanup(launch.cleanup);
          }
          const closedCleanup: CleanupOutcome = Exit.isFailure(closed)
            ? { _tag: "unproven", cause: closed.cause }
            : { _tag: "proven" };
          const cleanup = combineCleanupOutcome(workloadCleanup, closedCleanup);
          if (Predicate.isTagged(closedCleanup, "unproven"))
            cause = Cause.combine(cause, closedCleanup.cause);
          return {
            _tag: "failed",
            cause,
            cleanup,
          } satisfies LifecycleLaunchResult;
        }
        if (Predicate.isTagged(launch, "failed")) {
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          const launchCause = Cause.map(launch.cause, mapRuntimeError);
          let cause: Cause.Cause<StackError> = launchCause;
          const workloadCleanup = mapSessionCleanup(launch.cleanup);
          const closedCleanup: CleanupOutcome = Exit.isFailure(closed)
            ? { _tag: "unproven", cause: closed.cause }
            : { _tag: "proven" };
          const cleanup = combineCleanupOutcome(workloadCleanup, closedCleanup);
          if (Predicate.isTagged(closedCleanup, "unproven"))
            cause = Cause.combine(cause, closedCleanup.cause);
          return {
            _tag: "failed",
            cause,
            cleanup,
          } satisfies LifecycleLaunchResult;
        }
        const rollback: Effect.Effect<CleanupOutcome> = Effect.gen(function* () {
          const workload = yield* launch.launch.rollback;
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          const workloadOutcome = mapSessionCleanup(workload);
          const closedOutcome: CleanupOutcome = Exit.isSuccess(closed)
            ? { _tag: "proven" }
            : { _tag: "unproven", cause: closed.cause };
          return combineCleanupOutcome(workloadOutcome, closedOutcome);
        });
        const opened = yield* runtime.ingress
          .open(input, reservation, ingressActivate, activity)
          .pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          const rolledBack = yield* rollback;
          const cause = Predicate.isTagged(rolledBack, "unproven")
            ? Cause.combine(opened.cause, rolledBack.cause)
            : opened.cause;
          return {
            _tag: "failed",
            cause,
            cleanup: rolledBack,
          } satisfies LifecycleLaunchResult;
        }
        return { _tag: "started", rollback } satisfies LifecycleLaunchResult;
      });

    const cleanupRuntime = (destroy: boolean): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        yield* enterCapabilityCleanup();
        const background = yield* Ref.get(backgroundPreparation);
        if (background !== undefined) yield* Fiber.interrupt(background);
        yield* Ref.set(backgroundPreparation, undefined);
        const ingress = yield* runtime.ingress.close.pipe(
          Effect.mapError(mapCleanupError),
          Effect.exit,
        );
        const launched = destroy
          ? Exit.succeed(undefined)
          : yield* launcher.stop.pipe(Effect.mapError(mapCleanupError), Effect.exit);
        const driver = yield* runtime.driver
          .cleanup({ stackId: options.stackId, destroy })
          .pipe(Effect.mapError(mapCleanupError), Effect.exit);
        let cause: Cause.Cause<StackError> = Cause.empty;
        for (const result of [ingress, launched, driver])
          if (Exit.isFailure(result)) cause = Cause.combine(cause, result.cause);
        if (cause.reasons.length > 0) {
          yield* settleCapabilityCleanup(Exit.failCause(cause));
          return yield* Effect.failCause(cause);
        }
        yield* settleCapabilityCleanup(Exit.void);
        yield* completeDormantCleanup();
        if (!destroy) {
          yield* setRootSet(new Set());
        } else {
          yield* launcher.clear;
          yield* setRootSet(new Set());
        }
      });
    const backend: LifecycleBackend = {
      preflight: runtime.preflight,
      launch: launchBackend,
      cleanup: cleanupRuntime(false),
      destroyData: cleanupRuntime(true),
    };
    const controller = yield* makeLifecycleController({
      stackId: options.stackId,
      runtime: initial.runtime,
      stateStore: options.stateStore,
      backend,
    }).pipe(Effect.provideContext(options.context));
    const status = snapshot();

    const activateOperation = (
      capability: CapabilityName,
      activationPriorRoot?: boolean,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        const state = yield* ensureActivationAllowed();
        const definition = state.definition;
        if (definition === undefined || !definition.capabilities[capability].enabled)
          return yield* new GatewayActivationError({
            message: `Capability ${capability} is not enabled`,
          });
        const plan = yield* rebuildExecutionPlan(state.runtime, definition).pipe(
          Effect.provideContext(options.context),
          Effect.mapError(
            (error) => new StackStateInvalidError({ message: error.message, cause: error }),
          ),
        );
        const next = new Set([...(yield* readySet()), ...dependencyClosure(plan, [capability])]);
        const input: LifecycleInput = {
          stackId: options.stackId,
          state,
          definition,
          secrets: state.secrets,
          plan,
        };
        type ActivationAttempt =
          | { readonly _tag: "succeeded"; readonly value: ActivationResult }
          | {
              readonly _tag: "failed";
              readonly cause: Cause.Cause<StackError>;
              readonly cleanup: CleanupOutcome;
            };
        const attempt = yield* Effect.acquireUseRelease(
          claimWorkloads(next),
          () =>
            Effect.gen(function* () {
              const launched = yield* launchBackend(input, "current", next).pipe(Effect.exit);
              if (Exit.isFailure(launched))
                return {
                  _tag: "failed",
                  cause: launched.cause,
                  cleanup: { _tag: "unproven", cause: launched.cause },
                } satisfies ActivationAttempt;
              const launchResult = launched.value;
              if (Predicate.isTagged(launchResult, "failed"))
                return {
                  _tag: "failed",
                  cause: launchResult.cause,
                  cleanup: launchResult.cleanup,
                } satisfies ActivationAttempt;
              yield* setReadySet(next);
              const activated = yield* runtime.activate(capability, input).pipe(Effect.exit);
              if (Exit.isFailure(activated)) {
                const rolledBack = yield* launchResult.rollback;
                const cause = Predicate.isTagged(rolledBack, "unproven")
                  ? Cause.combine(activated.cause, rolledBack.cause)
                  : activated.cause;
                return {
                  _tag: "failed",
                  cause,
                  cleanup: rolledBack,
                } satisfies ActivationAttempt;
              }
              const endpoint = activated.value;
              yield* promoteActivationSet(next, capability);
              yield* admission.withPermit(
                Ref.update(machine, (snapshot) => ({ ...snapshot, plan })),
              );
              return {
                _tag: "succeeded",
                value: { capability, endpoint },
              } satisfies ActivationAttempt;
            }),
          (claimed, result) => {
            const outcome: ActivationAttempt = Exit.isSuccess(result)
              ? result.value
              : {
                  _tag: "failed",
                  cause: result.cause,
                  cleanup: { _tag: "unproven", cause: result.cause },
                };
            return Predicate.isTagged(outcome, "failed")
              ? restoreActivationFailure(
                  capability,
                  claimed,
                  next,
                  Exit.failCause(outcome.cause),
                  outcome.cleanup,
                  activationPriorRoot,
                )
              : Effect.void;
          },
        );
        if (Predicate.isTagged(attempt, "failed")) return yield* Effect.failCause(attempt.cause);
        return attempt.value;
      });

    type ActivationToken =
      | { readonly _tag: "exit"; readonly result: ActivationExit }
      | {
          readonly _tag: "deferred";
          readonly result: Deferred.Deferred<ActivationExit, never>;
        }
      | {
          readonly _tag: "endpoint";
          readonly capability: CapabilityName;
          readonly result: Deferred.Deferred<EndpointExit, never>;
        }
      | {
          readonly _tag: "await";
          readonly result: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
        };
    const settleOwnerInAdmission = (owner: SettlementOwner): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const settlement = Match.value(owner).pipe(
          Match.when({ _tag: "lifecycle" }, (event) => settleLifecycleOwner(snapshot, event)),
          Match.when({ _tag: "retirement" }, (event) => settleRetirementOwner(snapshot, event)),
          Match.when({ _tag: "endpoint" }, (event) => settleActivationOwner(snapshot, event)),
          Match.when({ _tag: "activation" }, (event) => settleActivationOwner(snapshot, event)),
          Match.exhaustive,
        );
        yield* Ref.set(machine, settlement.snapshot);
        if (settlement.reconcile === "all-ready") yield* reevaluateIdleTimersInAdmission();
        yield* Match.value(settlement.notification).pipe(
          Match.when({ _tag: "endpoint" }, (notification) =>
            Deferred.succeed(notification.completion, notification.result),
          ),
          Match.when({ _tag: "activation" }, (notification) =>
            Deferred.succeed(notification.completion, notification.result),
          ),
          Match.when({ _tag: "retirement" }, (notification) =>
            Deferred.succeed(notification.completion, notification.result),
          ),
          Match.when({ _tag: "lifecycle" }, (notification) =>
            Deferred.succeed(notification.completion, notification.result),
          ),
          Match.exhaustive,
        );
      });
    const settleOwner = (owner: SettlementOwner): Effect.Effect<void> =>
      admission.withPermit(settleOwnerInAdmission(owner));
    const runActivationOwner = (owner: ActivationOwner): Effect.Effect<void> =>
      Effect.gen(function* () {
        const operation = activateOperation(
          owner.capability,
          Predicate.isTagged(owner, "endpoint") ? owner.priorRoot : undefined,
        );
        const fiber = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const acquired = yield* restore(execution.take(1)).pipe(Effect.exit);
            if (Exit.isFailure(acquired)) {
              yield* settleOwner({ ...owner, result: Exit.failCause(acquired.cause) });
              return yield* Effect.failCause(acquired.cause);
            }
            const guarded = admission
              .withPermit(
                Ref.get(machine).pipe(
                  Effect.map((snapshot) => matchesActivationOwner(snapshot, owner)),
                ),
              )
              .pipe(
                Effect.flatMap((admitted) =>
                  admitted
                    ? operation
                    : Effect.fail(
                        new StackLifecycleConflictError({
                          stackId: options.stackId,
                          message: Predicate.isTagged(owner, "endpoint")
                            ? "Endpoint activation was superseded by a lifecycle transition"
                            : "Lazy activation was superseded by a lifecycle transition",
                        }),
                      ),
                ),
              );
            yield* restore(guarded).pipe(
              Effect.onExit((result) =>
                settleOwner(
                  Predicate.isTagged(owner, "endpoint")
                    ? { ...owner, result: Exit.map(result, (value) => value.endpoint) }
                    : { ...owner, result },
                ),
              ),
              Effect.ensuring(execution.release(1)),
            );
          }),
        );
        const ownerFiber = yield* FiberSet.run(ownedFibers, fiber, { startImmediately: true });
        const ownerExit = yield* Effect.sync(() => ownerFiber.pollUnsafe());
        if (
          ownerExit !== undefined &&
          Exit.isFailure(ownerExit) &&
          Cause.hasInterruptsOnly(ownerExit.cause)
        )
          yield* settleOwnerInAdmission({
            ...owner,
            result: Exit.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Stack owner scope is closed",
              }),
            ),
          });
      });
    const activate: Supervisor["activate"] = (capability) =>
      Effect.gen(function* () {
        const token = yield* admission.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* ensureActivationPhaseAllowed();
              const current = (yield* Ref.get(machine)).capabilities.get(capability);
              const reject = (message: string) =>
                Effect.fail(
                  new StackLifecycleConflictError({
                    stackId: options.stackId,
                    message,
                  }),
                );
              const admitted = Match.value(current).pipe(
                Match.when(undefined, () =>
                  Effect.fail(
                    new GatewayActivationError({
                      message: `Capability ${capability} is unavailable in this session`,
                    }),
                  ),
                ),
                Match.when({ _tag: "disabled" }, () =>
                  Effect.fail(
                    new GatewayActivationError({
                      message: `Capability ${capability} is not enabled`,
                    }),
                  ),
                ),
                Match.when({ _tag: "stopped" }, () =>
                  Effect.fail(
                    new StackNotRunningError({
                      message: "Stack must be running before activation",
                    }),
                  ),
                ),
                Match.when({ _tag: "cleanup-failed" }, () =>
                  reject(`Capability ${capability} cleanup failed; retry stop before activating`),
                ),
                Match.when({ _tag: "ready" }, (state) =>
                  Match.value(state.endpoint).pipe(
                    Match.when({ _tag: "resolved" }, (endpoint) =>
                      Effect.succeed({
                        _tag: "exit",
                        result: Exit.succeed({ capability, endpoint: endpoint.endpoint }),
                      } satisfies ActivationToken),
                    ),
                    Match.when({ _tag: "resolving" }, (endpoint) =>
                      Effect.succeed({
                        _tag: "endpoint",
                        capability,
                        result: endpoint.deferred,
                      } satisfies ActivationToken),
                    ),
                    Match.when({ _tag: "unresolved" }, () =>
                      Effect.gen(function* () {
                        const endpoint = yield* Deferred.make<EndpointExit, never>();
                        yield* updateCapability(capability, () => ({
                          ...state,
                          root: true,
                          endpoint: { _tag: "resolving", deferred: endpoint },
                        }));
                        const owner: ActivationOwner = {
                          _tag: "endpoint",
                          capability,
                          endpoint,
                          priorRoot: state.root,
                        };
                        yield* runActivationOwner(owner);
                        return {
                          _tag: "endpoint",
                          capability,
                          result: endpoint,
                        } satisfies ActivationToken;
                      }),
                    ),
                    Match.exhaustive,
                  ),
                ),
                Match.when({ _tag: "starting" }, (state) =>
                  Match.value(state.completion).pipe(
                    Match.when({ _tag: "activation" }, (completion) =>
                      Effect.succeed({
                        _tag: "deferred",
                        result: completion.deferred,
                      } satisfies ActivationToken),
                    ),
                    Match.when({ _tag: "workload" }, (completion) =>
                      Effect.succeed({
                        _tag: "await",
                        result: completion.deferred,
                      } satisfies ActivationToken),
                    ),
                    Match.exhaustive,
                  ),
                ),
                Match.when({ _tag: "stopping" }, (state) =>
                  Effect.succeed({
                    _tag: "await",
                    result: state.completion,
                  } satisfies ActivationToken),
                ),
                Match.when({ _tag: "dormant" }, (prior) =>
                  Effect.gen(function* () {
                    const deferred = yield* Deferred.make<
                      Exit.Exit<ActivationResult, GatewayActivationError | StackError>,
                      never
                    >();
                    const activationOperation = Symbol("activation");
                    yield* updateCapability(capability, () =>
                      beginStarting(
                        prior,
                        activationOperation,
                        { _tag: "activation", deferred },
                        true,
                      ),
                    );
                    const owner: ActivationOwner = {
                      _tag: "activation",
                      capability,
                      completion: deferred,
                    };
                    yield* runActivationOwner(owner);
                    return { _tag: "deferred", result: deferred } satisfies ActivationToken;
                  }),
                ),
                Match.exhaustive,
              );
              return yield* admitted;
            }),
          ),
        );
        return yield* Match.value(token).pipe(
          Match.when({ _tag: "deferred" }, (event) =>
            Deferred.await(event.result).pipe(Effect.flatMap(joinExit)),
          ),
          Match.when({ _tag: "await" }, (event) =>
            Effect.gen(function* () {
              const completed = yield* Deferred.await(event.result);
              if (Exit.isFailure(completed)) return yield* Effect.failCause(completed.cause);
              return yield* activate(capability);
            }),
          ),
          Match.when({ _tag: "endpoint" }, (event) =>
            Deferred.await(event.result).pipe(
              Effect.flatMap(joinExit),
              Effect.map((endpoint) => ({ capability: event.capability, endpoint })),
            ),
          ),
          Match.when({ _tag: "exit" }, (event) => joinExit(event.result)),
          Match.exhaustive,
        );
      });
    yield* Deferred.succeed(activationHandler, activate);

    const startOperation = (startOptions?: {
      readonly config?: StackConfig;
    }): Effect.Effect<CommandResult, StackError> =>
      Effect.gen(function* () {
        const admitted = (yield* Ref.get(machine)).stack;
        if (Predicate.isTagged(admitted, "start-recovery"))
          return {
            _tag: "failed",
            cause: admitted.cause,
            cleanup: { _tag: "unproven", cause: admitted.cause },
            durable: "unsafe",
          } satisfies CommandResult;
        const freshSession =
          Predicate.isTagged(admitted, "starting") &&
          Predicate.isTagged(admitted.prior, "stopped") &&
          admitted.prior.session === "uninitialized";
        if (freshSession) {
          const cleaned = yield* backend.cleanup.pipe(Effect.exit);
          if (Exit.isFailure(cleaned)) {
            return yield* Effect.failCause(cleaned.cause);
          }
        }
        const started = yield* controller
          .start({
            config: startOptions?.config,
            freshSession,
          })
          .pipe(Effect.provideContext(options.context), Effect.exit);
        if (Exit.isFailure(started)) {
          return {
            _tag: "failed",
            cause: started.cause,
            cleanup: { _tag: "unproven", cause: started.cause },
            durable: "unsafe",
          } satisfies CommandResult;
        }
        if (Predicate.isTagged(started.value, "failed")) {
          yield* settleStartupFailures(
            started.value.cause,
            started.value.cleanup,
            started.value.durable,
          );
          return {
            _tag: "failed",
            cause: started.value.cause,
            cleanup: started.value.cleanup,
            durable: started.value.durable,
          } satisfies CommandResult;
        }
        yield* setReadySet(yield* selectedSet());
        yield* startBackgroundPreparation(started.value.state);
        return { _tag: "succeeded" } satisfies CommandResult;
      });
    const start = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        yield* submitLifecycle("start", startOperation(startOptions));
        return yield* snapshot();
      });
    const resetDatabaseOperation = (): Effect.Effect<CommandResult, StackError> =>
      Effect.gen(function* () {
        const notRunning = new StackNotRunningError({
          stackId: options.stackId,
          message: "Stack is not running",
        });
        const rejectNotRunning = {
          _tag: "failed" as const,
          cause: Cause.fail(notRunning),
          cleanup: { _tag: "proven" as const },
          durable: "stopped" as const,
        } satisfies CommandResult;
        const failedWithoutMutation = (cause: Cause.Cause<StackError>): CommandResult => ({
          _tag: "failed",
          cause,
          cleanup: { _tag: "proven" },
          durable: "unsafe",
        });
        const failedAfterMutation = (cause: Cause.Cause<StackError>): CommandResult => ({
          _tag: "failed",
          cause,
          cleanup: { _tag: "unproven", cause },
          durable: "unsafe",
        });
        const control = (yield* Ref.get(machine)).stack;
        if (
          !Predicate.isTagged(control, "starting") ||
          !Predicate.isTagged(control.prior, "running")
        )
          return rejectNotRunning;
        const state = yield* read();
        if (state === undefined || state.definition === undefined)
          return failedWithoutMutation(
            Cause.fail(new StackStateInvalidError({ message: "Stack state is missing" })),
          );
        const status = yield* snapshot();
        const database = status.capabilities.find((capability) => capability.name === "database");
        if (database?.state !== "ready")
          return {
            ...rejectNotRunning,
            cause: Cause.fail(
              new StackNotRunningError({
                stackId: options.stackId,
                message: "Database is not running",
              }),
            ),
          };
        const plan =
          (yield* planValue()) ??
          (yield* rebuildExecutionPlan(state.runtime, state.definition).pipe(
            Effect.mapError(
              (error) => new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          ));
        const bounceNames = new Set<CapabilityName>(
          status.capabilities.flatMap((capability) =>
            capability.state === "ready" && RESET_DATABASE_BOUNCE_CAPABILITIES.has(capability.name)
              ? [capability.name]
              : [],
          ),
        );
        const bounce = plan.workloads.filter((workload) => bounceNames.has(workload.capability));
        const databaseWorkload = plan.workloads.find(
          (workload) => workload.id === "database:database",
        );
        if (databaseWorkload === undefined)
          return failedWithoutMutation(
            Cause.fail(new StackStateInvalidError({ message: "Database workload is missing" })),
          );
        const stopped = yield* launcher
          .stopCapabilities(new Set(["database", ...bounceNames]))
          .pipe(Effect.mapError(mapRuntimeError), Effect.exit);
        if (Exit.isFailure(stopped)) return failedAfterMutation(stopped.cause);
        const wiped = yield* runtime.driver
          .wipePersistentData({ stackId: options.stackId, workloadId: databaseWorkload.id })
          .pipe(Effect.mapError(mapRuntimeError), Effect.exit);
        if (Exit.isFailure(wiped)) return failedAfterMutation(wiped.cause);
        const launched = yield* launcher.launch({
          ...plan,
          workloads: [databaseWorkload, ...bounce],
        });
        if (Predicate.isTagged(launched, "failed"))
          return failedAfterMutation(Cause.map(launched.cause, mapRuntimeError));
        return { _tag: "succeeded" } satisfies CommandResult;
      });
    const resetDatabase = Effect.gen(function* () {
      const control = (yield* Ref.get(machine)).stack;
      if (!Predicate.isTagged(control, "running"))
        return yield* new StackNotRunningError({
          stackId: options.stackId,
          message: "Stack is not running",
        });
      yield* submitLifecycle("start", resetDatabaseOperation());
      return yield* snapshot();
    });
    const stopOperation = (): Effect.Effect<CommandResult, StackError> =>
      Effect.gen(function* () {
        const result = yield* controller.stop.pipe(
          Effect.provideContext(options.context),
          Effect.exit,
        );
        if (Exit.isFailure(result))
          return {
            _tag: "failed",
            cause: result.cause,
            cleanup: { _tag: "unproven", cause: result.cause },
            durable: "unsafe",
          } satisfies CommandResult;
        return { _tag: "succeeded" } satisfies CommandResult;
      });
    const signalShutdownIfIdle = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lifecycle = yield* activeCommand();
        if (lifecycle !== undefined) {
          yield* Deferred.await(lifecycle.result);
          return yield* signalShutdownIfIdle();
        }
        yield* admission.withPermit(
          Effect.gen(function* () {
            // Recheck ownership after admission: a lifecycle may have started between the
            // initial observation and this critical section. Keep the permit while making the
            // final state/phase decision and signalling shutdown so no new start can slip in.
            if ((yield* activeCommand()) !== undefined) return;
            const state = yield* read().pipe(Effect.exit);
            if (Exit.isFailure(state)) return;
            const machineState = (yield* Ref.get(machine)).stack;
            if (
              Predicate.isTagged(machineState, "stopped") &&
              (state.value === undefined ||
                state.value.desiredLifecycle === "stopped" ||
                state.value.desiredLifecycle === "unconfigured")
            )
              yield* signalShutdown;
          }),
        );
      });
    const shutdownIfIdle = signalShutdownIfIdle();
    const stopWithShutdown = submitLifecycle("stop", stopOperation());
    const operation = <A>(effect: Effect.Effect<A, StackError>) =>
      effect.pipe(Effect.mapError((error) => rpcError(rpcTag(error), stateErrorMessage(error))));
    const destroyOperation: Effect.Effect<CommandResult, StackError> = Effect.gen(function* () {
      const result = yield* controller.destroy.pipe(
        Effect.provideContext(options.context),
        Effect.exit,
      );
      if (Exit.isFailure(result))
        return {
          _tag: "failed",
          cause: result.cause,
          cleanup: { _tag: "unproven", cause: result.cause },
          durable: "unsafe",
        } satisfies CommandResult;
      return { _tag: "succeeded" } satisfies CommandResult;
    });
    const destroy = submitLifecycle("destroy", destroyOperation).pipe(Effect.asVoid);
    const logs = (query?: LogQuery): Effect.Effect<StackLogBatch, StackError> =>
      Effect.gen(function* () {
        // Capture lifecycle phase before reading the log store. A stopping snapshot stays live
        // and gives followers one more poll rather than racing a final batch.
        const phaseAtRead = yield* currentPhase();
        const cursor =
          query?.cursor?.opaque === EMPTY_LOG_CURSOR.opaque ? undefined : query?.cursor;
        const scanned = yield* runtime.logStore
          .read(cursor === undefined ? undefined : { cursor })
          .pipe(
            Effect.mapError((error) =>
              error instanceof InvalidLogCursorError
                ? error
                : new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          );
        const selected = selectLogBatch(scanned, query);
        const running = phaseAtRead !== "stopped";
        return {
          ...selected,
          running,
        } satisfies StackLogBatch;
      });
    const maintenanceHandlers = {
      probe: Effect.succeed({
        ok: true,
        op: "probe",
        ownerSessionId: options.ownerSessionId,
        stackId: options.stackId,
        rpcRelease: STACK_RPC_RELEASE,
      } satisfies MaintenanceResponse),
      stop: stopWithShutdown.pipe(
        Effect.provideContext(options.context),
        Effect.as({ ok: true, op: "stop" } satisfies MaintenanceResponse),
        Effect.catch((error) => {
          const stackErrorTag = maintenanceStackErrorTag(error);
          return Effect.succeed({
            ok: false,
            error: {
              tag: "operation-failed",
              message: stateErrorMessage(error),
              ...(stackErrorTag === undefined ? {} : { stackErrorTag }),
            },
          } satisfies MaintenanceResponse);
        }),
      ),
    };
    const credentials: Effect.Effect<EffectStackCredentials, StackRpcError> = Effect.gen(
      function* () {
        const state = yield* read().pipe(
          Effect.mapError((error) => rpcError(rpcTag(error), stateErrorMessage(error))),
        );
        const actualPhase = yield* currentPhase();
        if (
          state === undefined ||
          actualPhase !== "running" ||
          state.desiredLifecycle !== "running"
        )
          return yield* Effect.fail(credentialsUnavailable);

        const definition = state.definition;
        const databaseListener = definition?.listeners.database;
        const databaseAssignment = state.ports.find(({ field }) => field === "database");
        if (definition === undefined)
          return yield* Effect.fail(
            rpcError("InvalidStackConfigError", "Stack credentials require a stack definition"),
          );
        if (
          databaseListener === undefined ||
          !databaseListener.enabled ||
          databaseAssignment === undefined
        )
          return yield* Effect.fail(
            rpcError(
              "InvalidStackConfigError",
              "Stack credentials require an enabled database listener and assigned database port",
            ),
          );

        const requiredSecret = (slot: string): Effect.Effect<string, StackRpcError> => {
          const value = state.secrets[slot]?.value;
          return value === undefined || value.length === 0
            ? Effect.fail(
                rpcError("StackSecretMismatchError", "Required stack credential is unavailable"),
              )
            : Effect.succeed(value);
        };

        const databasePassword = yield* requiredSecret(DATABASE_INTERNAL_PASSWORD_SLOT);
        const databaseHost = credentialHost(databaseListener.address);
        const databaseUrl = `postgresql://${encodeURIComponent("postgres")}:${encodeURIComponent(
          databasePassword,
        )}@${databaseHost}:${databaseAssignment.port}/postgres`;

        const auth = definition.capabilities.auth;
        const api = auth.enabled
          ? yield* Effect.gen(function* () {
              const publishableKey = yield* requiredSecret(AUTH_PUBLISHABLE_KEY_SLOT);
              const secretKey = yield* requiredSecret(AUTH_SECRET_KEY_SLOT);
              const anonJwt = yield* requiredSecret(AUTH_ANON_KEY_SLOT);
              const serviceRoleJwt = yield* requiredSecret(AUTH_SERVICE_ROLE_KEY_SLOT);
              return {
                publishableKey,
                secretKey: Redacted.make(secretKey),
                anonJwt,
                serviceRoleJwt: Redacted.make(serviceRoleJwt),
              };
            })
          : undefined;

        const base: EffectStackCredentials = {
          database: {
            url: Redacted.make(databaseUrl),
            password: Redacted.make(databasePassword),
          },
          ...(api === undefined ? {} : { api }),
        };
        const storage = definition.capabilities.storage;
        const s3 = storage.settings.s3_protocol;
        if (!storage.enabled || s3 === null || s3 === undefined || s3.enabled !== true) return base;

        const apiListener = definition.listeners.api;
        const apiAssignment = state.ports.find(({ field }) => field === "api");
        if (apiListener === undefined || !apiListener.enabled || apiAssignment === undefined)
          return yield* Effect.fail(
            rpcError(
              "InvalidStackConfigError",
              "Stack credentials require an enabled API listener and assigned API port",
            ),
          );
        const accessKeyId = s3.access_key_id;
        const region = s3.region;
        if (
          accessKeyId === null ||
          accessKeyId === undefined ||
          accessKeyId.length === 0 ||
          region === null ||
          region === undefined ||
          region.length === 0
        )
          return yield* Effect.fail(
            rpcError("StackStateInvalidError", "Storage credentials are unavailable"),
          );
        const secretAccessKey = yield* requiredSecret(
          "secret:storage.settings.s3_protocol.secret_access_key",
        );
        return {
          ...base,
          storage: {
            endpoint: `http://${credentialHost(apiListener.address)}:${apiAssignment.port}/storage/v1/s3`,
            region,
            accessKeyId,
            secretAccessKey: Redacted.make(secretAccessKey),
          },
        } satisfies EffectStackCredentials;
      },
    );
    const rpcHandlers: StackRpcHandlers = StackRpcGroup.of({
      status: () => operation(status),
      credentials: () => credentials,
      start: ({ config }: { readonly config?: StackConfig }) => operation(start({ config })),
      destroy: () => operation(destroy),
      resetDatabase: () => operation(resetDatabase),
      logs: (query: LogQuery) => operation(logs(query)),
    });
    return {
      status,
      start,
      resetDatabase,
      destroy,
      shutdown: Deferred.await(shutdownSignal),
      shutdownIfIdle,
      logs,
      activate,
      maintenanceHandlers,
      rpcHandlers,
    } satisfies Supervisor;
  });
