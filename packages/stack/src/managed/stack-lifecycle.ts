import { Cause, Duration, Effect, Exit, FileSystem, Option, Schedule } from "effect";
import {
  InvalidManagedIdentityError,
  ManagedAbandonedOperationError,
  ManagedOperationInProgressError,
  ManagedOperationOwnershipError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  ManagedStackPublicationTimeoutError,
  UnsafeManagedStackPathError,
  type ManagedCheckoutKind,
  type ManagedContextDescriptor,
  type ManagedIdentityTriple,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackRecord,
} from "./model.ts";
import { failsWith } from "./failure.ts";
import {
  isUsableManagedOwnerPid,
  type ClaimManagedOperationFailure,
  type ManagedStackRepositoryShape,
  type OwnedManagedStackFailure,
  type PrepareStackFailure,
  type UpdateManagedStackFailure,
  type ManagedIdentityRecoveryError,
  type PruneManagedIdentityMetadataResult,
} from "./repository.ts";
import { assertManagedUuid } from "./ids.ts";
import { assertManagedStackRoot, managedStackPaths } from "./paths.ts";

export interface StackLifecycleDependencies {
  readonly repository: ManagedStackRepositoryShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly stateRoot: string;
  readonly managedUuid: (label: string) => Effect.Effect<string, InvalidManagedIdentityError>;
  readonly now: () => string;
  readonly ownerPid: number;
  readonly publicationTimeoutMs: number;
  readonly publicationPollMs: number;
  readonly probeProcessAlive: (pid: number) => Effect.Effect<boolean, unknown>;
}

export interface RegisterManagedStackInput {
  readonly identity: ManagedIdentityTriple;
  readonly checkoutKind: ManagedCheckoutKind;
  readonly checkoutRootPath: string;
  readonly context: ManagedContextDescriptor;
  readonly stackName: string;
  readonly configuration?: ManagedStackConfiguration;
  readonly initialize?: (stack: ManagedStackRecord) => Effect.Effect<void, unknown>;
  readonly validate?: (stack: ManagedStackRecord) => Effect.Effect<void, unknown>;
}

export interface RegisterManagedStackResult {
  readonly outcome: "create" | "reuse";
  readonly stack: ManagedStackRecord;
}

export interface DeleteManagedStackResult {
  readonly outcome: "delete" | "no-op";
  readonly stack: ManagedStackRecord;
  readonly dataReclamation:
    | { readonly outcome: "removed" }
    | { readonly outcome: "retained"; readonly error: unknown };
}

interface ReconcileAbandonedOperationsBaseOptions<E> {
  readonly inspectRuntime: (
    stack: ManagedStackRecord,
    operation: ManagedOperationRecord,
  ) => Effect.Effect<"running" | "stopped" | "unknown", E>;
}

export type ReconcileAbandonedOperationsOptions<E = unknown> =
  ReconcileAbandonedOperationsBaseOptions<E> &
    (
      | {
          readonly startedBefore?: string;
          readonly force?: never;
        }
      | {
          readonly startedBefore?: never;
          readonly force: {
            readonly stackId: string;
            readonly operationToken: string;
          };
        }
    );

export interface RetainedManagedOperation {
  readonly operation: ManagedOperationRecord;
  readonly reason:
    | "owner-alive"
    | "owner-liveness-unknown"
    | "runtime-inspection-failed"
    | "runtime-unknown";
  readonly error?: unknown;
}

export interface ManagedOperationRecoveryFailure {
  readonly operation: ManagedOperationRecord;
  readonly phase: "reconciliation" | "state-reclamation";
  readonly operationReleased: boolean;
  readonly error: unknown;
}

export interface ReconcileAbandonedOperationsResult {
  readonly recovered: ReadonlyArray<ManagedStackRecord>;
  /** State removal succeeded; failed removals are reported separately. */
  readonly abortedStackIds: ReadonlyArray<string>;
  /** State removal succeeded; failed removals are reported separately. */
  readonly reclaimedStackIds: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<RetainedManagedOperation>;
  readonly skippedOperationIds: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<ManagedOperationRecoveryFailure>;
}

export type ManagedPruneRequest =
  | { readonly recordIds: ReadonlyArray<string> }
  | { readonly operation: "prune"; readonly recordIds: ReadonlyArray<string> };

