import { Context, type Effect } from "effect";
import {
  DuplicateManagedPortKeyError,
  InvalidManagedOwnerPidError,
  InvalidManagedPortError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  type ManagedCheckoutKind,
  type ManagedCheckoutLocation,
  type ManagedCheckoutScopedContextKind,
  type ManagedContextDescriptor,
  type ManagedContextRecord,
  type ManagedIdentityTriple,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedPortAssignment,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackPaths,
  type ManagedStackProjection,
  type ManagedStackRecord,
} from "./model.ts";
import type { DuplicateManagedIdentityError, ManagedOperationOwnershipError } from "./model.ts";

/**
 * Everything one stack registration needs, with every identity already minted by
 * the service: the registry stores the decision, it never makes it.
 *
 * The project, the checkout, its one location, and the context are upserted
 * inside the very transaction that creates the pending stack, so a registration
 * that refuses leaves none of them behind and the live-stack uniqueness of
 * `(checkoutId, contextId, stackName)` is decided under the same lock.
 */
export interface PrepareStackInput {
  readonly identity: ManagedIdentityTriple;
  readonly checkoutKind: ManagedCheckoutKind;
  /**
   * The checkout's canonical top-level directory, which is the one location a
   * checkout has — never the directory a caller happened to run in. A checkout
   * holds exactly one location, so a nested path here would both record a
   * subdirectory as the checkout's whole location and make the next start from
   * anywhere else in the same checkout a duplicate-identity refusal.
   */
  readonly checkoutRootPath: string;
  readonly locationId: string;
  readonly context: ManagedContextDescriptor;
  readonly stackId: string;
  readonly stackName: string;
  readonly paths: ManagedStackPaths;
  readonly operationToken: string;
  readonly ownerPid?: number;
  readonly now: string;
  readonly configuration: ManagedStackConfiguration;
}

/**
 * The registration's outcome. A checkout-scoped context the checkout already has
 * wins over the one the caller minted, so the stack's own `contextId` is the
 * authoritative answer to which context was used.
 */
export type PrepareStackResult =
  | {
      readonly outcome: "create";
      readonly stack: ManagedStackRecord;
      readonly operation: ManagedOperationRecord;
    }
  | {
      readonly outcome: "existing";
      readonly stack: ManagedStackRecord;
      readonly operation?: ManagedOperationRecord;
    };

export interface ClaimManagedOperationInput {
  readonly token: string;
  readonly stackId: string;
  readonly kind: ManagedOperationKind;
  readonly ownerPid?: number;
  readonly now: string;
}

export type ClaimManagedOperationResult =
  | { readonly acquired: true; readonly operation: ManagedOperationRecord }
  | { readonly acquired: false; readonly operation: ManagedOperationRecord };

export interface UpdateManagedStackInput extends ManagedStackConfiguration {
  readonly stackId: string;
  readonly operationToken: string;
  readonly now: string;
}

/**
 * How an abandoned operation was settled against observed runtime state.
 *
 * Recovery treats the three shapes differently: an adopted stack is reported as
 * recovered, a discarded pending row frees its identity for a retry, and a
 * tombstoned row means a crashed deletion — its registry state is already final
 * and only the leaked stack directory still needs reclaiming.
 */
export type ReconcileManagedOperationResult =
  | { readonly outcome: "recovered"; readonly stack: ManagedStackRecord }
  | { readonly outcome: "discarded" }
  | { readonly outcome: "tombstoned"; readonly stack: ManagedStackRecord };

/** Failures both adapters raise while registering a stack. */
export type PrepareStackFailure =
  | DuplicateManagedIdentityError
  | DuplicateManagedPortKeyError
  | InvalidManagedOwnerPidError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPortReservationError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while claiming an operation for a stack. */
export type ClaimManagedOperationFailure =
  | InvalidManagedOwnerPidError
  | ManagedOperationOwnershipError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while reconfiguring a published stack. */
export type UpdateManagedStackFailure =
  | DuplicateManagedPortKeyError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPendingStackUpdateError
  | ManagedPortReservationError
  | ManagedRunningStackPortChangeError
  | ManagedStackNotFoundError;

/**
 * Failures both adapters raise while settling an abandoned operation. Adopting a
 * stack re-reserves the ports it claims, so another stack holding one of them
 * fails the reconciliation rather than stealing the lease.
 */
export type ReconcileManagedOperationFailure =
  | DuplicateManagedPortKeyError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPortReservationError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while resolving a stack under a live claim. */
