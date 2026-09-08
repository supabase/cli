import { Crypto, Effect, Exit, FileSystem, Path, Scope, Schema } from "effect";
import { NetworkPortSchema, PORT_FIELDS, type PortField } from "../public/Status.ts";
import {
  InvalidProjectRootError,
  PortAllocationError,
  PortUnavailableError,
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import type {
  HostPortAssignment,
  PersistedStackState,
  PrivatePortAssignment,
} from "./StackState.ts";
import {
  isMissingStateRemnantError,
  type StackStateStore,
  withRegistryLock,
} from "./StackStateStore.ts";
import type { HeldPort, HostListener } from "../supervisor/HostListener.ts";

interface ListenerIntent {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

export type ListenerIntents = Readonly<Record<PortField, ListenerIntent>>;

interface PrivatePortIntent {
  readonly workloadId: string;
  readonly binding: string;
}

export interface PortReservation {
  readonly assignments: Readonly<Partial<Record<PortField, HostPortAssignment>>>;
  readonly privateAssignments: ReadonlyArray<PrivatePortAssignment>;
  readonly hostListeners: ReadonlyArray<HostListener>;
}

export interface PortCoordinatorOptions {
  readonly stateRoot: string;
  readonly store: StackStateStore;
  readonly bindHost: (
    address: string,
    port: number,
    field: PortField,
  ) => Effect.Effect<HostListener, PortUnavailableError, Scope.Scope>;
  readonly bindPrivate: (
    address: string,
    port: number,
    binding: string,
  ) => Effect.Effect<HeldPort, PortUnavailableError, Scope.Scope>;
}

export interface PortCoordinator {
  readonly acquire: (
    stackId: string,
    listenerIntents: ListenerIntents,
    privateBindings: ReadonlyArray<PrivatePortIntent>,
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
const PORT_MIN = 20_000;
const PORT_MAX = 32_767;
const PORT_POOL_SIZE = PORT_MAX - PORT_MIN + 1;
const PORT_STRIDE = 257;
const MAX_FRESH_BIND_FAILURES = 64;
const idPattern = /^[0-9a-f]{64}$/;

const assignmentMap = (assignments: ReadonlyArray<HostPortAssignment>) =>
  new Map(assignments.map((assignment) => [assignment.field, assignment]));
const bindingKey = (assignment: Pick<PrivatePortAssignment, "workloadId" | "binding">): string =>
  `${assignment.workloadId}\u0000${assignment.binding}`;
const validPort = (port: number): boolean => Schema.is(NetworkPortSchema)(port);
const unavailable = (
  port: number,
  field: string,
  message = `Port ${port} for ${field} is unavailable`,
) => new PortUnavailableError({ port, field, message });
const allocation = (field: string, message: string, cause?: unknown) =>
  new PortAllocationError({ field, message, ...(cause === undefined ? {} : { cause }) });

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
    const values = yield* Effect.forEach(ids, (id) =>
      options.store.read(id).pipe(
        Effect.mapError((error) =>
          error instanceof StackStateFormatUnsupportedError
            ? new StackStateFormatUnsupportedError({
                ...error,
                message: `Unable to read sibling stack state ${id}: ${error.message}`,
              })
            : error instanceof StackStateInvalidError
              ? new StackStateInvalidError({
                  ...error,
                  message: `Unable to read sibling stack state ${id}: ${error.message}`,
                  path: path.join(root, id, "state.json"),
                })
              : error,
        ),
        Effect.catchIf(isMissingStateRemnantError, () => Effect.void),
        Effect.map((state) => (state === undefined ? undefined : { stackId: id, state })),
      ),
    );
    return values.filter(
      (entry): entry is { readonly stackId: string; readonly state: PersistedStackState } =>
        entry !== undefined,
    );
  });

type ForeignPublicOwner = {
  readonly stackId: string;
  readonly field: string;
  readonly intent: "automatic" | "exact";
  readonly lifecycle: PersistedStackState["desiredLifecycle"];
};
type ForeignPrivateOwner = {
  readonly stackId: string;
  readonly field: string;
};
const ownerText = (owner: ForeignPublicOwner | ForeignPrivateOwner): string =>
  `${owner.stackId} (${owner.field})`;

const nativeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !Reflect.has(cause, "code")) return undefined;
  const code = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
};
const retryable = (error: PortUnavailableError): boolean => {
  const code = nativeCode(error.cause);
  return code === "EADDRINUSE" || code === "EACCES";
};

