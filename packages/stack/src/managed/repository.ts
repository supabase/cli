import {
  InvalidManagedPortError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  type ManagedCheckoutLocation,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedPortAssignment,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackPaths,
  type ManagedStackRecord,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";

export interface PrepareOrdinaryStackInput {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly canonicalPath: string;
  readonly locationId: string;
  readonly stackId: string;
  readonly stackName: string;
  readonly paths: ManagedStackPaths;
  readonly operationToken: string;
  readonly ownerPid?: number;
  readonly now: string;
  readonly configuration: ManagedStackConfiguration;
}

export type PrepareOrdinaryStackResult =
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

export interface ManagedStackRepository {
  prepareOrdinaryStack(input: PrepareOrdinaryStackInput): PrepareOrdinaryStackResult;
  publishPendingStack(stackId: string, operationToken: string, now: string): ManagedStackRecord;
  abortPendingStack(stackId: string, operationToken: string): void;
  getStack(stackId: string): ManagedStackRecord | undefined;
  listStacks(options?: { readonly includeTombstoned?: boolean }): ReadonlyArray<ManagedStackRecord>;
  claimOperation(input: ClaimManagedOperationInput): ClaimManagedOperationResult;
  finishOperation(
    stackId: string,
    operationToken: string,
    outcome: "completed" | "failed",
    now: string,
    error?: string,
  ): void;
  updateStack(input: UpdateManagedStackInput): ManagedStackRecord;
  listActiveOperations(startedBefore?: string): ReadonlyArray<ManagedOperationRecord>;
  reconcileOperation(
    stackId: string,
    operationToken: string,
    lifecycle: ManagedStackLifecycle,
    now: string,
  ): ReconcileManagedOperationResult;
  tombstoneStack(stackId: string, operationToken: string, now: string): ManagedStackRecord;
  listCheckoutLocations(): ReadonlyArray<ManagedCheckoutLocation>;
  pruneCheckoutLocations(locationIds: ReadonlyArray<string>): number;
  close(): void;
}

export const managedStackOccupiesPorts = (lifecycle: ManagedStackLifecycle): boolean =>
  lifecycle === "running" || lifecycle === "starting" || lifecycle === "stopping";

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
      throw new InvalidManagedPortError(assignment.port, assignment.key);
    }
    if (keys.has(assignment.key)) {
      throw new Error(`Duplicate managed port key ${assignment.key}`);
    }
    if (numbers.has(assignment.port)) {
      throw new ManagedPortReservationError(assignment.port, stackId);
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
  const reconciled = requested.map((assignment) => {
    const current = persisted.get(assignment.key);
    return assignment.intent === "automatic" && current !== undefined
      ? { ...assignment, port: current.port }
      : assignment;
  });
  if (
    managedStackOccupiesPorts(stack.lifecycle) &&
    managedStackOccupiesPorts(targetLifecycle) &&
    !portNumbersEqual(stack.ports, reconciled)
  ) {
    throw new ManagedRunningStackPortChangeError(stack.id);
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
    throw new ManagedStackNotFoundError(stack.id);
  }
  if (stack.status === "pending") {
    throw new ManagedPendingStackUpdateError(stack.id);
  }
};
