import { Crypto, Effect, Exit, FileSystem, Path, Redacted } from "effect";
import type { StackDefinition, CompiledStack, SecretSlotInput } from "../model/Compiler.ts";
import { compileStack, rebuildExecutionPlan } from "../model/Compiler.ts";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { StackConfig } from "../public/Config.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { StackId } from "../public/StackId.ts";
import {
  StackDefinitionRequiredError,
  StackLifecycleConflictError,
  StackMustBeStoppedError,
  StackNotRunningError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import type { PersistedSecretValues, PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import {
  resolveSecrets,
  type SecretCandidate,
  type SecretDeclaration,
} from "../state/SecretStore.ts";

/**
 * The runtime-facing contract deliberately contains no Docker/native concepts. Concrete drivers
 * own resources; this controller owns accepted durable intent and lifecycle transitions.
 */
export interface LifecycleInput {
  readonly stackId: StackId;
  readonly desiredLifecycle: "running" | "stopped" | "destroying";
  readonly state: PersistedStackState;
  readonly definition: StackDefinition;
  readonly inputFingerprint: string;
  readonly secrets: PersistedSecretValues;
  readonly plan: ExecutionPlan;
}

export interface LifecycleBackend {
  /** Must complete all runtime/resource validation before the controller writes accepted intent. */
  readonly preflight: (
    input: LifecycleInput,
    mode: "cold" | "live",
  ) => Effect.Effect<void, StackError>;
  /** Applies the desired lifecycle to runtime resources for one accepted definition. */
  readonly reconcile: (
    input: LifecycleInput,
    session: "fresh" | "current",
  ) => Effect.Effect<void, StackError>;
  /** Removes runtime resources while retaining durable state/data (stop path). */
  readonly cleanup: Effect.Effect<void, StackError>;
  /** Removes persistent data after exact runtime cleanup (destroy path). */
  readonly destroyData: Effect.Effect<void, StackError>;
}

interface LifecycleStartOptions {
  readonly config?: StackConfig;
  /** A new Supervisor recovering running intent begins a fresh runtime session. */
  readonly freshSession?: boolean;
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
    const compiled = yield* compileStack(
      {
        projectRoot: state.identity.projectRoot,
        runtime,
        config,
      },
      state.definition === undefined || state.inputFingerprint === undefined
        ? undefined
        : {
            definition: state.definition,
            inputFingerprint: state.inputFingerprint,
          },
    );
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
  state: PersistedStackState,
  candidate: Candidate,
  desiredLifecycle: LifecycleInput["desiredLifecycle"] = state.desiredLifecycle === "unconfigured"
    ? "running"
    : state.desiredLifecycle,
): LifecycleInput => ({
  stackId,
  desiredLifecycle,
  state,
  definition: candidate.definition,
  inputFingerprint: candidate.inputFingerprint,
  secrets: candidate.secrets,
  plan: candidate.plan,
});

const stateWithCandidate = (
  state: PersistedStackState,
  candidate: Candidate,
  desiredLifecycle: PersistedStackState["desiredLifecycle"],
): PersistedStackState => ({
  ...state,
  desiredLifecycle,
  definition: candidate.definition,
  inputFingerprint: candidate.inputFingerprint,
  secrets: candidate.secrets,
  ports: state.ports,
});

/** Creates one Supervisor-local lifecycle owner. Mutable coordination is allocated per Effect run. */
export const makeLifecycleController = (
  options: LifecycleControllerOptions,
): Effect.Effect<LifecycleController> =>
  Effect.sync(() => {
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

        const candidate = yield* materializeCandidate(initial, initial.runtime, supplied);
        if (initial.desiredLifecycle === "running") {
          if (supplied !== undefined && candidate.inputFingerprint !== initial.inputFingerprint)
            return yield* new StackMustBeStoppedError({
              stackId: options.stackId,
              message: "Running stack input changed; call restart explicitly to apply it",
              guidance: "Use restart() to apply stopped-time changes",
            });
          if (supplied !== undefined && !sameSecrets(candidate.secrets, initial.secrets))
            return yield* new StackMustBeStoppedError({
              stackId: options.stackId,
              message: "Running stack secrets changed; call restart explicitly to apply them",
              guidance: "Use restart() to apply stopped-time changes",
            });
          if (startOptions?.freshSession === true)
            yield* options.backend.preflight(
              lifecycleInput(options.stackId, initial, candidate),
              "cold",
            );
          yield* options.backend.reconcile(
            lifecycleInput(options.stackId, initial, candidate),
            startOptions?.freshSession === true ? "fresh" : "current",
          );
          return initial;
        }

        yield* options.backend.preflight(
          lifecycleInput(options.stackId, initial, candidate),
          "cold",
        );
        const next = stateWithCandidate(initial, candidate, "running");
        yield* options.stateStore.replace(options.stackId, next);
        yield* options.backend.reconcile(lifecycleInput(options.stackId, next, candidate), "fresh");
        return next;
      });
    };

    const stop = (): Effect.Effect<PersistedStackState, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
        const current = yield* read();
        if (current.desiredLifecycle === "unconfigured") return current;
        if (current.desiredLifecycle === "destroying")
          return yield* lifecycleConflict("Stack is being destroyed");
        const candidate = yield* Effect.exit(
          persistedCandidate(options.stackId, current, current.runtime),
        );
        const stopped: PersistedStackState =
          current.desiredLifecycle === "stopped"
            ? current
            : { ...current, desiredLifecycle: "stopped" };
        if (stopped !== current) yield* options.stateStore.replace(options.stackId, stopped);
        if (Exit.isSuccess(candidate))
          yield* options.backend.reconcile(
            lifecycleInput(options.stackId, stopped, candidate.value, "stopped"),
            "current",
          );
        yield* options.backend.cleanup;
        return stopped;
      });

    const restart = (
      restartOptions?: LifecycleStartOptions,
    ): Effect.Effect<PersistedStackState, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
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
        yield* options.backend.preflight(
          lifecycleInput(options.stackId, initial, candidate),
          restartOptions?.freshSession === true ? "cold" : "live",
        );
        const stopped: PersistedStackState = { ...initial, desiredLifecycle: "stopped" };
        yield* options.stateStore.replace(options.stackId, stopped);
        const stoppedCandidate = yield* persistedCandidate(
          options.stackId,
          initial,
          initial.runtime,
        );
        const stopInput = lifecycleInput(options.stackId, stopped, stoppedCandidate, "stopped");
        yield* options.backend.reconcile(stopInput, "current");
        yield* options.backend.cleanup;
        const next = stateWithCandidate(stopped, candidate, "running");
        yield* options.stateStore.replace(options.stackId, next);
        yield* options.backend.reconcile(
          lifecycleInput(options.stackId, next, candidate, "running"),
          "fresh",
        );
        return next;
      });

    const destroy = (): Effect.Effect<void, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
        const current = yield* read();
        if (current.desiredLifecycle === "unconfigured" && current.definition === undefined) {
          yield* options.stateStore.cleanup(options.stackId);
          return;
        }
        if (current.desiredLifecycle === "destroying" && current.definition === undefined)
          return yield* invalidDefinition(options.stackId);
        const destroying: PersistedStackState =
          current.desiredLifecycle === "destroying"
            ? current
            : { ...current, desiredLifecycle: "destroying" };
        if (destroying !== current) yield* options.stateStore.replace(options.stackId, destroying);
        yield* destroyRuntime(destroying);
      });

    const destroyRuntime = (
      state: PersistedStackState,
    ): Effect.Effect<void, StackError, LifecycleRequirements> =>
      Effect.gen(function* () {
        const candidate = yield* Effect.exit(
          persistedCandidate(options.stackId, state, state.runtime),
        );
        if (Exit.isSuccess(candidate)) {
          const input = lifecycleInput(options.stackId, state, candidate.value);
          yield* options.backend.reconcile(input, "current");
          yield* options.backend.cleanup;
          yield* options.backend.destroyData;
        } else {
          // Preserve the stable maintenance guarantee: stop and destroy remain usable even when
          // persisted configuration is no longer compilable.
          yield* options.backend.cleanup;
          yield* options.backend.destroyData;
        }
        yield* options.stateStore.cleanup(options.stackId);
      });

    return { start, stop, restart, destroy } satisfies LifecycleController;
  });
