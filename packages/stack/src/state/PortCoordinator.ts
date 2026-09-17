import { Crypto, Effect, Exit, FileSystem, Path, Scope, Schema } from "effect";
import { NetworkPortSchema, type PortField } from "../public/Status.ts";
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
import { privateBindingKey } from "./StackState.ts";
import {
  isMissingStateRemnantError,
  type StackStateStore,
  withRegistryLock,
} from "./StackStateStore.ts";
import type { HeldPort, HostListener } from "../supervisor/HostListener.ts";

export interface PrivatePortIntent {
  readonly instanceId: string;
  readonly workloadId: string;
  readonly binding: string;
}

/** One durable host binding requested by a stack-owned or instance-owned listener. */
export type PublicPortIntent =
  | {
      readonly owner: "stack";
      readonly binding: "api" | "api:internal";
      readonly listenerField?: PortField;
      readonly address: string;
      readonly port: "automatic" | number;
    }
  | {
      readonly owner: "instance";
      readonly instanceId: string;
      readonly binding: string;
      readonly listenerField?: PortField;
      readonly address: string;
      readonly port: "automatic" | number;
    };

export interface PortReservation {
  /** Keys are persisted binding keys; listener fields are retained as gateway lookup aliases. */
  readonly assignments: Readonly<Record<string, HostPortAssignment | undefined>>;
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
    publicBindings: ReadonlyArray<PublicPortIntent>,
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

const PORT_MIN = 20_000;
const PORT_MAX = 32_767;
const PORT_POOL_SIZE = PORT_MAX - PORT_MIN + 1;
const PORT_STRIDE = 257;
const MAX_FRESH_BIND_FAILURES = 64;
const idPattern = /^[0-9a-f]{64}$/;

const assignmentMap = (assignments: ReadonlyArray<HostPortAssignment>) =>
  new Map(
    assignments.map((assignment) => [
      assignment.owner === "stack"
        ? `stack:${assignment.binding}`
        : `instance:${assignment.instanceId}:${assignment.binding}`,
      assignment,
    ]),
  );
const bindingKey = (intent: PublicPortIntent): string =>
  intent.owner === "stack"
    ? `stack:${intent.binding}`
    : `instance:${intent.instanceId}:${intent.binding}`;

const assignmentFor = (
  intent: PublicPortIntent,
  port: number,
  allocationIntent: "automatic" | "exact",
): HostPortAssignment =>
  intent.owner === "stack"
    ? {
        owner: "stack",
        binding: intent.binding,
        address: intent.address,
        port,
        intent: allocationIntent,
      }
    : {
        owner: "instance",
        instanceId: intent.instanceId,
        binding: intent.binding,
        address: intent.address,
        port,
        intent: allocationIntent,
      };

const listenerFieldFor = (intent: PublicPortIntent): PortField =>
  intent.listenerField ??
  (intent.owner === "stack"
    ? "api"
    : intent.binding === "sql"
      ? "database"
      : intent.binding === "pooler"
        ? "pooler"
        : intent.binding === "studio"
          ? "studio"
          : intent.binding === "smtp"
            ? "smtp"
            : intent.binding === "pop3"
              ? "pop3"
              : "functionsInspector");
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
  acquire: (stackId, publicBindings, privateBindings) =>
    withRegistryLock(
      options.stateRoot,
      Effect.gen(function* () {
        const current = yield* options.store.read(stackId);
        if (current === undefined)
          return yield* new StackStateInvalidError({
            message: "Cannot acquire ports for an unconfigured stack",
          });
        const publicOwners = new Map<number, ReadonlyArray<ForeignPublicOwner>>();
        const privateOwners = new Map<number, ForeignPrivateOwner>();
        for (const entry of yield* readAuthoritativeStates(options)) {
          if (entry.stackId === stackId) continue;
          for (const assignment of entry.state.ports) {
            const owner: ForeignPublicOwner = {
              stackId: entry.stackId,
              field:
                assignment.owner === "stack"
                  ? assignment.binding
                  : `${assignment.instanceId}:${assignment.binding}`,
              intent: assignment.intent,
            };
            publicOwners.set(assignment.port, [
              ...(publicOwners.get(assignment.port) ?? []),
              owner,
            ]);
          }
          for (const assignment of entry.state.privatePorts)
            privateOwners.set(assignment.port, {
              stackId: entry.stackId,
              field: `${assignment.instanceId}:${assignment.workloadId}:${assignment.binding}`,
            });
        }

        const existingPublic = assignmentMap(current.ports);
        const existingPrivate = new Map(
          current.privatePorts.map((entry) => [privateBindingKey(entry), entry]),
        );
        const requestedPublic = new Map<string, PublicPortIntent>();
        for (const intent of publicBindings) {
          const key = bindingKey(intent);
          if (requestedPublic.has(key))
            return yield* allocation(intent.binding, "Duplicate public listener binding");
          requestedPublic.set(key, intent);
        }
        const retainedPublic = new Map<string, HostPortAssignment>();
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
          const conflict = owners?.find(() => true);
          if (conflict !== undefined)
            return unavailable(
              port,
              field,
              `Port ${port} for ${field} is reserved by ${ownerText(conflict)}`,
            );
          return undefined;
        };

        // Preseed every own retained assignment before allocating any fresh field.
        for (const intent of publicBindings) {
          if (intent.port !== "automatic") continue;
          const key = bindingKey(intent);
          const prior = existingPublic.get(key);
          if (prior?.intent !== "automatic") continue;
          if (!validPort(prior.port)) return yield* unavailable(prior.port, intent.binding);
          const foreign = foreignConflict(prior.port, intent.binding);
          if (foreign !== undefined) return yield* foreign;
          const duplicate = claim(prior.port, intent.binding);
          if (duplicate !== undefined) return yield* duplicate;
          retainedPublic.set(key, assignmentFor(intent, prior.port, "automatic"));
        }
        const requestedPrivate = new Map<string, PrivatePortIntent>();
        for (const intent of privateBindings) {
          const key = privateBindingKey(intent);
          if (
            intent.instanceId.length === 0 ||
            intent.workloadId.length === 0 ||
            intent.binding.length === 0
          )
            return yield* allocation(
              `${intent.instanceId}:${intent.workloadId}:${intent.binding}`,
              "Private workload binding is invalid",
            );
          if (requestedPrivate.has(key))
            return yield* allocation(
              `${intent.instanceId}:${intent.workloadId}:${intent.binding}`,
              "Duplicate private workload binding",
            );
          requestedPrivate.set(key, intent);
          const prior = existingPrivate.get(key);
          if (prior === undefined) continue;
          const label = `${intent.instanceId}:${intent.workloadId}:${intent.binding}`;
          if (!validPort(prior.port)) return yield* unavailable(prior.port, label);
          const foreign = foreignConflict(prior.port, label);
          if (foreign !== undefined) return yield* foreign;
          const duplicate = claim(prior.port, label);
          if (duplicate !== undefined) return yield* duplicate;
          retainedPrivate.set(key, prior);
        }
        const exactAssignments = new Map<string, HostPortAssignment>();
        for (const intent of publicBindings) {
          if (intent.port === "automatic") continue;
          const key = bindingKey(intent);
          if (!validPort(intent.port)) return yield* unavailable(intent.port, intent.binding);
          const foreign = foreignConflict(intent.port, intent.binding);
          if (foreign !== undefined) return yield* foreign;
          const duplicate = claim(intent.port, intent.binding);
          if (duplicate !== undefined) return yield* duplicate;
          exactAssignments.set(key, assignmentFor(intent, intent.port, "exact"));
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
            return yield* Effect.gen(function* () {
              const acquired = yield* restore(
                Effect.gen(function* () {
                  const privateScope = yield* Scope.fork(attemptScope, "sequential");
                  const assignments: HostPortAssignment[] = [];
                  const byBinding: Record<string, HostPortAssignment> = {};
                  const listeners: HostListener[] = [];
                  for (const intent of publicBindings) {
                    const key = bindingKey(intent);
                    const retained = retainedPublic.get(key);
                    const exact = exactAssignments.get(key);
                    const assignment = retained ?? exact;
                    if (assignment !== undefined) {
                      const listener = yield* options
                        .bindHost(intent.address, assignment.port, listenerFieldFor(intent))
                        .pipe(Effect.provideService(Scope.Scope, attemptScope));
                      assignments.push(assignment);
                      byBinding[key] = assignment;
                      listeners.push({ ...listener, routeKey: key });
                      occupied.add(assignment.port);
                      continue;
                    }
                    const fresh = yield* allocateFresh(intent.binding, (port) =>
                      options
                        .bindHost(intent.address, port, listenerFieldFor(intent))
                        .pipe(Effect.provideService(Scope.Scope, attemptScope)),
                    );
                    const assignmentFresh = assignmentFor(intent, fresh.port, "automatic");
                    assignments.push(assignmentFresh);
                    byBinding[key] = assignmentFresh;
                    listeners.push({ ...fresh.value, routeKey: key });
                  }

                  const privateAssignments: PrivatePortAssignment[] = [];
                  for (const intent of requestedPrivate.values()) {
                    const key = privateBindingKey(intent);
                    const label = `${intent.instanceId}:${intent.workloadId}:${intent.binding}`;
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
                      instanceId: intent.instanceId,
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
                  return {
                    privateScope,
                    next,
                    reservation: {
                      assignments: {
                        ...byBinding,
                        ...Object.fromEntries(
                          assignments.flatMap((assignment) => {
                            const field =
                              assignment.owner === "stack"
                                ? assignment.binding
                                : assignment.binding === "sql"
                                  ? "database"
                                  : assignment.binding === "inspector"
                                    ? "functionsInspector"
                                    : undefined;
                            return field === undefined ? [] : [[field, assignment]];
                          }),
                        ),
                      },
                      privateAssignments,
                      hostListeners: listeners,
                    },
                  };
                }),
              );
              yield* options.store.replaceUnlocked(stackId, acquired.next);
              yield* Scope.close(acquired.privateScope, Exit.void);
              return acquired.reservation;
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : Scope.close(attemptScope, exit),
              ),
            );
          }),
        );
        return result;
      }),
    ),
});
