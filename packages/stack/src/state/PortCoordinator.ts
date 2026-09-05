import { Cause, Crypto, Effect, Exit, FileSystem, Option, Path, Scope, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Server as HttpServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Server as NetServer } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Duplex } from "node:stream";
import { NetworkPortSchema, PORT_FIELDS, type PortField } from "../public/Status.ts";
import {
  PortAllocationError,
  PortUnavailableError,
  InvalidProjectRootError,
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import type {
  HostPortAssignment,
  PersistedStackState,
  PrivatePortAssignment,
} from "./StackState.ts";
import { isMissingStateRemnantError, type StackStateStore } from "./StackStateStore.ts";
import { withRegistryLock } from "./StackStateStore.ts";

interface ListenerIntent {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

export type ListenerIntents = Readonly<Record<PortField, ListenerIntent>>;

/** A workload endpoint reachable by the host gateway on a durable loopback port. */
interface PrivatePortIntent {
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
  /** Sockets accepted since bind, shared with an adopting gateway for teardown. */
  readonly connections: HostListenerConnections;
}

export interface HostListenerConnections {
  readonly sockets: Set<Duplex>;
}

type HostListenerBinding =
  | { readonly kind: "http"; readonly server: HttpServer }
  | { readonly kind: "tcp"; readonly server: NetServer; readonly allowHalfOpen: true };

interface PortPlanOptions {
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
  readonly stateRoot: string;
  readonly store: StackStateStore;
  /** Probes a fresh automatic candidate without retaining a listener. */
  readonly checkHostPort: (
    address: string,
    port: number,
    field: string,
  ) => Effect.Effect<void, PortUnavailableError>;
  /** Binds and retains a host listener. The enclosing Scope owns its release. */
  readonly bindHost: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<HostListener, PortUnavailableError, Scope.Scope>;
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
    | StackStateInvalidError
    | StackStateFormatUnsupportedError
    | InvalidProjectRootError,
    Scope.Scope | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >;
}

const fields: ReadonlyArray<PortField> = PORT_FIELDS;
const PRIVATE_PORT_MIN = 30_000;
const PRIVATE_PORT_MAX = 39_999;
const PUBLIC_PORT_MIN = 40_000;
const PUBLIC_PORT_MAX = 65_535;
const MAX_FAILED_HOST_PROBES = 16;
const MAX_FRESH_BIND_RETRIES = 16;

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

const idPattern = /^[0-9a-f]{64}$/;

const readAuthoritativeStates = (options: PortCoordinatorOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(options.stateRoot);
    const exists = yield* fs
      .exists(root)
      .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message })));
    if (!exists) return [];
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message })));
    const ids = entries.filter((entry) => idPattern.test(entry));
    const values = yield* Effect.forEach(ids, (stackId) =>
      options.store.read(stackId).pipe(
        Effect.catchIf(isMissingStateRemnantError, () => Effect.void),
        Effect.map((state) => (state === undefined ? undefined : { stackId, state })),
      ),
    );
    return values.filter(
      (entry): entry is { readonly stackId: string; readonly state: PersistedStackState } =>
        entry !== undefined,
    );
  });

