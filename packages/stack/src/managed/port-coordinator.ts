import { Effect, Scope } from "effect";
import {
  PortAllocationError,
  reservePortSet,
  type PortLease,
  type PortReservationRequest,
} from "../PortAllocator.ts";
import type { PortField, ResolvedPorts } from "../PortCatalog.ts";
import {
  ManagedExactPortOccupiedError,
  ManagedPortAllocationError,
  ManagedPortClaimRaceError,
  ManagedPortReservationError,
  ManagedStickyPortOccupiedError,
  type ManagedPortAssignment,
  type ManagedStackRecord,
} from "./model.ts";
import type { ManagedPortPlan, ManagedDurablePortPlanEntry } from "./port-plan.ts";
import {
  managedPortReservationsConflict,
  type ClaimManagedStartPortsFailure,
  type ManagedPortReservation,
  type ManagedStackRepositoryShape,
} from "./repository.ts";

export interface ManagedPortStartAllocation {
  readonly stack: ManagedStackRecord;
  readonly durableAssignments: ReadonlyArray<ManagedPortAssignment>;
  readonly ports: ResolvedPorts;
  readonly lease: PortLease;
}

export type ManagedPortStartFailure =
  | ClaimManagedStartPortsFailure
  | ManagedExactPortOccupiedError
  | ManagedStickyPortOccupiedError
  | ManagedPortClaimRaceError
  | ManagedPortAllocationError;

export interface ManagedPortCandidateInput {
  readonly stack: ManagedStackRecord;
  readonly plan: ManagedPortPlan;
  readonly reservations: ReadonlyArray<ManagedPortReservation>;
  readonly requests: ReadonlyArray<PortReservationRequest>;
  readonly reserved: ReadonlySet<number>;
  readonly attempt: number;
}

export type ManagedPortCandidatePolicy = (
  input: ManagedPortCandidateInput,
) => ReadonlyArray<PortReservationRequest>;

interface ManagedPortBinderOptions {
  readonly reserved?: ReadonlySet<number>;
  readonly onBound?: (field: PortField, bound: { readonly port: number }) => Effect.Effect<void>;
}

/** @internal Test-only seam for deterministic bind interruption coverage. */
type ManagedPortBinder = (
  requests: ReadonlyArray<PortReservationRequest>,
  options: ManagedPortBinderOptions,
) => Effect.Effect<PortLease, PortAllocationError>;

export interface ManagedPortCoordinatorOptions {
  readonly repository: ManagedStackRepositoryShape;
  /** Internal deterministic candidate seam; callers should use the default policy. */
  readonly candidatePolicy?: ManagedPortCandidatePolicy;
  /** Internal retry seam. The production default is eight complete candidates. */
  readonly retryLimit?: number;
}

export interface ManagedPortCoordinatorShape {
  readonly acquireStart: (input: {
    readonly stack: ManagedStackRecord;
    readonly operationToken: string;
    readonly plan: ManagedPortPlan;
    readonly now: string;
  }) => Effect.Effect<ManagedPortStartAllocation, ManagedPortStartFailure, Scope.Scope>;
}

const DEFAULT_RETRY_LIMIT = 8;

const bindWithReservePortSet: ManagedPortBinder = (requests, options) =>
  reservePortSet(requests, options);

const defaultCandidatePolicy = ({
  plan,
}: ManagedPortCandidateInput): ReadonlyArray<PortReservationRequest> => {
  const durable = plan.durable.map(({ field, selection }) => ({ field, selection }));
  return [
    ...durable.filter((request) => request.selection.kind === "exact"),
    ...durable.filter((request) => request.selection.kind === "automatic"),
    ...plan.runtimeOnly,
  ];
};

const ownerFor = (
  stackId: string,
  assignment: ManagedPortAssignment,
  reservations: ReadonlyArray<ManagedPortReservation>,
): ManagedPortReservation | undefined =>
  reservations.find(
    (reservation) =>
      reservation.stackId !== stackId &&
      managedPortReservationsConflict(stackId, assignment, reservation),
  );

const assignmentFor = (
  entry: ManagedDurablePortPlanEntry,
  ports: ResolvedPorts,
): ManagedPortAssignment | undefined => {
  const port = ports[entry.field];
  return port === undefined ? undefined : { key: entry.key, port, intent: entry.intent };
};

const fieldsFor = (requests: ReadonlyArray<PortReservationRequest>): ReadonlyArray<PortField> =>
  requests.map(({ field }) => field);

