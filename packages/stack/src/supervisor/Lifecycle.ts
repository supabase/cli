import { Crypto, Effect, FileSystem, Path, Redacted, Ref, Semaphore } from "effect";
import type { StackDefinition, CompiledStack, SecretSlotInput } from "../model/Compiler.ts";
import { compileStack, rebuildExecutionPlan } from "../model/Compiler.ts";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { StackConfig } from "../public/Config.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { StackId } from "../public/StackId.ts";
import {
  StackDefinitionRequiredError,
  StackLifecycleConflictError,
  StackNotRunningError,
  StackStateInvalidError,
  StackUpgradeRequiredError,
  type StackError,
} from "../public/Errors.ts";
import type {
  HostPortAssignment,
  PersistedSecretValues,
  PersistedStackState,
} from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import {
  resolveSecrets,
  type SecretCandidate,
  type SecretDeclaration,
} from "../state/SecretStore.ts";

/**
 * The runtime-facing contract deliberately contains no Docker/native concepts. Concrete drivers
 * own resources; this controller owns accepted durable intent and generation fences.
 */
export interface LifecycleInput {
  readonly stackId: StackId;
  readonly generation: number;
  readonly desiredLifecycle: "running" | "stopped" | "destroying";
  readonly state: PersistedStackState;
  readonly previous: PersistedStackState;
  readonly definition: StackDefinition;
  readonly inputFingerprint: string;
  readonly secrets: PersistedSecretValues;
  readonly plan: ExecutionPlan;
}

export interface LifecyclePrepared {
  /** Backend may return newly allocated concrete ports; omitted means retain persisted assignments. */
  readonly ports?: ReadonlyArray<HostPortAssignment>;
}

export interface LifecycleBackend {
  /** Must complete all runtime/resource validation before the controller writes accepted intent. */
  readonly preflight: (input: LifecycleInput) => Effect.Effect<LifecyclePrepared, StackError>;
  /** Applies the desired lifecycle to runtime resources for one fenced generation. */
  readonly reconcile: (input: LifecycleInput) => Effect.Effect<void, StackError>;
  /** Removes runtime resources while retaining durable state/data (stop path). */
  readonly cleanup: (input: LifecycleInput) => Effect.Effect<void, StackError>;
  /** Removes persistent data after exact runtime cleanup (destroy path). */
  readonly destroyData: (input: LifecycleInput) => Effect.Effect<void, StackError>;
}

interface LifecycleStartOptions {
  readonly config?: StackConfig;
}

export interface LifecycleController {
  readonly start: (
    options?: LifecycleStartOptions,
  ) => Effect.Effect<PersistedStackState, StackError, LifecycleRequirements>;
  // Each invocation builds a fresh read/transition effect while sharing the controller semaphore.
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly stop: () => Effect.Effect<PersistedStackState, StackError, LifecycleRequirements>;
  readonly restart: (
    options?: LifecycleStartOptions,
  ) => Effect.Effect<PersistedStackState, StackError, LifecycleRequirements>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly destroy: () => Effect.Effect<void, StackError, LifecycleRequirements>;
}

type LifecycleRequirements = Crypto.Crypto | FileSystem.FileSystem | Path.Path;

export interface LifecycleControllerOptions {
  readonly stackId: StackId;
  readonly runtime: StackRuntime;
  readonly stateStore: StackStateStore;
  readonly backend: LifecycleBackend;
}

interface Candidate {
  readonly definition: StackDefinition;
  readonly inputFingerprint: string;
  readonly secrets: PersistedSecretValues;
  readonly plan: ExecutionPlan;
}

interface StopTransition {
  readonly state: PersistedStackState;
  readonly previous: PersistedStackState;
  readonly candidate?: Candidate;
  readonly cleanup: boolean;
}

const missingState = (stackId: StackId): StackStateInvalidError =>
  new StackStateInvalidError({
    stackId,
    message: "Stack state is missing; refusing lifecycle mutation",
  });

const invalidDefinition = (stackId: StackId): StackDefinitionRequiredError =>
  new StackDefinitionRequiredError({ stackId, message: "A complete stack definition is required" });

const lifecycleConflict = (message: string): StackLifecycleConflictError =>
  new StackLifecycleConflictError({ message });

const declarationsFromPersisted = (secrets: PersistedSecretValues): SecretCandidate => ({
  declarations: Object.entries(secrets).map(([slot, entry]) => ({
    slot,
    policy: entry.policy,
    ...(entry.policy === "passthrough" ? { value: Redacted.make(entry.value) } : {}),
  })),
});