export type ManagedPruneResult = PruneManagedIdentityMetadataResult;

export type ManagedPruneFailure = InvalidManagedIdentityError | ManagedIdentityRecoveryError;

type RequireManagedOperationFailure =
  | ClaimManagedOperationFailure
  | InvalidManagedIdentityError
  | ManagedOperationInProgressError;

export type UpdateManagedStackConfigurationFailure =
  | RequireManagedOperationFailure
  | UpdateManagedStackFailure;

export type DeleteManagedStackFailure =
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | OwnedManagedStackFailure
  | RequireManagedOperationFailure
  | UpdateManagedStackFailure;

type RegisterManagedStackFailure =
  | InvalidManagedIdentityError
  | ManagedAbandonedOperationError
  | ManagedOperationInProgressError
  | ManagedStackInitializationError
  | ManagedStackNotFoundError
  | ManagedStackPublicationTimeoutError
  | PrepareStackFailure
  | UpdateManagedStackConfigurationFailure;

const dataRemoved: DeleteManagedStackResult["dataReclamation"] = { outcome: "removed" };

const dataRetained = (error: unknown): DeleteManagedStackResult["dataReclamation"] => ({
  outcome: "retained",
  error,
});

const deletionResult = (
  outcome: DeleteManagedStackResult["outcome"],
  stack: ManagedStackRecord,
  dataReclamation: DeleteManagedStackResult["dataReclamation"],
): DeleteManagedStackResult => ({ outcome, stack, dataReclamation });

/** Interruptions remain interrupts; only ordinary failures are recorded. */
const recordUnlessInterrupted =
  <E, A2, E2, R2>(record: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>) =>
  <A, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E2, R | R2> =>
    Effect.catchCause(self, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : record(cause),
    );

const absorbedError = <E>(cause: Cause.Cause<E>): Effect.Effect<unknown> =>
  Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(Cause.squash(cause));

type PublicationPollFailure = ManagedAbandonedOperationError | ManagedStackNotFoundError;
const MAX_PUBLICATION_POLL_MS = 250;

export interface StackLifecycle {
  readonly inspectStack: (
    stackId: string,
  ) => Effect.Effect<import("./model.ts").ManagedStackProjection | undefined>;
  readonly listStacks: (options?: {
    readonly includeTombstoned?: boolean;
  }) => Effect.Effect<ReadonlyArray<import("./model.ts").ManagedStackProjection>>;
  readonly updateStack: (
    stackId: string,
    configuration: ManagedStackConfiguration,
  ) => Effect.Effect<ManagedStackRecord, UpdateManagedStackConfigurationFailure>;
  readonly registerStack: (
    input: RegisterManagedStackInput,
  ) => Effect.Effect<RegisterManagedStackResult, RegisterManagedStackFailure>;
  readonly deleteStack: <E = never>(
    stackId: string,
    options?: { readonly stop?: (stack: ManagedStackRecord) => Effect.Effect<void, E> },
  ) => Effect.Effect<DeleteManagedStackResult, DeleteManagedStackFailure | E>;
  readonly reconcileAbandonedOperations: (
    options: ReconcileAbandonedOperationsOptions,
  ) => Effect.Effect<ReconcileAbandonedOperationsResult, InvalidManagedIdentityError>;
  readonly prune: (
    request: ManagedPruneRequest,
  ) => Effect.Effect<ManagedPruneResult, ManagedPruneFailure>;
}