export const makePortCoordinator = (options: PortCoordinatorOptions): PortCoordinator => ({
  planAndReserve: (stackId, listenerIntents, planOptions = {}) =>
    Effect.gen(function* () {
      const excludedFreshPublic = new Set<number>();
      let failedBindAttempts = 0;
      while (true) {
        const committed = yield* withRegistryLock(
          options.stateRoot,
          Effect.gen(function* () {
            const current = yield* options.store.read(stackId);
            if (current === undefined)
              return yield* new StackStateInvalidError({
                message: "Cannot allocate ports for an unconfigured stack",
              });
            const lifecycle = current.desiredLifecycle === "running" ? "running" : "stopped";
            const allStates = yield* readAuthoritativeStates(options);
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
                  let failedHostProbes = 0;
                  let probeBudgetExhausted = false;
                  for (let port = PUBLIC_PORT_MIN; port <= PUBLIC_PORT_MAX; port += 1) {
                    if (
                      !usedAutomaticPublic.has(port) &&
                      !usedLivePublic.has(port) &&
                      !usedReservedPublic.has(port) &&
                      !usedReservedPrivate.has(port) &&
                      !usedByThisStack.has(port) &&
                      !excludedFreshPublic.has(port)
                    ) {
                      const available = yield* options
                        .checkHostPort(intent.address, port, field)
                        .pipe(
                          Effect.as(true),
                          Effect.catchTag("PortUnavailableError", () => Effect.succeed(false)),
                        );
                      if (!available) {
                        failedHostProbes += 1;
                        if (failedHostProbes >= MAX_FAILED_HOST_PROBES) {
                          probeBudgetExhausted = true;
                          break;
                        }
                        continue;
                      }
                      selected = port;
                      break;
                    }
                  }
                  if (selected === undefined)
                    return yield* new PortAllocationError({
                      field,
                      message: probeBudgetExhausted
                        ? `No automatic public host port is available after ${MAX_FAILED_HOST_PROBES} occupied candidates`
                        : "No automatic host port is available",
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
              let probeBudgetExhausted = false;
              if (prior !== undefined && !usedPrivateByThisStack.has(prior.port)) port = prior.port;
              else {
                let failedHostProbes = 0;
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
                    const available = yield* options
                      .checkHostPort(
                        "127.0.0.1",
                        candidate,
                        `${intent.workloadId}:${intent.binding}`,
                      )
                      .pipe(
                        Effect.as(true),
                        Effect.catchTag("PortUnavailableError", () => Effect.succeed(false)),
                      );
                    if (!available) {
                      failedHostProbes += 1;
                      if (failedHostProbes >= MAX_FAILED_HOST_PROBES) {
                        probeBudgetExhausted = true;
                        break;
                      }
                      continue;
                    }
                    port = candidate;
                    break;
                  }
                }
              }
              if (port === undefined)
                return yield* new PortAllocationError({
                  field: `${intent.workloadId}:${intent.binding}`,
                  message: probeBudgetExhausted
                    ? `No automatic private port is available after ${MAX_FAILED_HOST_PROBES} occupied candidates`
                    : "No automatic private port is available",
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
              // Lifecycle is owned by Supervisor; port planning never mutates it.
              desiredLifecycle: current.desiredLifecycle,
              ports: assignments,
              privatePorts: privateAssignments,
            };
            yield* options.store.replaceUnlocked(stackId, next);
            return { current, next, lifecycle, byField, privateAssignments };
          }),
        );

        const hostListeners: HostListener[] = [];
        const enabledAssignments = fields.flatMap((field) => {
          const intent = listenerIntents[field];
          const assignment = committed.byField[field];
          return intent.enabled && assignment !== undefined ? [{ field, intent, assignment }] : [];
        });
        const priorByField = new Map(committed.current.ports.map((entry) => [entry.field, entry]));
        const rollbackFreshAutomatic = withRegistryLock(
          options.stateRoot,
          Effect.gen(function* () {
            const latest = yield* options.store.read(stackId);
            if (latest === undefined)
              return yield* new StackStateInvalidError({ message: "Stack state disappeared" });
            const ports = committed.next.ports.filter((entry) => {
              if (entry.intent !== "automatic") return true;
              const prior = priorByField.get(entry.field);
              return prior?.intent === "automatic" && prior.port === entry.port;
            });
            const priorBindings = new Set(committed.current.privatePorts.map(bindingKey));
            const privatePorts = committed.next.privatePorts.filter((entry) =>
              priorBindings.has(bindingKey(entry)),
            );
            yield* options.store.replaceUnlocked(stackId, { ...latest, ports, privatePorts });
          }),
        );
        if (committed.lifecycle === "running") {
          const parentScope = yield* Scope.Scope;
          type BindingResult =
            | { readonly retryPort: number }
            | { readonly listeners: ReadonlyArray<HostListener> };
          const bindingResult: BindingResult = yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const listenerScope = yield* Scope.fork(parentScope, "sequential");
              const bound = yield* Effect.exit(
                restore(
                  Effect.forEach(enabledAssignments, ({ field, intent, assignment }) =>
                    options.bindHost(intent.address, assignment.port, field).pipe(
                      Effect.catchTag("PortUnavailableError", (error) =>
                        Effect.fail(
                          new PortUnavailableError({
                            field,
                            port: assignment.port,
                            message: error.message,
                            ...(error.cause === undefined ? {} : { cause: error.cause }),
                          }),
                        ),
                      ),
                      Effect.provideService(Scope.Scope, listenerScope),
                    ),
                  ),
                ),
              );
              if (Exit.isFailure(bound)) {
                yield* Scope.close(listenerScope, bound);
                const bindError = Option.getOrUndefined(Cause.findErrorOption(bound.cause));
                const failedAssignment =
                  bindError instanceof PortUnavailableError
                    ? enabledAssignments.find(
                        ({ field, assignment }) =>
                          field === bindError.field && assignment.port === bindError.port,
                      )
                    : undefined;
                const prior =
                  failedAssignment === undefined
                    ? undefined
                    : priorByField.get(failedAssignment.field);
                const freshAutomaticFailure =
                  failedAssignment !== undefined &&
                  failedAssignment.assignment.intent === "automatic" &&
                  (prior === undefined ||
                    prior.intent !== "automatic" ||
                    prior.port !== failedAssignment.assignment.port)
                    ? failedAssignment
                    : undefined;
                if (freshAutomaticFailure && failedBindAttempts < MAX_FRESH_BIND_RETRIES) {
                  const failedPort = freshAutomaticFailure.assignment.port;
                  yield* rollbackFreshAutomatic;
                  return { retryPort: failedPort };
                }
                yield* rollbackFreshAutomatic;
                if (freshAutomaticFailure) {
                  return yield* new PortUnavailableError({
                    field: freshAutomaticFailure.field,
                    port: freshAutomaticFailure.assignment.port,
                    message: `Could not bind an automatic public host port for ${freshAutomaticFailure.field} after ${MAX_FRESH_BIND_RETRIES + 1} candidates`,
                    cause: bindError,
                  });
                }
                return yield* Effect.failCause(bound.cause);
              }
              return { listeners: bound.value };
            }),
          );
          if ("retryPort" in bindingResult) {
            excludedFreshPublic.add(bindingResult.retryPort);
            failedBindAttempts += 1;
            continue;
          }
          hostListeners.push(...bindingResult.listeners);
        }

        return {
          assignments: committed.byField,
          privateAssignments: committed.privateAssignments,
          hostListeners,
        };
      }
    }),
});
