import { Crypto, Effect, Exit, FileSystem, Path, Scope, Schema } from "effect";
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
import type {
  HostPortAssignment,
  PersistedStackState,
  PrivatePortAssignment,
} from "./StackState.ts";
import type { StackStateStore } from "./StackStateStore.ts";
import type { PortRegistry } from "./PortRegistry.ts";

export interface ListenerIntent {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

export type ListenerIntents = Readonly<Record<PortField, ListenerIntent>>;

/** A workload endpoint reachable by the host gateway on a durable loopback port. */
export interface PrivatePortIntent {
  readonly workloadId: string;
  readonly binding: string;
}

export interface HostListener {
  readonly field: PortField;
  readonly address: string;
  readonly port: number;
  readonly close: Effect.Effect<void>;
  /** The exact bound listener may be adopted by a gateway without rebind. */
  readonly binding: HostListenerBinding;
}

export type HostListenerBinding =
  | { readonly kind: "http"; readonly server: HttpServer }
  | { readonly kind: "tcp"; readonly server: NetServer; readonly allowHalfOpen: true };

export interface PortPlanOptions {
  readonly lifecycle?: "stopped" | "running";
  readonly expectedGeneration?: number;
  /** Generation to persist after this transaction; unchanged unless explicitly supplied. */
  readonly nextGeneration?: number;
  /** Requested durable workload endpoints. Every binding receives an automatic port. */
  readonly privateBindings?: ReadonlyArray<PrivatePortIntent>;
}

export interface PortReservation {
  readonly assignments: Readonly<Partial<Record<PortField, HostPortAssignment>>>;
  readonly privateAssignments: ReadonlyArray<PrivatePortAssignment>;
  /** Already-bound host listeners that can be adopted by a gateway. */
  readonly hostListeners: ReadonlyArray<HostListener>;
}

export interface PortCoordinatorOptions {
  /** Binds and retains a host listener. The enclosing Scope owns its release. */
  readonly bindHost?: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<HostListener, PortUnavailableError, Scope.Scope>;
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
const PRIVATE_PORT_MIN = 30_000;
const PRIVATE_PORT_MAX = 39_999;
const PUBLIC_PORT_MIN = 40_000;
const PUBLIC_PORT_MAX = 65_535;

const assignmentMap = (assignments: ReadonlyArray<HostPortAssignment>) =>
  new Map(assignments.map((assignment) => [assignment.field, assignment]));

const bindingKey = (assignment: Pick<PrivatePortAssignment, "workloadId" | "binding">): string =>
  `${assignment.workloadId}\u0000${assignment.binding}`;

const validPort = (port: number): boolean => Schema.is(NetworkPortSchema)(port);

const unavailable = (port: number, field: PortField) =>
  new PortUnavailableError({ port, field, message: `Port ${port} for ${field} is unavailable` });

const automaticConflict = (port: number, field: PortField) =>
  new PortAllocationError({
    port,
    field,
    message: `Port ${port} for ${field} is reserved by another stack's automatic assignment`,
  });

const lifecycleConflict = (field: string) =>
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
          const allStates = yield* registry.states;
          const usedAutomaticPublic = new Set<number>();
          const usedLivePublic = new Set<number>();
          const usedReservedPublic = new Set<number>();
          const usedReservedPrivate = new Set<number>();
          for (const entry of allStates) {
            if (entry.stackId === stackId) continue;
            for (const assignment of entry.state.ports) {
              usedReservedPublic.add(assignment.port);
              if (assignment.intent === "automatic") usedAutomaticPublic.add(assignment.port);
              if (entry.state.desiredLifecycle === "running") usedLivePublic.add(assignment.port);
            }
            for (const assignment of entry.state.privatePorts)
              usedReservedPrivate.add(assignment.port);
          }

          const existing = assignmentMap(current.ports);
          const requestedPrivate = planOptions.privateBindings;
          const privateIntents: ReadonlyArray<PrivatePortIntent> =
            requestedPrivate ??
            current.privatePorts.map(({ workloadId, binding }) => ({
              workloadId,
              binding,
            }));
          const existingPrivate = new Map(
            current.privatePorts.map((entry) => [bindingKey(entry), entry]),
          );