export const makePortCoordinator = (options: PortCoordinatorOptions): PortCoordinator => ({
  acquire: (stackId, listenerIntents, privateBindings) =>
    withRegistryLock(
      options.stateRoot,
      Effect.gen(function* () {
        const current = yield* options.store.read(stackId);
        if (current === undefined)
          return yield* new StackStateInvalidError({
            message: "Cannot acquire ports for an unconfigured stack",
          });
        if (current.desiredLifecycle !== "running")
          return yield* new StackStateInvalidError({
            message: "Port acquisition requires desiredLifecycle=running",
          });

        const publicOwners = new Map<number, ReadonlyArray<ForeignPublicOwner>>();
        const privateOwners = new Map<number, ForeignPrivateOwner>();
        for (const entry of yield* readAuthoritativeStates(options)) {
          if (entry.stackId === stackId) continue;
          for (const assignment of entry.state.ports) {
            const owner: ForeignPublicOwner = {
              stackId: entry.stackId,
              field: assignment.field,
              intent: assignment.intent,
              lifecycle: entry.state.desiredLifecycle,
            };
            publicOwners.set(assignment.port, [
              ...(publicOwners.get(assignment.port) ?? []),
              owner,
            ]);
          }
          for (const assignment of entry.state.privatePorts)
            privateOwners.set(assignment.port, {
              stackId: entry.stackId,
              field: `${assignment.workloadId}:${assignment.binding}`,
            });
        }

        const existingPublic = assignmentMap(current.ports);
        const existingPrivate = new Map(
          current.privatePorts.map((entry) => [bindingKey(entry), entry]),
        );
        const retainedPublic = new Map<PortField, HostPortAssignment>();
        const retainedPrivate = new Map<string, PrivatePortAssignment>();
        const hardClaims = new Map<number, string>();
        const occupied = new Set<number>();
        const claim = (port: number, field: string): PortAllocationError | undefined => {
          const previous = hardClaims.get(port);
          if (previous !== undefined)
            return allocation(field, `Port ${port} is claimed by both ${previous} and ${field}`);
          hardClaims.set(port, field);
          occupied.add(port);
          return undefined;
        };
        const foreignConflict = (port: number, field: string): PortUnavailableError | undefined => {
          const privateOwner = privateOwners.get(port);
          if (privateOwner !== undefined)
            return unavailable(
              port,
              field,
              `Port ${port} for ${field} is reserved by ${ownerText(privateOwner)}`,
            );
          const owners = publicOwners.get(port);
          const conflict = owners?.find(
            (owner) => owner.intent === "automatic" || owner.lifecycle === "running",
          );
          if (conflict !== undefined)
            return unavailable(
              port,
              field,
              `Port ${port} for ${field} is reserved by ${ownerText(conflict)}`,
            );
          return undefined;
        };

        // Preseed every own retained assignment before allocating any fresh field.
        for (const field of fields) {
          const intent = listenerIntents[field];
          const prior = existingPublic.get(field);
          if (!intent.enabled || intent.port !== "automatic" || prior?.intent !== "automatic")
            continue;
          if (!validPort(prior.port)) return yield* unavailable(prior.port, field);
          const foreign = foreignConflict(prior.port, field);
          if (foreign !== undefined) return yield* foreign;
          const duplicate = claim(prior.port, field);
          if (duplicate !== undefined) return yield* duplicate;
          retainedPublic.set(field, prior);
        }
        const requestedPrivate = new Map<string, PrivatePortIntent>();
        for (const intent of privateBindings) {
          const key = bindingKey(intent);
          if (intent.workloadId.length === 0 || intent.binding.length === 0)
            return yield* allocation(
              `${intent.workloadId}:${intent.binding}`,
              "Private workload binding is invalid",
            );
          if (requestedPrivate.has(key))
            return yield* allocation(
              `${intent.workloadId}:${intent.binding}`,
              "Duplicate private workload binding",
            );
          requestedPrivate.set(key, intent);
          const prior = existingPrivate.get(key);
          if (prior === undefined) continue;
          const label = `${intent.workloadId}:${intent.binding}`;
          if (!validPort(prior.port)) return yield* unavailable(prior.port, label);
          const foreign = foreignConflict(prior.port, label);
          if (foreign !== undefined) return yield* foreign;
          const duplicate = claim(prior.port, label);
          if (duplicate !== undefined) return yield* duplicate;
          retainedPrivate.set(key, prior);
        }
        const exactAssignments = new Map<PortField, HostPortAssignment>();
        for (const field of fields) {
          const intent = listenerIntents[field];
          if (!intent.enabled || intent.port === "automatic") continue;
          if (!validPort(intent.port)) return yield* unavailable(intent.port, field);
          const foreign = foreignConflict(intent.port, field);
          if (foreign !== undefined) return yield* foreign;
          const duplicate = claim(intent.port, field);
          if (duplicate !== undefined) return yield* duplicate;
          exactAssignments.set(field, { field, port: intent.port, intent: "exact" });
        }
        for (const port of publicOwners.keys()) occupied.add(port);
        for (const port of privateOwners.keys()) occupied.add(port);

        const crypto = yield* Crypto.Crypto;
        const randomStart = yield* crypto.randomIntBetween(0, PORT_POOL_SIZE - 1);
        let offset = 0;
        const allocateFresh = <A>(
          field: string,
          bind: (port: number) => Effect.Effect<A, PortUnavailableError, Scope.Scope>,
        ): Effect.Effect<
          { readonly port: number; readonly value: A },
          PortAllocationError | PortUnavailableError,
          Scope.Scope
        > =>
          Effect.gen(function* () {
            let failures = 0;
            while (true) {
              if (offset >= PORT_POOL_SIZE)
                return yield* allocation(
                  field,
                  "No automatic port is available in the shared 20000-32767 pool",
                );
              const port = PORT_MIN + ((randomStart + offset * PORT_STRIDE) % PORT_POOL_SIZE);
              offset += 1;
              if (occupied.has(port)) continue;
              const result = yield* bind(port).pipe(
                Effect.map((value) => ({ ok: true as const, value })),
                Effect.catchTag("PortUnavailableError", (error) =>
                  retryable(error)
                    ? Effect.succeed({ ok: false as const, error })
                    : Effect.fail(error),
                ),
              );
              if (result.ok) {
                occupied.add(port);
                return { port, value: result.value };
              }
              failures += 1;
              if (failures >= MAX_FRESH_BIND_FAILURES)
                return yield* allocation(
                  field,
                  `No automatic port is available after ${MAX_FRESH_BIND_FAILURES} bind failures`,
                  result.error.cause,
                );
            }
          });

        const parentScope = yield* Scope.Scope;
        const result = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const attemptScope = yield* Scope.fork(parentScope, "sequential");
            const acquired = yield* restore(
              Effect.gen(function* () {
                const privateScope = yield* Scope.fork(attemptScope, "sequential");
                const assignments: HostPortAssignment[] = [];
                const byField: Partial<Record<PortField, HostPortAssignment>> = {};
                const listeners: HostListener[] = [];
                for (const field of fields) {
                  const intent = listenerIntents[field];
                  if (!intent.enabled) continue;
                  const retained = retainedPublic.get(field);
                  const exact = exactAssignments.get(field);
                  const assignment = retained ?? exact;
                  if (assignment !== undefined) {
                    const listener = yield* options
                      .bindHost(intent.address, assignment.port, field)
                      .pipe(Effect.provideService(Scope.Scope, attemptScope));
                    assignments.push(assignment);
                    byField[field] = assignment;
                    listeners.push(listener);
                    occupied.add(assignment.port);
                    continue;
                  }
                  const fresh = yield* allocateFresh(field, (port) =>
                    options
                      .bindHost(intent.address, port, field)
                      .pipe(Effect.provideService(Scope.Scope, attemptScope)),
                  );
                  const assignmentFresh: HostPortAssignment = {
                    field,
                    port: fresh.port,
                    intent: "automatic",
                  };
                  assignments.push(assignmentFresh);
                  byField[field] = assignmentFresh;
                  listeners.push(fresh.value);
                }

                const privateAssignments: PrivatePortAssignment[] = [];
                for (const intent of requestedPrivate.values()) {
                  const key = bindingKey(intent);
                  const label = `${intent.workloadId}:${intent.binding}`;
                  const retained = retainedPrivate.get(key);
                  if (retained !== undefined) {
                    const held = yield* options
                      .bindPrivate("127.0.0.1", retained.port, label)
                      .pipe(Effect.provideService(Scope.Scope, privateScope));
                    privateAssignments.push({ ...retained, port: held.port });
                    occupied.add(retained.port);
                    continue;
                  }
                  const fresh = yield* allocateFresh(label, (port) =>
                    options
                      .bindPrivate("127.0.0.1", port, label)
                      .pipe(Effect.provideService(Scope.Scope, privateScope)),
                  );
                  privateAssignments.push({
                    workloadId: intent.workloadId,
                    binding: intent.binding,
                    port: fresh.port,
                  });
                }
                const next: PersistedStackState = {
                  ...current,
                  ports: assignments,
                  privatePorts: privateAssignments,
                };
                yield* options.store.replaceUnlocked(stackId, next);
                yield* Scope.close(privateScope, Exit.void);
                return { assignments: byField, privateAssignments, hostListeners: listeners };
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) ? Effect.void : Scope.close(attemptScope, exit),
                ),
              ),
            );
            return acquired;
          }),
        );
        return result;
      }),
    ),
});