export type OwnedManagedStackFailure = ManagedOperationOwnershipError | ManagedStackNotFoundError;

/**
 * The registry contract shared by the persistent SQLite adapters and the
 * in-memory test seam.
 *
 * Every method is an `Effect` whose error channel names the domain failures that
 * decision can reach. Storage-level failures — a corrupt row, an unexpected
 * driver error — are defects instead: they are not outcomes a caller can act on.
 */
export interface ManagedStackRepositoryShape {
  readonly prepareStack: (
    input: PrepareStackInput,
  ) => Effect.Effect<PrepareStackResult, PrepareStackFailure>;
  readonly publishPendingStack: (
    stackId: string,
    operationToken: string,
    now: string,
  ) => Effect.Effect<ManagedStackRecord, OwnedManagedStackFailure>;
  readonly abortPendingStack: (
    stackId: string,
    operationToken: string,
  ) => Effect.Effect<void, OwnedManagedStackFailure>;
  readonly getStack: (stackId: string) => Effect.Effect<ManagedStackRecord | undefined>;
  readonly listStacks: (options?: {
    readonly includeTombstoned?: boolean;
  }) => Effect.Effect<ReadonlyArray<ManagedStackRecord>>;
  /**
   * The reader's view of a stack, joined to its checkout and context.
   *
   * Kept apart from {@link getStack} deliberately: every lifecycle decision in
   * the policy layer needs the stack row and nothing else, so only the paths
   * that actually report to a caller pay for the join.
   */
  readonly getStackProjection: (
    stackId: string,
  ) => Effect.Effect<ManagedStackProjection | undefined>;
  readonly listStackProjections: (options?: {
    readonly includeTombstoned?: boolean;
  }) => Effect.Effect<ReadonlyArray<ManagedStackProjection>>;
  /**
   * The one context a checkout has of a checkout-scoped kind, if it has one.
   *
   * A read-only resolve of a detached `HEAD` has no other way to find the
   * context it would use: unlike a branch, a detached `HEAD` stores nothing in
   * git, so the registry is where that context lives.
   */
  readonly findCheckoutContext: (
    checkoutId: string,
    kind: ManagedCheckoutScopedContextKind,
  ) => Effect.Effect<ManagedContextRecord | undefined>;
  readonly claimOperation: (
    input: ClaimManagedOperationInput,
  ) => Effect.Effect<ClaimManagedOperationResult, ClaimManagedOperationFailure>;
  readonly finishOperation: (
    stackId: string,
    operationToken: string,
    outcome: "completed" | "failed",
    now: string,
    error?: string,
  ) => Effect.Effect<void, ManagedOperationOwnershipError>;
  readonly updateStack: (
    input: UpdateManagedStackInput,
  ) => Effect.Effect<ManagedStackRecord, UpdateManagedStackFailure>;
  readonly listActiveOperations: (
    startedBefore?: string,
  ) => Effect.Effect<ReadonlyArray<ManagedOperationRecord>>;
  readonly reconcileOperation: (
    stackId: string,
    operationToken: string,
    lifecycle: ManagedStackLifecycle,
    now: string,
  ) => Effect.Effect<ReconcileManagedOperationResult, ReconcileManagedOperationFailure>;
  readonly tombstoneStack: (
    stackId: string,
    operationToken: string,
    now: string,
  ) => Effect.Effect<ManagedStackRecord, OwnedManagedStackFailure>;
  readonly listCheckoutLocations: () => Effect.Effect<ReadonlyArray<ManagedCheckoutLocation>>;
  readonly pruneCheckoutLocations: (locationIds: ReadonlyArray<string>) => Effect.Effect<number>;
}

/**
 * The registry a managed stack service reads and writes.
 *
 * A persistent adapter owns a database handle, so it is provided as a scoped
 * layer that closes the handle when the layer's scope closes; there is no
 * `close` method on the contract for a caller to forget.
 */
export class ManagedStackRepository extends Context.Service<
  ManagedStackRepository,
  ManagedStackRepositoryShape
>()("stack/managed/ManagedStackRepository") {}

export const managedStackOccupiesPorts = (lifecycle: ManagedStackLifecycle): boolean =>
  lifecycle === "running" || lifecycle === "starting" || lifecycle === "stopping";

