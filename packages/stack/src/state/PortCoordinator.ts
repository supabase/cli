import { Crypto, Effect, Exit, FileSystem, Path, Scope, Schema } from "effect";
import type { StackRuntime } from "../public/Runtime.ts";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Server as HttpServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Server as NetServer } from "node:net";
import { NetworkPortSchema, PORT_FIELDS, type PortField } from "../public/Status.ts";
import {
  PortAllocationError,
  PortUnavailableError,
  InvalidProjectRootError,
  StackLifecycleConflictError,
  StackStateFormatUnsupportedError,
  StackStateGenerationMismatchError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import type { HostPortAssignment, PersistedStackState } from "./StackState.ts";
import type { StackStateStore } from "./StackStateStore.ts";
import type { PortRegistry } from "./PortRegistry.ts";

export interface ListenerIntent {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

export type ListenerIntents = Readonly<Record<PortField, ListenerIntent>>;

export interface NativeListener {
  readonly field: PortField;
  readonly address: string;
  readonly port: number;
  readonly close: Effect.Effect<void>;
  /** The exact bound listener may be adopted by a gateway without rebind. */
  readonly binding: NativeListenerBinding;
}

export type NativeListenerBinding =
  | { readonly kind: "http"; readonly server: HttpServer }
  | { readonly kind: "tcp"; readonly server: NetServer; readonly allowHalfOpen: true };

export interface PortPlanOptions {
  readonly lifecycle?: "stopped" | "running";
  readonly runtime?: StackRuntime;
  readonly expectedGeneration?: number;
  /** Generation to persist after this transaction; unchanged unless explicitly supplied. */
  readonly nextGeneration?: number;
}

export interface PortReservation {
  readonly assignments: Readonly<Partial<Record<PortField, HostPortAssignment>>>;
  /** Already-bound native listeners that can be adopted by a gateway. */
  readonly nativeListeners: ReadonlyArray<NativeListener>;
}

export interface PortCoordinatorOptions {
  /** Binds and retains a native listener. The enclosing Scope owns its release. */
  readonly bindNative?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<NativeListener, PortUnavailableError, Scope.Scope>;
  /** Publishes one container listener through the authoritative engine. */
  readonly publishContainer?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<void, PortUnavailableError>;
  /** Optional non-owning host probe used to skip occupied automatic ports. */
  readonly checkHostPort?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<boolean, PortUnavailableError>;
}

export interface PortCoordinator {
  readonly planAndReserve: (
    stackId: string,
    listenerIntents: ListenerIntents,
    options?: PortPlanOptions,
  ) => Effect.Effect<
    PortReservation,
    | PortAllocationError
    | PortUnavailableError
    | StackLifecycleConflictError
    | StackStateInvalidError
    | StackStateFormatUnsupportedError
    | InvalidProjectRootError
    | StackStateGenerationMismatchError,
    Scope.Scope | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >;
}

const fields: ReadonlyArray<PortField> = PORT_FIELDS;

const assignmentMap = (assignments: ReadonlyArray<HostPortAssignment>) =>
  new Map(assignments.map((assignment) => [assignment.field, assignment]));

const validPort = (port: number): boolean => Schema.is(NetworkPortSchema)(port);

const unavailable = (port: number, field: PortField) =>
  new PortUnavailableError({ port, field, message: `Port ${port} for ${field} is unavailable` });

const automaticConflict = (port: number, field: PortField) =>
  new PortAllocationError({
    port,
    field,
    message: `Port ${port} for ${field} is reserved by another stack's automatic assignment`,
  });

const lifecycleConflict = (field: PortField) =>
  new StackLifecycleConflictError({
    field,
    message: `Cannot change the ${field} port assignment while the stack is running`,
  });

export const makePortCoordinator = (
  registry: PortRegistry,
  store: StackStateStore,
  options: PortCoordinatorOptions = {},
): PortCoordinator => ({
  planAndReserve: (stackId, listenerIntents, planOptions = {}) =>
    Effect.gen(function* () {
      const committed = yield* registry.withLock(
        Effect.gen(function* () {
          const current = yield* store.read(stackId);
          if (current === undefined)
            return yield* new StackStateInvalidError({
              message: "Cannot allocate ports for an unconfigured stack",
            });
          const expected = planOptions.expectedGeneration ?? current.desiredGeneration;
          if (current.desiredGeneration !== expected)
            return yield* new StackStateGenerationMismatchError({
              expectedGeneration: expected,
              actualGeneration: current.desiredGeneration,
              message: "Persisted stack state generation changed",
            });
          const lifecycle =
            planOptions.lifecycle ??
            (current.desiredLifecycle === "running" ? "running" : "stopped");
          const runtime = planOptions.runtime ?? current.runtime;
          const allStates = yield* registry.states;
          const usedAutomatic = new Set<number>();
          const usedLive = new Set<number>();
          const usedReserved = new Set<number>();
          for (const entry of allStates) {
            if (entry.stackId === stackId) continue;
            for (const assignment of entry.state.ports) {
              usedReserved.add(assignment.port);
              if (assignment.intent === "automatic") usedAutomatic.add(assignment.port);
              if (entry.state.desiredLifecycle === "running") usedLive.add(assignment.port);
            }
          }
          const existing = assignmentMap(current.ports);
          if (lifecycle === "running" && current.desiredLifecycle === "running") {
            for (const field of fields) {
              const intent = listenerIntents[field];
              const prior = existing.get(field);
              const unchanged =
                intent.enabled && prior !== undefined
                  ? intent.port === "automatic"
                    ? prior.intent === "automatic"
                    : prior.intent === "exact" && prior.port === intent.port
                  : !intent.enabled && prior === undefined;
              if (!unchanged) return yield* lifecycleConflict(field);
            }
          }
          const assignments: HostPortAssignment[] = [];
          const byField: Partial<Record<PortField, HostPortAssignment>> = {};
          const usedByThisStack = new Set<number>();
          for (const field of fields) {
            const intent = listenerIntents[field];
            if (!intent.enabled) continue;
            const prior = existing.get(field);
            let assignment: HostPortAssignment;
            if (intent.port === "automatic") {
              if (prior?.intent === "automatic" && !usedByThisStack.has(prior.port)) {
                assignment = prior;
              } else {
                let selected: number | undefined;
                for (let port = 40_000; port <= 65_535; port += 1) {
                  if (
                    !usedAutomatic.has(port) &&
                    !usedLive.has(port) &&
                    !usedReserved.has(port) &&
                    !usedByThisStack.has(port)
                  ) {
                    if (options.checkHostPort !== undefined) {
                      const available = yield* options.checkHostPort(intent.address, port, field);
                      if (!available) continue;
                    }
                    selected = port;
                    break;
                  }
                }
                if (selected === undefined)
                  return yield* new PortAllocationError({
                    field,
                    message: "No automatic host port is available",
                  });
                assignment = { field, port: selected, intent: "automatic" };
                usedAutomatic.add(selected);
              }
            } else {
              if (!validPort(intent.port)) return yield* unavailable(intent.port, field);
              if (usedAutomatic.has(intent.port))
                return yield* automaticConflict(intent.port, field);
              if (usedByThisStack.has(intent.port)) return yield* unavailable(intent.port, field);
              if (lifecycle === "running" && usedLive.has(intent.port))
                return yield* unavailable(intent.port, field);
              assignment = { field, port: intent.port, intent: "exact" };
            }
            assignments.push(assignment);
            byField[field] = assignment;
            usedByThisStack.add(assignment.port);
          }
          const next: PersistedStackState = {
            ...current,
            // Keep a running lifecycle only after ownership/publication succeeds.
            desiredLifecycle: lifecycle === "running" ? current.desiredLifecycle : lifecycle,
            desiredGeneration: planOptions.nextGeneration ?? current.desiredGeneration,
            ports: assignments,
          };
          yield* store.replaceUnlocked(stackId, next, expected);
          return { current, next, lifecycle, runtime, byField };
        }),
      );

      const nativeListeners: NativeListener[] = [];
      const runningState: PersistedStackState = {
        ...committed.next,
        desiredLifecycle: "running",
      };
      const commitRunning = registry.withLock(
        Effect.gen(function* () {
          const latest = yield* store.read(stackId);
          if (latest === undefined || latest.desiredGeneration !== committed.next.desiredGeneration)
            return yield* new StackStateGenerationMismatchError({
              expectedGeneration: committed.next.desiredGeneration,
              actualGeneration: latest?.desiredGeneration,
              message: "Persisted stack state changed while acquiring runtime ownership",
            });
          yield* store.replaceUnlocked(stackId, runningState, latest.desiredGeneration);
        }),
      );
      const enabledAssignments = fields.flatMap((field) => {
        const intent = listenerIntents[field];
        const assignment = committed.byField[field];
        return intent.enabled && assignment !== undefined ? [{ field, intent, assignment }] : [];
      });
      if (committed.lifecycle === "running" && committed.runtime.kind === "native") {
        if (options.bindNative === undefined) {
          const first = enabledAssignments[0];
          return yield* unavailable(first?.assignment.port ?? 0, first?.field ?? "api");
        }
        const bindNative = options.bindNative;
        const parentScope = yield* Scope.Scope;
        const acquired = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const listenerScope = yield* Scope.fork(parentScope, "sequential");
            const bound = yield* Effect.exit(
              restore(
                Effect.forEach(enabledAssignments, ({ field, intent, assignment }) =>
                  bindNative(intent.address, assignment.port, field).pipe(
                    Effect.catchTag("PortUnavailableError", () =>
                      Effect.fail(unavailable(assignment.port, field)),
                    ),
                    Effect.provideService(Scope.Scope, listenerScope),
                  ),
                ),
              ),
            );
            if (Exit.isFailure(bound)) {
              yield* Scope.close(listenerScope, bound);
              return yield* Effect.failCause(bound.cause);
            }
            const committedRunning = yield* Effect.exit(restore(commitRunning));
            if (Exit.isFailure(committedRunning)) {
              yield* Scope.close(listenerScope, committedRunning);
              return yield* Effect.failCause(committedRunning.cause);
            }
            return bound.value;
          }),
        );
        nativeListeners.push(...acquired);
      }
      if (committed.lifecycle === "running" && committed.runtime.kind === "container") {
        if (options.publishContainer === undefined) {
          const first = enabledAssignments[0];
          return yield* unavailable(first?.assignment.port ?? 0, first?.field ?? "api");
        }
        for (const { field, intent, assignment } of enabledAssignments)
          yield* options.publishContainer(intent.address, assignment.port, field);
      }

      if (committed.lifecycle === "running" && committed.runtime.kind !== "native")
        yield* commitRunning;
      return { assignments: committed.byField, nativeListeners };
    }),
});