const reservationPorts = (
  reservations: ReadonlyArray<ManagedPortReservation>,
): ReadonlySet<number> => new Set(reservations.map((reservation) => reservation.assignment.port));

const exactError = (
  entry: ManagedDurablePortPlanEntry,
  port: number,
  owner: ManagedPortReservation | undefined,
): ManagedExactPortOccupiedError =>
  new ManagedExactPortOccupiedError({
    key: entry.key,
    port,
    ...(owner === undefined
      ? {}
      : { ownerStackId: owner.stackId, ownerStackName: owner.stackName }),
  });

const stickyError = (
  entry: ManagedDurablePortPlanEntry,
  port: number,
  stackId: string,
  owner: ManagedPortReservation | undefined,
): ManagedStickyPortOccupiedError =>
  new ManagedStickyPortOccupiedError({
    key: entry.key,
    port,
    stackId,
    ...(owner === undefined
      ? {}
      : { ownerStackId: owner.stackId, ownerStackName: owner.stackName }),
  });

type PreflightResult =
  | { readonly _tag: "Success"; readonly reserved: ReadonlySet<number> }
  | {
      readonly _tag: "Failure";
      readonly error: ManagedExactPortOccupiedError | ManagedStickyPortOccupiedError;
    };

const preflight = (
  stack: ManagedStackRecord,
  plan: ManagedPortPlan,
  reservations: ReadonlyArray<ManagedPortReservation>,
): PreflightResult => {
  const hasAutomaticSelection =
    plan.runtimeOnly.length > 0 || plan.durable.some((entry) => entry.newlyAllocatedAutomatic);
  const reserved = new Set(
    hasAutomaticSelection ? reservationPorts(reservations) : new Set<number>(),
  );
  for (const entry of plan.durable) {
    if (entry.selection.kind === "exact") reserved.delete(entry.selection.port);
  }
  for (const entry of plan.durable) {
    if (entry.selection.kind !== "exact") continue;
    const candidatePort = entry.selection.port;
    const inactive = plan.inactiveAssignments.find(
      (assignment) => assignment.port === candidatePort,
    );
    if (inactive !== undefined) {
      const owner: ManagedPortReservation = {
        stackId: stack.id,
        stackName: stack.name,
        lifecycle: stack.lifecycle,
        assignment: inactive,
      };
      return {
        _tag: "Failure",
        error:
          entry.intent === "exact"
            ? exactError(entry, entry.selection.port, owner)
            : stickyError(entry, candidatePort, stack.id, owner),
      };
    }
    const candidate: ManagedPortAssignment = {
      key: entry.key,
      port: entry.selection.port,
      intent: entry.intent,
    };
    const owner = ownerFor(stack.id, candidate, reservations);
    if (owner === undefined) continue;
    if (entry.intent === "exact") {
      return {
        _tag: "Failure",
        error: exactError(entry, entry.selection.port, owner),
      };
    }
    return {
      _tag: "Failure",
      error: stickyError(entry, entry.selection.port, stack.id, owner),
    };
  }
  return { _tag: "Success", reserved };
};

const allocationError = (
  requests: ReadonlyArray<PortReservationRequest>,
  cause: unknown,
): ManagedPortAllocationError =>
  new ManagedPortAllocationError({ fields: fieldsFor(requests), cause });

const parseUnavailablePort = (detail: string): number | undefined => {
  const match = /^Port (\d+) is not available$/.exec(detail);
  return match === null ? undefined : Number(match[1]);
};

const mapAllocationError = (
  requests: ReadonlyArray<PortReservationRequest>,
  plan: ManagedPortPlan,
  stackId: string,
  error: PortAllocationError,
): ManagedPortStartFailure => {
  const port = parseUnavailablePort(error.detail);
  if (port !== undefined) {
    const request = requests.find(
      (candidate) => candidate.selection.kind === "exact" && candidate.selection.port === port,
    );
    const entry =
      request === undefined
        ? undefined
        : plan.durable.find((candidate) => candidate.field === request.field);
    if (entry !== undefined) {
      return entry.intent === "exact"
        ? new ManagedExactPortOccupiedError({ key: entry.key, port })
        : new ManagedStickyPortOccupiedError({ key: entry.key, port, stackId });
    }
  }
  return allocationError(requests, error);
};

const isReservationError = (error: unknown): error is ManagedPortReservationError =>
  error instanceof ManagedPortReservationError;