const declarationsFromCompiled = (compiled: CompiledStack): SecretCandidate => ({
  declarations: compiled.secrets.map((entry: SecretSlotInput): SecretDeclaration => ({
    slot: entry.slot,
    policy: entry.policy,
    ...(entry.value === undefined ? {} : { value: entry.value }),
    ...(entry.generator === undefined ? {} : { generator: entry.generator }),
  })),
});

const sameSecrets = (left: PersistedSecretValues, right: PersistedSecretValues): boolean => {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([slot, value], index) => {
    const other = rightEntries[index];
    return (
      other !== undefined &&
      slot === other[0] &&
      value.policy === other[1].policy &&
      value.value === other[1].value
    );
  });
};

const materializeCandidate = (
  state: PersistedStackState,
  runtime: StackRuntime,
  config: StackConfig | undefined,
  secretLifecycle: PersistedStackState["desiredLifecycle"] = state.desiredLifecycle,
): Effect.Effect<Candidate, StackError, LifecycleRequirements> =>
  Effect.gen(function* () {
    if (
      config === undefined &&
      state.definition !== undefined &&
      state.inputFingerprint !== undefined
    ) {
      const plan = yield* rebuildExecutionPlan(runtime, state.definition);
      const resolved = yield* resolveSecrets(
        declarationsFromPersisted(state.secrets),
        state.desiredLifecycle === "unconfigured" ? undefined : state.secrets,
        secretLifecycle,
      );
      return {
        definition: state.definition,
        inputFingerprint: state.inputFingerprint,
        secrets: resolved.persisted,
        plan,
      };
    }
    const compiled = yield* compileStack({
      projectRoot: state.identity.projectRoot,
      runtime,
      config,
    });
    const resolved = yield* resolveSecrets(
      declarationsFromCompiled(compiled),
      state.desiredLifecycle === "unconfigured" ? undefined : state.secrets,
      secretLifecycle,
    );
    return {
      definition: compiled.definition,
      inputFingerprint: compiled.inputFingerprint,
      secrets: resolved.persisted,
      plan: compiled.executionPlan,
    };
  });

const persistedCandidate = (
  stackId: StackId,
  state: PersistedStackState,
  runtime: StackRuntime,
): Effect.Effect<Candidate, StackError, LifecycleRequirements> =>
  Effect.gen(function* () {
    const definition = state.definition;
    const inputFingerprint = state.inputFingerprint;
    if (definition === undefined || inputFingerprint === undefined)
      return yield* invalidDefinition(stackId);
    return {
      definition,
      inputFingerprint,
      secrets: state.secrets,
      plan: yield* rebuildExecutionPlan(runtime, definition),
    };
  });

const lifecycleInput = (
  stackId: StackId,
  previous: PersistedStackState,
  state: PersistedStackState,
  candidate: Candidate,
  desiredLifecycle: LifecycleInput["desiredLifecycle"] = state.desiredLifecycle === "unconfigured"
    ? "running"
    : state.desiredLifecycle,
): LifecycleInput => ({
  stackId,
  generation: state.desiredGeneration,
  desiredLifecycle,
  state,
  previous,
  definition: candidate.definition,
  inputFingerprint: candidate.inputFingerprint,
  secrets: candidate.secrets,
  plan: candidate.plan,
});

const stateWithCandidate = (
  state: PersistedStackState,
  candidate: Candidate,
  desiredLifecycle: PersistedStackState["desiredLifecycle"],
  generation: number,
  ports: ReadonlyArray<HostPortAssignment>,
): PersistedStackState => ({
  ...state,
  desiredGeneration: generation,
  desiredLifecycle,
  definition: candidate.definition,
  inputFingerprint: candidate.inputFingerprint,
  secrets: candidate.secrets,
  ports,
});

const noOpStop = (state: PersistedStackState): StopTransition => ({
  state,
  previous: state,
  cleanup: false,
});