export const makeStackLifecycle = (dependencies: StackLifecycleDependencies): StackLifecycle => {
  const {
    repository,
    fileSystem: fs,
    stateRoot,
    managedUuid,
    now,
    ownerPid,
    publicationTimeoutMs,
    publicationPollMs,
    probeProcessAlive,
  } = dependencies;

  // Reclamation is always guarded by the validated stack root; callers can
  // report a failed removal without risking a path outside the managed root.
  const removeStackState = (stack: ManagedStackRecord) =>
    Effect.flatMap(
      Effect.try({
        try: () => assertManagedStackRoot(stateRoot, stack.id, stack.paths.root),
        catch: failsWith<UnsafeManagedStackPathError>(UnsafeManagedStackPathError),
      }),
      (root) => fs.remove(root, { force: true, recursive: true }),
    );

  // Data removal is best effort after the registry transition. A failed remove
  // is part of the result so callers can retry without hiding the tombstone.
  const reclaimStackState = (
    stack: ManagedStackRecord,
  ): Effect.Effect<DeleteManagedStackResult["dataReclamation"]> =>
    removeStackState(stack).pipe(
      Effect.as(dataRemoved),
      recordUnlessInterrupted((cause) => Effect.succeed(dataRetained(Cause.squash(cause)))),
    );

  const finishOperationBestEffort = (
    stackId: string,
    operationToken: string,
    error: unknown,
  ): Effect.Effect<boolean> =>
    repository.finishOperation(stackId, operationToken, "failed", now(), String(error)).pipe(
      Effect.as(true),
      recordUnlessInterrupted(() => Effect.succeed(false)),
    );

  // Attempt claim release as best-effort compensation; refusal is absorbed so
  // the original failure cause is re-raised unchanged to the caller.
  const releasingClaimOnFailure =
    (stackId: string, operationToken: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.catchCause(self, (cause) =>
        repository
          .finishOperation(stackId, operationToken, "failed", now(), String(Cause.squash(cause)))
          .pipe(
            Effect.catchCause(() => Effect.void),
            Effect.flatMap(() => Effect.failCause(cause)),
          ),
      );

  // Once the tombstone is final, a concurrent owner-release race is harmless;
  // only that ownership refusal is absorbed here.
  const finishDeleteOperationTolerantly = (
    stackId: string,
    operationToken: string,
  ): Effect.Effect<void> =>
    repository
      .finishOperation(stackId, operationToken, "completed", now())
      .pipe(Effect.catchTag("ManagedOperationOwnershipError", () => Effect.void));

  const failRecoveryBestEffort = (
    stack: ManagedStackRecord | undefined,
    operation: ManagedOperationRecord,
    error: unknown,
  ): Effect.Effect<boolean> => {
    if (stack === undefined || stack.status === "pending") {
      return Effect.succeed(false);
    }
    return repository
      .updateStack({
        stackId: operation.stackId,
        operationToken: operation.token,
        lifecycle: "failed",
        now: now(),
      })
      .pipe(
        recordUnlessInterrupted(() => Effect.void),
        Effect.flatMap(() => finishOperationBestEffort(operation.stackId, operation.token, error)),
      );
  };

  const requireOperation = (
    stackId: string,
    kind: ManagedOperationKind,
  ): Effect.Effect<ManagedOperationRecord, RequireManagedOperationFailure> =>
    Effect.gen(function* () {
      const token = yield* managedUuid("operation token");
      const claimed = yield* repository.claimOperation({
        token,
        stackId,
        kind,
        ownerPid,
        now: now(),
      });
      if (!claimed.acquired) {
        return yield* Effect.fail(
          new ManagedOperationInProgressError({ stackId, operation: claimed.operation }),
        );
      }
      return claimed.operation;
    });

  const publicationPollCeiling = Math.max(MAX_PUBLICATION_POLL_MS, publicationPollMs);
  const publicationPollSchedule = Schedule.exponential(Duration.millis(publicationPollMs)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(
        Duration.millis(Math.min(Duration.toMillis(duration), publicationPollCeiling)),
      ),
    ),
  );

  const pollPublication = (
    pending: ManagedStackRecord,
  ): Effect.Effect<Option.Option<ManagedStackRecord>, PublicationPollFailure> =>
    Effect.flatMap(
      repository.getStack(pending.id),
      (current): Effect.Effect<Option.Option<ManagedStackRecord>, PublicationPollFailure> => {
        if (current === undefined) {
          return Effect.fail(new ManagedAbandonedOperationError({ stackId: pending.id }));
        }
        if (current.status === "active") {
          return Effect.succeed(Option.some(current));
        }
        if (current.status === "tombstoned") {
          return Effect.fail(new ManagedStackNotFoundError({ stackId: current.id }));
        }
        return Effect.succeed(Option.none());
      },
    );

  const awaitPublication = (
    pending: ManagedStackRecord,
  ): Effect.Effect<
    ManagedStackRecord,
    ManagedAbandonedOperationError | ManagedStackNotFoundError | ManagedStackPublicationTimeoutError
  > =>
    pollPublication(pending).pipe(
      Effect.repeat({
        schedule: publicationPollSchedule,
        while: (answer: Option.Option<ManagedStackRecord>) => Option.isNone(answer),
      }),
      Effect.timeoutOrElse({
        duration: Duration.millis(publicationTimeoutMs),
        orElse: () => Effect.fail(new ManagedStackPublicationTimeoutError({ stackId: pending.id })),
      }),
      Effect.flatMap((published) =>
        Option.isNone(published)
          ? Effect.die(
              new Error(
                `The publication poll for ${pending.id} stopped before the stack was published`,
              ),
            )
          : Effect.succeed(published.value),
      ),
    );

  const updateStackRecord = (
    stackId: string,
    configuration: ManagedStackConfiguration,
  ): Effect.Effect<ManagedStackRecord, UpdateManagedStackConfigurationFailure> =>
    Effect.gen(function* () {
      const operation = yield* requireOperation(stackId, "update");
      return yield* repository
        .updateStack({
          stackId,
          operationToken: operation.token,
          now: now(),
          ...configuration,
        })
        .pipe(
          Effect.tap(() =>
            repository.finishOperation(stackId, operation.token, "completed", now()),
          ),
          releasingClaimOnFailure(stackId, operation.token),
        );
    });

  const applyRequestedConfiguration = (
    stack: ManagedStackRecord,
    configuration: ManagedStackConfiguration | undefined,
  ): Effect.Effect<ManagedStackRecord, UpdateManagedStackConfigurationFailure> =>
    configuration === undefined || Object.keys(configuration).length === 0
      ? Effect.succeed(stack)
      : updateStackRecord(stack.id, configuration);

  const registerStack = (
    input: RegisterManagedStackInput,
  ): Effect.Effect<RegisterManagedStackResult, RegisterManagedStackFailure> =>
    Effect.gen(function* () {
      const stackId = yield* managedUuid("stackId");
      const locationId = yield* managedUuid("checkout location id");
      const operationToken = yield* managedUuid("operation token");
      const paths = yield* Effect.try({
        try: () => managedStackPaths(stateRoot, stackId),
        catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
      });
      // The mask starts before prepareStack creates the claim, so interruption
      // cannot strand a pending row or its operation token without cleanup.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* repository.prepareStack({
            identity: input.identity,
            checkoutKind: input.checkoutKind,
            checkoutRootPath: input.checkoutRootPath,
            locationId,
            context: input.context,
            stackId,
            stackName: input.stackName,
            paths,
            operationToken,
            ownerPid,
            now: now(),
            configuration: input.configuration ?? {},
          });
          if (prepared.outcome === "existing") {
            return yield* restore(
              Effect.gen(function* () {
                if (prepared.stack.status === "active") {
                  if (prepared.operation !== undefined) {
                    return yield* Effect.fail(
                      new ManagedOperationInProgressError({
                        stackId: prepared.stack.id,
                        operation: prepared.operation,
                      }),
                    );
                  }
                  const stack = yield* applyRequestedConfiguration(
                    prepared.stack,
                    input.configuration,
                  );
                  return { outcome: "reuse" as const, stack };
                }
                if (prepared.operation === undefined) {
                  return yield* Effect.fail(
                    new ManagedAbandonedOperationError({ stackId: prepared.stack.id }),
                  );
                }
                if (
                  !isUsableManagedOwnerPid(prepared.operation.ownerPid) ||
                  !(yield* Effect.orDie(probeProcessAlive(prepared.operation.ownerPid)))
                ) {
                  return yield* Effect.fail(
                    new ManagedAbandonedOperationError({ stackId: prepared.stack.id }),
                  );
                }
                const awaited = yield* awaitPublication(prepared.stack);
                const stack = yield* applyRequestedConfiguration(awaited, input.configuration);
                return { outcome: "reuse" as const, stack };
              }),
            );
          }

          const pending = prepared.stack;
          const operation = prepared.operation;
          return yield* restore(
            Effect.gen(function* () {
              yield* fs.makeDirectory(pending.paths.data, { recursive: true, mode: 0o700 });
              yield* fs.makeDirectory(pending.paths.logs, { recursive: true, mode: 0o700 });
              yield* fs.makeDirectory(pending.paths.runtime, { recursive: true, mode: 0o700 });
              if (input.initialize !== undefined) {
                yield* input.initialize(pending);
              }
              if (input.validate !== undefined) {
                yield* input.validate(pending);
              }
              const published = yield* repository.publishPendingStack(
                pending.id,
                operation.token,
                now(),
              );
              return { outcome: "create" as const, stack: published };
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const cleanupErrors: Array<unknown> = [];
                const aborted = yield* Effect.exit(
                  repository.abortPendingStack(pending.id, operation.token),
                );
                if (Exit.isFailure(aborted)) {
                  cleanupErrors.push(Cause.squash(aborted.cause));
                } else {
                  const reclaimed = yield* Effect.exit(removeStackState(pending));
                  if (Exit.isFailure(reclaimed)) {
                    cleanupErrors.push(Cause.squash(reclaimed.cause));
                  }
                }
                return yield* Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.fail(
                      new ManagedStackInitializationError({
                        stackId: pending.id,
                        cause: Cause.squash(cause),
                        cleanupErrors,
                      }),
                    );
              }),
            ),
          );
        }),
      );
    });

  const deleteStack = <E = never>(
    stackId: string,
    deleteOptions?: { readonly stop?: (stack: ManagedStackRecord) => Effect.Effect<void, E> },
  ): Effect.Effect<DeleteManagedStackResult, DeleteManagedStackFailure | E> =>
    Effect.gen(function* () {
      const existing = yield* repository.getStack(stackId);
      if (existing === undefined) {
        return yield* Effect.fail(new ManagedStackNotFoundError({ stackId }));
      }
      if (existing.status === "tombstoned") {
        return deletionResult("no-op", existing, yield* reclaimStackState(existing));
      }
      // Claim acquisition and the entire post-claim delete sequence are inside
      // the mask; restore only makes that owned work interruptible as a whole.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const operation = yield* requireOperation(stackId, "delete");
          return yield* restore(
            Effect.gen(function* () {
              const current = yield* repository.getStack(stackId);
              if (current === undefined) {
                return yield* Effect.fail(new ManagedStackNotFoundError({ stackId }));
              }
              if (current.status === "tombstoned") {
                const dataReclamation = yield* reclaimStackState(current);
                yield* repository.finishOperation(stackId, operation.token, "completed", now());
                return deletionResult("no-op", current, dataReclamation);
              }
              if (current.lifecycle !== "stopped") {
                const stop = deleteOptions?.stop;
                if (stop === undefined) {
                  return yield* Effect.fail(new ManagedStackNotStoppedError({ stackId }));
                }
                yield* stop(current);
                yield* repository.updateStack({
                  stackId,
                  operationToken: operation.token,
                  now: now(),
                  lifecycle: "stopped",
                  runtimeMetadata: { processIds: {}, containerIds: {} },
                });
              }
              const tombstoned = yield* repository.tombstoneStack(stackId, operation.token, now());
              const dataReclamation = yield* reclaimStackState(tombstoned);
              yield* finishDeleteOperationTolerantly(stackId, operation.token);
              return deletionResult("delete", tombstoned, dataReclamation);
            }),
          ).pipe(releasingClaimOnFailure(stackId, operation.token));
        }),
      );
    });

  const reconcileAbandonedOperations = (
    reconcileOptions: ReconcileAbandonedOperationsOptions,
  ): Effect.Effect<ReconcileAbandonedOperationsResult, InvalidManagedIdentityError> =>
    Effect.gen(function* () {
      const recovered: Array<ManagedStackRecord> = [];
      const abortedStackIds: Array<string> = [];
      const reclaimedStackIds: Array<string> = [];
      const retained: Array<RetainedManagedOperation> = [];
      const skippedOperationIds: Array<string> = [];
      const failures: Array<ManagedOperationRecoveryFailure> = [];
      const forcedOperation = reconcileOptions.force;
      if (forcedOperation !== undefined) {
        yield* Effect.try({
          try: () => assertManagedUuid(forcedOperation.stackId, "forced recovery stackId"),
          catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
        });
        yield* Effect.try({
          try: () =>
            assertManagedUuid(forcedOperation.operationToken, "forced recovery operation token"),
          catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
        });
      }
      const operations = (yield* repository.listActiveOperations(
        forcedOperation === undefined ? reconcileOptions.startedBefore : undefined,
      )).filter(
        (operation) =>
          forcedOperation === undefined ||
          (operation.stackId === forcedOperation.stackId &&
            operation.token === forcedOperation.operationToken),
      );

      const settleOperation = (operation: ManagedOperationRecord): Effect.Effect<void> =>
        Effect.gen(function* () {
          // Invalid persisted pids are treated as ownerless; probing one could
          // misclassify an abandoned claim and retain it until the next pass.
          if (forcedOperation === undefined && isUsableManagedOwnerPid(operation.ownerPid)) {
            const alive = yield* Effect.exit(probeProcessAlive(operation.ownerPid));
            if (Exit.isFailure(alive)) {
              const error = yield* absorbedError(alive.cause);
              retained.push({ operation, reason: "owner-liveness-unknown", error });
              return;
            }
            if (alive.value) {
              retained.push({ operation, reason: "owner-alive" });
              return;
            }
          }
          let claimedStack: ManagedStackRecord | undefined;
          yield* Effect.gen(function* () {
            const stack = yield* repository.getStack(operation.stackId);
            claimedStack = stack;
            if (stack === undefined) {
              skippedOperationIds.push(operation.token);
              return;
            }
            let lifecycle: ManagedStackLifecycle = "stopped";
            if (stack.status !== "tombstoned") {
              const inspected = yield* Effect.exit(
                reconcileOptions.inspectRuntime(stack, operation),
              );
              if (Exit.isFailure(inspected)) {
                const error = yield* absorbedError(inspected.cause);
                retained.push({ operation, reason: "runtime-inspection-failed", error });
                return;
              }
              if (inspected.value === "unknown") {
                retained.push({ operation, reason: "runtime-unknown" });
                return;
              }
              lifecycle = inspected.value === "running" ? "running" : "stopped";
            }
            const reconciled = yield* repository.reconcileOperation(
              stack.id,
              operation.token,
              lifecycle,
              now(),
            );
            if (reconciled.outcome === "recovered") {
              recovered.push(reconciled.stack);
              return;
            }
            const removal = yield* Effect.exit(removeStackState(stack));
            if (Exit.isFailure(removal)) {
              const error = yield* absorbedError(removal.cause);
              failures.push({
                operation,
                phase: "state-reclamation",
                operationReleased: true,
                error,
              });
              return;
            }
            if (reconciled.outcome === "discarded") {
              abortedStackIds.push(stack.id);
              return;
            }
            reclaimedStackIds.push(stack.id);
          }).pipe(
            recordUnlessInterrupted((cause) =>
              Effect.gen(function* () {
                const error = Cause.squash(cause);
                if (
                  error instanceof ManagedOperationOwnershipError ||
                  error instanceof ManagedStackNotFoundError
                ) {
                  skippedOperationIds.push(operation.token);
                  return;
                }
                failures.push({
                  operation,
                  phase: "reconciliation",
                  operationReleased: yield* failRecoveryBestEffort(claimedStack, operation, error),
                  error,
                });
              }),
            ),
          );
        });

      for (const operation of operations) {
        yield* settleOperation(operation);
      }
      return {
        recovered,
        abortedStackIds,
        reclaimedStackIds,
        retained,
        skippedOperationIds,
        failures,
      };
    });

  const prune = (
    request: ManagedPruneRequest,
  ): Effect.Effect<ManagedPruneResult, ManagedPruneFailure> =>
    Effect.gen(function* () {
      const recordIds =
        "operation" in request
          ? request.operation === "prune"
            ? request.recordIds
            : yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed prune requires a prune recovery operation",
                }),
              )
          : request.recordIds;
      if (
        !Array.isArray(recordIds) ||
        recordIds.some((recordId) => typeof recordId !== "string" || recordId.trim() === "")
      ) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Managed prune record IDs must be non-empty strings",
          }),
        );
      }
      const uniqueRecordIds = new Set(recordIds);
      if (uniqueRecordIds.size !== recordIds.length) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({ message: "Managed prune record IDs must be unique" }),
        );
      }
      return yield* repository.pruneIdentityMetadata({ locationIds: recordIds });
    });

  return {
    inspectStack: repository.getStackProjection,
    listStacks: repository.listStackProjections,
    updateStack: updateStackRecord,
    registerStack,
    deleteStack,
    reconcileAbandonedOperations,
    prune,
  };
};