const claimRace = (
  stackId: string,
  error: ManagedPortReservationError,
): ManagedPortClaimRaceError =>
  new ManagedPortClaimRaceError({
    stackId,
    port: error.port,
    ownerStackId: error.ownerStackId,
  });

const retryableClaimRace = (
  assignments: ReadonlyArray<ManagedPortAssignment>,
  plan: ManagedPortPlan,
  error: ManagedPortReservationError,
): boolean => {
  const conflicting = assignments.filter((assignment) => assignment.port === error.port);
  if (conflicting.length === 0) return false;
  const newlyAutomatic = new Set(
    plan.durable.filter((entry) => entry.newlyAllocatedAutomatic).map((entry) => entry.key),
  );
  return conflicting.every((assignment) => newlyAutomatic.has(assignment.key));
};

const makeCoordinator = (
  options: ManagedPortCoordinatorOptions,
  binder: ManagedPortBinder = bindWithReservePortSet,
): ManagedPortCoordinatorShape => {
  const candidatePolicy = options.candidatePolicy ?? defaultCandidatePolicy;
  const retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;

  const acquireStart: ManagedPortCoordinatorShape["acquireStart"] = (input) =>
    Effect.suspend(() => {
      const attempt = (
        attemptNumber: number,
      ): Effect.Effect<ManagedPortStartAllocation, ManagedPortStartFailure, Scope.Scope> =>
        Effect.gen(function* () {
          const reservations = yield* options.repository.listPortReservations();
          const preflightResult = preflight(input.stack, input.plan, reservations);
          if (preflightResult._tag === "Failure") {
            return yield* Effect.fail(preflightResult.error);
          }
          const reserved = preflightResult.reserved;
          const baseRequests = defaultCandidatePolicy({
            stack: input.stack,
            plan: input.plan,
            reservations,
            requests: [],
            reserved,
            attempt: attemptNumber,
          });
          const requests = candidatePolicy({
            stack: input.stack,
            plan: input.plan,
            reservations,
            requests: baseRequests,
            reserved,
            attempt: attemptNumber,
          });
          const lease = yield* Effect.acquireRelease(
            binder(requests, { reserved }).pipe(
              Effect.mapError((error) =>
                mapAllocationError(requests, input.plan, input.stack.id, error),
              ),
            ),
            (candidate) => candidate.releaseAcquisition,
          );
          const activeAssignments = input.plan.durable.map((entry) =>
            assignmentFor(entry, lease.ports),
          );
          if (activeAssignments.some((assignment) => assignment === undefined)) {
            yield* lease.releaseAll;
            return yield* Effect.fail(
              allocationError(
                requests,
                new Error("A durable managed port field was not allocated"),
              ),
            );
          }
          const durableAssignments: ReadonlyArray<ManagedPortAssignment> = [
            ...activeAssignments.filter(
              (assignment): assignment is ManagedPortAssignment => assignment !== undefined,
            ),
            ...input.plan.inactiveAssignments,
          ];
          const claim = yield* Effect.match(
            options.repository.claimStartPorts({
              stackId: input.stack.id,
              operationToken: input.operationToken,
              ports: durableAssignments,
              now: input.now,
            }),
            {
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          );
          if (claim._tag === "Success") {
            return {
              stack: claim.value,
              durableAssignments,
              ports: lease.ports,
              lease,
            };
          }
          yield* lease.releaseAll;
          const cause = claim.error;
          if (!isReservationError(cause)) {
            return yield* Effect.fail(cause);
          }
          if (
            attemptNumber < retryLimit &&
            retryableClaimRace(durableAssignments, input.plan, cause)
          ) {
            return yield* attempt(attemptNumber + 1);
          }
          return yield* Effect.fail(claimRace(input.stack.id, cause));
        });
      return attempt(1);
    });

  return { acquireStart };
};

interface ManagedPortCoordinatorTestingOptions extends ManagedPortCoordinatorOptions {
  readonly binder: ManagedPortBinder;
}

/** @internal Source-test-only factory; not part of the managed package surface. */
export const makeManagedPortCoordinatorForTesting = (
  options: ManagedPortCoordinatorTestingOptions,
): ManagedPortCoordinatorShape => makeCoordinator(options, options.binder);

/** Scoped managed allocation facade. */
export class ManagedPortCoordinator {
  static make(options: ManagedPortCoordinatorOptions): ManagedPortCoordinatorShape {
    return makeCoordinator(options);
  }
}