/** Creates one Supervisor-local lifecycle owner. Mutable coordination is allocated per Effect run. */
export const makeLifecycleController = (
  options: LifecycleControllerOptions,
): Effect.Effect<LifecycleController> =>
  Effect.gen(function* () {
    const lifecycle = yield* Semaphore.make(1);
    // A stop request epoch is incremented before waiting for the lifecycle permit. Restart captures
    // the epoch during preflight and refuses to relaunch if a stop was accepted in the meantime.
    const stopRequestEpoch = yield* Ref.make(0);

    const read = (): Effect.Effect<PersistedStackState, StackError, LifecycleRequirements> =>
      options.stateStore
        .read(options.stackId)
        .pipe(
          Effect.flatMap((state) =>
            state === undefined
              ? Effect.fail(missingState(options.stackId))
              : Effect.succeed(state),
          ),
        );

    const start = (
      startOptions?: LifecycleStartOptions,
    ): Effect.Effect<PersistedStackState, StackError, LifecycleRequirements> => {
      const supplied = startOptions?.config;
      return Effect.gen(function* () {
        const initial = yield* read();
        if (initial.desiredLifecycle === "destroying")
          return yield* lifecycleConflict("Stack is being destroyed");

        // Running stacks reject changed materialized input before any backend operation. An omitted
        // config or identical supplied input only joins/reconciles the accepted generation.
        if (initial.desiredLifecycle === "running" && supplied !== undefined) {
          const candidate = yield* materializeCandidate(initial, initial.runtime, supplied).pipe(
            Effect.catchTag("StackMustBeStoppedError", (error) =>
              Effect.fail(
                new StackUpgradeRequiredError({
                  stackId: options.stackId,
                  message: `${error.message}; call restart explicitly to apply it`,
                  guidance: "Use restart() to apply stopped-time changes",
                }),
              ),
            ),
          );
          if (candidate.inputFingerprint !== initial.inputFingerprint)
            return yield* new StackUpgradeRequiredError({
              stackId: options.stackId,
              message: "Running stack input changed; call restart explicitly to apply it",
              guidance: "Use restart() to apply stopped-time changes",
            });
          if (!sameSecrets(candidate.secrets, initial.secrets))
            return yield* new StackUpgradeRequiredError({
              stackId: options.stackId,
              message: "Running stack secrets changed; call restart explicitly to apply them",
              guidance: "Use restart() to apply stopped-time changes",
            });
          const input = lifecycleInput(options.stackId, initial, initial, candidate);
          yield* options.backend.reconcile(input);
          return yield* read();
        }
        if (initial.desiredLifecycle === "running" && supplied === undefined) {
          const candidate = yield* materializeCandidate(initial, initial.runtime, undefined);
          const input = lifecycleInput(options.stackId, initial, initial, candidate);
          yield* options.backend.reconcile(input);
          return yield* read();
        }

        const candidate = yield* materializeCandidate(initial, initial.runtime, supplied);
        const prepared = yield* options.backend.preflight(
          lifecycleInput(options.stackId, initial, initial, candidate),
        );
        return yield* lifecycle.withPermit(
          Effect.gen(function* () {
            const current = yield* read();
            if (current.desiredGeneration !== initial.desiredGeneration)
              return yield* new StackUpgradeRequiredError({
                stackId: options.stackId,
                message: "Stack lifecycle changed while start was preparing; retry start",
              });
            if (current.desiredLifecycle === "destroying")
              return yield* lifecycleConflict("Stack is being destroyed");
            const next = stateWithCandidate(
              current,
              candidate,
              "running",
              current.desiredGeneration + 1,
              prepared.ports ?? current.ports,
            );
            yield* options.stateStore.replace(options.stackId, next, current.desiredGeneration);
            yield* options.backend.reconcile(
              lifecycleInput(options.stackId, current, next, candidate),
            );
            return next;
          }),
        );
      });
    };

    const stop = (): Effect.Effect<PersistedStackState, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
        yield* Ref.update(stopRequestEpoch, (epoch) => epoch + 1);
        const transition = yield* lifecycle.withPermit(
          Effect.gen(function* () {
            const current = yield* read();
            if (current.desiredLifecycle === "unconfigured") return noOpStop(current);
            if (current.desiredLifecycle === "destroying")
              return yield* lifecycleConflict("Stack is being destroyed");
            if (current.desiredLifecycle === "stopped") {
              const candidate = yield* persistedCandidate(
                options.stackId,
                current,
                current.runtime,
              );
              // Stopped state is durable intent, not proof that runtime cleanup completed. Retry
              // the idempotent cleanup without changing the generation.
              return { state: current, previous: current, candidate, cleanup: true };
            }
            const candidate = yield* persistedCandidate(options.stackId, current, current.runtime);
            const next: PersistedStackState = {
              ...current,
              desiredLifecycle: "stopped",
              desiredGeneration: current.desiredGeneration + 1,
            };
            yield* options.stateStore.replace(options.stackId, next, current.desiredGeneration);
            return { state: next, previous: current, candidate, cleanup: true };
          }),
        );
        if (!transition.cleanup || transition.candidate === undefined) return transition.state;
        const input = lifecycleInput(
          options.stackId,
          transition.previous,
          transition.state,
          transition.candidate,
          "stopped",
        );
        yield* options.backend.reconcile(input);
        yield* options.backend.cleanup(input);
        return transition.state;
      });

    const restart = (
      restartOptions?: LifecycleStartOptions,
    ): Effect.Effect<PersistedStackState, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
        const restartEpoch = yield* Ref.get(stopRequestEpoch);
        const initial = yield* read();
        if (initial.desiredLifecycle !== "running")
          return yield* new StackNotRunningError({
            stackId: options.stackId,
            message: "Stack must be running before restart",
          });
        if (initial.definition === undefined || initial.inputFingerprint === undefined)
          return yield* invalidDefinition(options.stackId);
        const candidate = yield* materializeCandidate(
          initial,
          initial.runtime,
          restartOptions?.config,
          "stopped",
        );
        const prepared = yield* options.backend.preflight(
          lifecycleInput(options.stackId, initial, initial, candidate),
        );
        const stoppedTransition = yield* lifecycle.withPermit(
          Effect.gen(function* () {
            const current = yield* read();
            if (
              current.desiredGeneration !== initial.desiredGeneration ||
              current.desiredLifecycle !== "running"
            )
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                message:
                  "Stack lifecycle changed while restart was preparing; restart lost the generation fence",
              });
            const stopped: PersistedStackState = {
              ...current,
              desiredLifecycle: "stopped",
              desiredGeneration: current.desiredGeneration + 1,
            };
            yield* options.stateStore.replace(options.stackId, stopped, current.desiredGeneration);
            const stoppedCandidate = yield* persistedCandidate(
              options.stackId,
              current,
              current.runtime,
            );
            return { current, stopped, stoppedCandidate };
          }),
        );
        const stopInput = lifecycleInput(
          options.stackId,
          stoppedTransition.current,
          stoppedTransition.stopped,
          stoppedTransition.stoppedCandidate,
          "stopped",
        );
        yield* options.backend.reconcile(stopInput);
        yield* options.backend.cleanup(stopInput);
        const next = yield* lifecycle.withPermit(
          Effect.gen(function* () {
            const current = yield* read();
            if (
              current.desiredGeneration !== stoppedTransition.stopped.desiredGeneration ||
              current.desiredLifecycle !== "stopped" ||
              (yield* Ref.get(stopRequestEpoch)) !== restartEpoch
            )
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                message:
                  "Stack stop was accepted during restart; restart lost the generation fence",
              });
            const next = stateWithCandidate(
              current,
              candidate,
              "running",
              current.desiredGeneration + 1,
              prepared.ports ?? current.ports,
            );
            yield* options.stateStore.replace(options.stackId, next, current.desiredGeneration);
            return next;
          }),
        );
        yield* options.backend.reconcile(
          lifecycleInput(options.stackId, stoppedTransition.stopped, next, candidate, "running"),
        );
        return next;
      });

    const destroy = (): Effect.Effect<void, StackError, LifecycleRequirements> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const current = yield* read();
          if (current.desiredLifecycle === "unconfigured" && current.definition === undefined) {
            yield* options.stateStore.cleanup(options.stackId);
            return;
          }
          if (current.desiredLifecycle === "destroying") {
            if (current.definition === undefined) return yield* invalidDefinition(options.stackId);
          } else {
            const destroying: PersistedStackState = {
              ...current,
              desiredLifecycle: "destroying",
              desiredGeneration: current.desiredGeneration + 1,
            };
            yield* options.stateStore.replace(
              options.stackId,
              destroying,
              current.desiredGeneration,
            );
            return yield* destroyRuntime(destroying, current);
          }
          return yield* destroyRuntime(current, current);
        }),
      );

    const destroyRuntime = (
      state: PersistedStackState,
      previous: PersistedStackState,
    ): Effect.Effect<void, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
        const candidate = yield* persistedCandidate(options.stackId, state, state.runtime);
        const input = lifecycleInput(options.stackId, previous, state, candidate);
        yield* options.backend.reconcile(input);
        yield* options.backend.cleanup(input);
        yield* options.backend.destroyData(input);
        yield* options.stateStore.cleanup(options.stackId);
      });

    return { start, stop, restart, destroy } satisfies LifecycleController;
  });