          // A newly accepted generation has running durable intent before its first ingress
          // acquisition, but has no assignments yet. Enforce the no-change fence only once the
          // prior generation actually owns ports; this preserves same-generation no-rebind while
          // allowing the initial listener transaction to materialize its assignments.
          if (
            lifecycle === "running" &&
            current.desiredLifecycle === "running" &&
            (current.ports.length > 0 || current.privatePorts.length > 0)
          ) {
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
            const priorKeys = new Set(current.privatePorts.map(bindingKey));
            const nextKeys = new Set(privateIntents.map(bindingKey));
            if (
              priorKeys.size !== nextKeys.size ||
              [...priorKeys].some((key) => !nextKeys.has(key))
            )
              return yield* lifecycleConflict("private workload");
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
                for (let port = PUBLIC_PORT_MIN; port <= PUBLIC_PORT_MAX; port += 1) {
                  if (
                    !usedAutomaticPublic.has(port) &&
                    !usedLivePublic.has(port) &&
                    !usedReservedPublic.has(port) &&
                    !usedReservedPrivate.has(port) &&
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
                usedAutomaticPublic.add(selected);
              }
            } else {
              if (!validPort(intent.port)) return yield* unavailable(intent.port, field);
              if (usedAutomaticPublic.has(intent.port))
                return yield* automaticConflict(intent.port, field);
              if (usedReservedPrivate.has(intent.port))
                return yield* unavailable(intent.port, field);
              if (usedByThisStack.has(intent.port)) return yield* unavailable(intent.port, field);
              if (lifecycle === "running" && usedLivePublic.has(intent.port))
                return yield* unavailable(intent.port, field);
              assignment = { field, port: intent.port, intent: "exact" };
            }
            assignments.push(assignment);
            byField[field] = assignment;
            usedByThisStack.add(assignment.port);
          }

          const privateAssignments: PrivatePortAssignment[] = [];
          const usedPrivateByThisStack = new Set<number>();
          const usedAllByThisStack = new Set(usedByThisStack);
          for (const intent of privateIntents) {
            if (intent.workloadId.length === 0 || intent.binding.length === 0)
              return yield* new PortAllocationError({
                field: `${intent.workloadId}:${intent.binding}`,
                message: "Private workload binding is invalid",
              });
            const key = bindingKey(intent);
            if (privateAssignments.some((entry) => bindingKey(entry) === key))
              return yield* new PortAllocationError({
                field: `${intent.workloadId}:${intent.binding}`,
                message: "Duplicate private workload binding",
              });
            const prior = existingPrivate.get(key);
            let port: number | undefined;
            if (prior !== undefined && !usedPrivateByThisStack.has(prior.port)) port = prior.port;
            else {
              for (
                let candidate = PRIVATE_PORT_MIN;
                candidate <= PRIVATE_PORT_MAX;
                candidate += 1
              ) {
                if (
                  !usedReservedPrivate.has(candidate) &&
                  !usedReservedPublic.has(candidate) &&
                  !usedPrivateByThisStack.has(candidate) &&
                  !usedAllByThisStack.has(candidate)
                ) {
                  port = candidate;
                  break;
                }
              }
            }
            if (port === undefined)
              return yield* new PortAllocationError({
                field: `${intent.workloadId}:${intent.binding}`,
                message: "No automatic private port is available",
              });
            privateAssignments.push({
              workloadId: intent.workloadId,
              binding: intent.binding,
              port,
            });
            usedPrivateByThisStack.add(port);
            usedAllByThisStack.add(port);
          }

          const next: PersistedStackState = {
            ...current,
            // Keep a running lifecycle only after ownership/publication succeeds.
            desiredLifecycle: lifecycle === "running" ? current.desiredLifecycle : lifecycle,
            desiredGeneration: planOptions.nextGeneration ?? current.desiredGeneration,
            ports: assignments,
            privatePorts: privateAssignments,
          };
          yield* store.replaceUnlocked(stackId, next, expected);
          return { current, next, lifecycle, byField, privateAssignments };
        }),
      );

      const hostListeners: HostListener[] = [];
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
      if (committed.lifecycle === "running") {
        const bindHost = options.bindHost;
        if (bindHost === undefined) {
          const first = enabledAssignments[0];
          return yield* unavailable(first?.assignment.port ?? 0, first?.field ?? "api");
        }
        const parentScope = yield* Scope.Scope;
        const acquired = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const listenerScope = yield* Scope.fork(parentScope, "sequential");
            const bound = yield* Effect.exit(
              restore(
                Effect.forEach(enabledAssignments, ({ field, intent, assignment }) =>
                  bindHost(intent.address, assignment.port, field).pipe(
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
        hostListeners.push(...acquired);
      }

      return {
        assignments: committed.byField,
        privateAssignments: committed.privateAssignments,
        hostListeners,
      };
    }),
});