/**
 * An operation's owner pid is only useful because recovery asks the operating
 * system whether that process is still alive, and a value that is not a pid
 * cannot be asked about: `kill(0, 0)` signals the caller's own process group
 * and a fractional pid throws, either of which would report a dead owner as
 * alive and wedge the claim forever. `undefined` is a valid answer — it records
 * that no owner is known — so it is not usable, but it is not invalid either.
 */
export const isUsableManagedOwnerPid = (ownerPid: number | undefined): ownerPid is number =>
  ownerPid !== undefined && Number.isSafeInteger(ownerPid) && ownerPid > 0;

/**
 * Rejects a pid that could never be probed, at the boundary that would persist
 * it. Shared so both adapters refuse the same inputs and no registry row can
 * carry a pid that recovery cannot reason about.
 */
export const assertManagedOwnerPid = (ownerPid: number | undefined): void => {
  if (ownerPid !== undefined && !isUsableManagedOwnerPid(ownerPid)) {
    throw new InvalidManagedOwnerPidError({ ownerPid });
  }
};

/**
 * Ordering shared by both adapters. SQLite compares TEXT with BINARY
 * collation, so the in-memory repository must compare code points too:
 * `localeCompare` folds case and would disagree on mixed-case paths.
 */
export const compareManagedText = (left: string, right: string): number => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

const portNumbersEqual = (
  left: ReadonlyArray<ManagedPortAssignment>,
  right: ReadonlyArray<ManagedPortAssignment>,
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const byKey = new Map(right.map((assignment) => [assignment.key, assignment]));
  return left.every((assignment) => {
    const candidate = byKey.get(assignment.key);
    return candidate !== undefined && assignment.port === candidate.port;
  });
};

export const validateManagedPortAssignments = (
  stackId: string,
  ports: ReadonlyArray<ManagedPortAssignment>,
): void => {
  const keys = new Set<string>();
  const numbers = new Set<number>();
  for (const assignment of ports) {
    if (!Number.isInteger(assignment.port) || assignment.port < 1 || assignment.port > 65_535) {
      throw new InvalidManagedPortError({ port: assignment.port, key: assignment.key });
    }
    if (keys.has(assignment.key)) {
      throw new DuplicateManagedPortKeyError({ key: assignment.key });
    }
    if (numbers.has(assignment.port)) {
      throw new ManagedPortReservationError({ port: assignment.port, ownerStackId: stackId });
    }
    keys.add(assignment.key);
    numbers.add(assignment.port);
  }
};

export const reconcileManagedPortAssignments = (
  stack: ManagedStackRecord,
  requested: ReadonlyArray<ManagedPortAssignment> | undefined,
  targetLifecycle: ManagedStackLifecycle = stack.lifecycle,
): ReadonlyArray<ManagedPortAssignment> => {
  if (requested === undefined) {
    return stack.ports;
  }
  validateManagedPortAssignments(stack.id, requested);
  const persisted = new Map(stack.ports.map((assignment) => [assignment.key, assignment]));
  // Sorted by key here, in the shared reconciler: SQLite reads its port rows
  // back with `ORDER BY key`, so leaving the caller's request order in place
  // would make the same request produce differently ordered records per adapter.
  const reconciled = requested
    .map((assignment) => {
      const current = persisted.get(assignment.key);
      return assignment.intent === "automatic" && current !== undefined
        ? { ...assignment, port: current.port }
        : assignment;
    })
    .sort((left, right) => compareManagedText(left.key, right.key));
  if (
    managedStackOccupiesPorts(stack.lifecycle) &&
    managedStackOccupiesPorts(targetLifecycle) &&
    !portNumbersEqual(stack.ports, reconciled)
  ) {
    throw new ManagedRunningStackPortChangeError({ stackId: stack.id });
  }
  return reconciled;
};

/**
 * The stack states `updateStack` refuses, shared so both adapters reject the
 * same targets:
 *
 * - a tombstone is deleted state, and a caller holding a stale ID must never
 *   resurrect it into a port-occupying lifecycle;
 * - a pending row is still owned by its publisher's provisioning flow, which
 *   publishes or aborts it as a whole. Reconfiguring it would hand a
 *   port-occupying lease to a stack no reader can see yet.
 */
export const assertManagedStackUpdatable = (stack: ManagedStackRecord): void => {
  if (stack.status === "tombstoned") {
    throw new ManagedStackNotFoundError({ stackId: stack.id });
  }
  if (stack.status === "pending") {
    throw new ManagedPendingStackUpdateError({ stackId: stack.id });
  }
};
