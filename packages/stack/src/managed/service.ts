import { randomUUID } from "node:crypto";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schedule,
} from "effect";
import {
  DEFAULT_MANAGED_STACK_NAME,
  InvalidManagedIdentityError,
  InvalidManagedOwnerPidError,
  InvalidManagedStackNameError,
  ManagedAbandonedOperationError,
  ManagedOperationInProgressError,
  ManagedOperationOwnershipError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  ManagedStackPublicationTimeoutError,
  UnsafeManagedStackPathError,
  type ManagedCheckoutLocation,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackRecord,
  type ManagedStackSelection,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import {
  canonicalizeOrdinaryWorkspacePath,
  ensureOrdinaryWorkspaceIdentity,
  readOrdinaryWorkspaceIdentity,
} from "./identity.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import {
  assertManagedStackRoot,
  managedStackPaths,
  requireExplicitManagedStateRoot,
} from "./paths.ts";
import { fromCallback, isBooleanAnswer } from "./callback.ts";
import { errorCode } from "./error-code.ts";
import { failsWith } from "./failure.ts";
import {
  assertManagedOwnerPid,
  isUsableManagedOwnerPid,
  ManagedStackRepository,
  type ClaimManagedOperationFailure,
  type OwnedManagedStackFailure,
  type PrepareOrdinaryStackFailure,
  type UpdateManagedStackFailure,
} from "./repository.ts";

export interface ManagedStackServiceOptions {
  readonly stateRoot: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly ownerPid?: number;
  readonly publicationTimeoutMs?: number;
  readonly publicationPollMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface ProvisionOrdinaryStackOptions {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly configuration?: ManagedStackConfiguration;
  /**
   * Provisioning steps a caller owns. Their failures never reach the caller as
   * themselves: whatever they fail with becomes the `cause` of a
   * {@link ManagedStackInitializationError} once the pending stack is rolled
   * back, so the error channel here is deliberately open.
   */
  readonly initialize?: (stack: ManagedStackRecord) => Effect.Effect<void, unknown>;
  readonly validate?: (stack: ManagedStackRecord) => Effect.Effect<void, unknown>;
}

export interface ProvisionOrdinaryStackResult {
  readonly outcome: "create" | "reuse";
  readonly selection: ManagedStackSelection;
  readonly stack: ManagedStackRecord;
  readonly identityMarkerCreated: boolean;
}

export interface InspectOrdinaryWorkspaceResult {
  readonly registered: boolean;
  readonly identity?: OrdinaryWorkspaceIdentity;
  readonly stacks: ReadonlyArray<ManagedStackRecord>;
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
  /**
   * Discarded pending stacks whose leaked provisioning data was removed. A stack
   * whose removal failed is reported under `failures` with the
   * `state-reclamation` phase instead, never here: this list means the data is
   * gone.
   */
  readonly abortedStackIds: ReadonlyArray<string>;
  /**
   * Tombstoned stacks whose abandoned deletion recovery finished, with the same
   * removal-succeeded guarantee as {@link abortedStackIds}. The registry
   * tombstone is deliberately preserved so repeated deletion stays idempotent;
   * only the leaked stack directory is reclaimed.
   */
  readonly reclaimedStackIds: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<RetainedManagedOperation>;
  readonly skippedOperationIds: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<ManagedOperationRecoveryFailure>;
}

/** Claiming an operation on behalf of a caller, including a refused claim. */
type RequireManagedOperationFailure =
  | ClaimManagedOperationFailure
  | InvalidManagedIdentityError
  | ManagedOperationInProgressError;

export type UpdateManagedStackConfigurationFailure =
  | RequireManagedOperationFailure
  | UpdateManagedStackFailure;

export type ProvisionManagedStackFailure =
  | InvalidManagedIdentityError
  | InvalidManagedStackNameError
  | ManagedAbandonedOperationError
  | ManagedOperationInProgressError
  | ManagedStackInitializationError
  | ManagedStackNotFoundError
  | ManagedStackPublicationTimeoutError
  | PrepareOrdinaryStackFailure
  | UpdateManagedStackConfigurationFailure;

export type DeleteManagedStackFailure =
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | OwnedManagedStackFailure
  | RequireManagedOperationFailure
  | UpdateManagedStackFailure;

export interface ManagedStackServiceShape {
  readonly stateRoot: string;
  readonly provisionOrdinaryStack: (
    options: ProvisionOrdinaryStackOptions,
  ) => Effect.Effect<ProvisionOrdinaryStackResult, ProvisionManagedStackFailure>;
  readonly inspectOrdinaryWorkspace: (
    workspacePath: string,
  ) => Effect.Effect<InspectOrdinaryWorkspaceResult, InvalidManagedIdentityError>;
  readonly inspectStack: (stackId: string) => Effect.Effect<ManagedStackRecord | undefined>;
  readonly listStacks: (options?: {
    readonly includeTombstoned?: boolean;
  }) => Effect.Effect<ReadonlyArray<ManagedStackRecord>>;
  readonly updateStack: (
    stackId: string,
    configuration: ManagedStackConfiguration,
  ) => Effect.Effect<ManagedStackRecord, UpdateManagedStackConfigurationFailure>;
  /**
   * The `stop` callback's failure reaches the caller unchanged — a stack that
   * refused to stop was not deleted — so its error type flows through.
   */
  readonly deleteStack: <E = never>(
    stackId: string,
    options?: { readonly stop?: (stack: ManagedStackRecord) => Effect.Effect<void, E> },
  ) => Effect.Effect<DeleteManagedStackResult, DeleteManagedStackFailure | E>;
  /**
   * Recovery reports rather than fails: a runtime it could not inspect is a
   * retained operation, and a reclamation it could not finish is a reported
   * failure. Only a forced target that is not a pair of managed UUIDs refuses
   * the whole pass.
   */
  readonly reconcileAbandonedOperations: (
    options: ReconcileAbandonedOperationsOptions,
  ) => Effect.Effect<ReconcileAbandonedOperationsResult, InvalidManagedIdentityError>;
  readonly pruneCheckoutLocations: <E = never>(
    shouldPrune: (location: ManagedCheckoutLocation) => Effect.Effect<boolean, E>,
  ) => Effect.Effect<number, E>;
}

const selectionForStack = (stack: ManagedStackRecord): ManagedStackSelection => ({
  projectId: stack.projectId,
  checkoutId: stack.checkoutId,
  contextId: stack.contextId,
  stackId: stack.id,
  stackName: stack.name,
});

const provisionResult = (
  outcome: ProvisionOrdinaryStackResult["outcome"],
  stack: ManagedStackRecord,
  identityMarkerCreated: boolean,
): ProvisionOrdinaryStackResult => ({
  outcome,
  selection: selectionForStack(stack),
  stack,
  identityMarkerCreated,
});

const deletionResult = (
  outcome: DeleteManagedStackResult["outcome"],
  stack: ManagedStackRecord,
  dataReclamation: DeleteManagedStackResult["dataReclamation"],
): DeleteManagedStackResult => ({ outcome, stack, dataReclamation });

const dataRemoved: DeleteManagedStackResult["dataReclamation"] = { outcome: "removed" };

const dataRetained = (error: unknown): DeleteManagedStackResult["dataReclamation"] => ({
  outcome: "retained",
  error,
});

const unregisteredWorkspace: InspectOrdinaryWorkspaceResult = { registered: false, stacks: [] };

/**
 * How recovery and best-effort cleanup absorb a step that refused.
 *
 * Whatever the registry, the filesystem, or a caller's seam raised becomes part
 * of the report — that is what makes these paths best-effort — but an interrupted
 * step has no outcome to report at all: recording one would invent a refusal that
 * never happened, mark a stack failed on behalf of a caller that has gone away,
 * and make the operation the next pass should still recover look like one
 * recovery already gave up on. So interruption is re-raised instead.
 */
const recordUnlessInterrupted =
  <E, A2, E2, R2>(record: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>) =>
  <A, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E2, R | R2> =>
    Effect.catchCause(self, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : record(cause),
    );

/**
 * The error an absorbed step refused with, for a report entry to carry — or an
 * interruption, re-raised before any entry is built. It is the rule
 * {@link recordUnlessInterrupted} applies to a whole step, applied where the
 * step's exit is inspected instead: an interrupted step has no outcome, so it
 * must not become a report entry either way.
 */
const absorbedError = <E>(cause: Cause.Cause<E>): Effect.Effect<unknown> =>
  Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(Cause.squash(cause));

/** What one look at a stack awaiting publication can refuse to wait for. */
type PublicationPollFailure = ManagedAbandonedOperationError | ManagedStackNotFoundError;

/** Ceiling for the publication poll's backoff. */
const MAX_PUBLICATION_POLL_MS = 250;

const stackNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Deliberately conservative: only a definite `ESRCH` proves the owner is gone,
 * so a permission error (`EPERM`) keeps the claim rather than stealing it. It
 * must never be asked about a value that is not a pid — `kill(0, 0)` signals
 * the caller's own process group, and a fractional pid throws, either of which
 * would report a dead owner as alive and wedge recovery forever. Callers
 * therefore filter pids through {@link isUsableManagedOwnerPid} first.
 */
const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
};

/**
 * The managed registry's policy layer: identity marker handling, provisioning
 * order, publication waiting, deletion, and recovery of abandoned operations.
 */
export class ManagedStackService extends Context.Service<
  ManagedStackService,
  ManagedStackServiceShape
>()("stack/managed/ManagedStackService") {
  static make(
    options: ManagedStackServiceOptions,
  ): Layer.Layer<
    ManagedStackService,
    InvalidManagedOwnerPidError | UnsafeManagedStackPathError,
    FileSystem.FileSystem | ManagedStackRepository
  > {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const repository = yield* ManagedStackRepository;
        const fs = yield* FileSystem.FileSystem;
        // Anchored and validated once, at the boundary, through the one resolver
        // that owns state-root policy: a relative root injected here would be
        // reinterpreted against the process' cwd at every later use, and a blank
        // or missing one would anchor every managed path to it.
        const stateRoot = yield* Effect.try({
          try: () => requireExplicitManagedStateRoot(options.stateRoot),
          catch: failsWith<UnsafeManagedStackPathError>(UnsafeManagedStackPathError),
        });
        // Validated here as well as in the repository: the pid is this service's
        // own option, so the failure belongs to the caller that supplied it.
        yield* Effect.try({
          try: () => {
            assertManagedOwnerPid(options.ownerPid);
          },
          catch: failsWith<InvalidManagedOwnerPidError>(InvalidManagedOwnerPidError),
        });

        const idFactory = options.idFactory ?? randomUUID;
        const clock = options.clock ?? (() => new Date());
        const ownerPid = options.ownerPid ?? process.pid;
        const publicationTimeoutMs = options.publicationTimeoutMs ?? 10_000;
        const publicationPollMs = options.publicationPollMs ?? 10;
        const isProcessAlive = options.isProcessAlive ?? processIsAlive;
        const now = (): string => clock().toISOString();

        const managedUuid = (label: string): Effect.Effect<string, InvalidManagedIdentityError> =>
          Effect.try({
            try: () => createManagedUuid(idFactory, label),
            catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
          });

        const requireManagedUuid = (
          value: string,
          label: string,
        ): Effect.Effect<string, InvalidManagedIdentityError> =>
          Effect.try({
            try: () => assertManagedUuid(value, label),
            catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
          });

        /**
         * `isProcessAlive` is a caller-supplied seam that may answer
         * synchronously or asynchronously, and may refuse to answer at all.
         * Recovery reports a refusal as a retained operation, so the refusal is
         * kept in the error channel here rather than being turned into a defect.
         */
        const probeProcessAlive = (pid: number): Effect.Effect<boolean, unknown> =>
          fromCallback(() => isProcessAlive(pid), isBooleanAnswer);

        /**
         * A stack's directory is only ever removed through the path guard, so a
         * forged or stale record cannot make recovery delete something outside the
         * state root. Both refusals — the guard's and the filesystem's — are
         * reported as retained data rather than propagated.
         */
        const removeStackState = (stack: ManagedStackRecord) =>
          Effect.flatMap(
            Effect.try({
              try: () => assertManagedStackRoot(stateRoot, stack.id, stack.paths.root),
              catch: failsWith<UnsafeManagedStackPathError>(UnsafeManagedStackPathError),
            }),
            (root) => fs.remove(root, { force: true, recursive: true }),
          );

        const reclaimStackState = (
          stack: ManagedStackRecord,
        ): Effect.Effect<DeleteManagedStackResult["dataReclamation"]> =>
          removeStackState(stack).pipe(
            Effect.as(dataRemoved),
            recordUnlessInterrupted((cause) => Effect.succeed(dataRetained(Cause.squash(cause)))),
          );

        /**
         * Marks an operation failed as part of a recovery report, answering
         * whether the claim was actually released — a claim that could not be
         * released is reported, not hidden. Interruption is re-raised, because
         * this is a recording site: there is no report to put an interrupted
         * step in.
         */
        const finishOperationBestEffort = (
          stackId: string,
          operationToken: string,
          error: unknown,
        ): Effect.Effect<boolean> =>
          repository.finishOperation(stackId, operationToken, "failed", now(), String(error)).pipe(
            Effect.as(true),
            // Preserve the operation's original failure when ownership changed concurrently.
            recordUnlessInterrupted(() => Effect.succeed(false)),
          );

        /**
         * Releases this call's claim on the way out of a failed operation, then
         * re-raises the cause that got here.
         *
         * The release absorbs everything it can raise, its own interruption
         * included: the caller's outcome is the failure the operation suffered,
         * and an embedder repository that reports interruption from
         * `finishOperation` would otherwise replace that failure with an
         * interruption the caller never asked for. That is the opposite of the
         * recording sites above, where an interrupted step has no outcome and
         * interruption is the only honest answer.
         */
        const releasingClaimOnFailure =
          (stackId: string, operationToken: string) =>
          <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
            Effect.catchCause(self, (cause) =>
              repository
                .finishOperation(
                  stackId,
                  operationToken,
                  "failed",
                  now(),
                  String(Cause.squash(cause)),
                )
                .pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.flatMap(() => Effect.failCause(cause)),
                ),
            );

        /**
         * A concurrent forced recovery can resolve this same operation before
         * this call closes it out, but only after the delete's own data removal
         * already ran — so the delete is provably done and its ownership race
         * must not be reported as a failure. Any other error still propagates,
         * since only that specific race is known to be harmless.
         */
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
              // Releasing the abandoned claim is still useful if the failed lifecycle cannot be recorded.
              recordUnlessInterrupted(() => Effect.void),
              Effect.flatMap(() =>
                finishOperationBestEffort(operation.stackId, operation.token, error),
              ),
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

        // Publication normally lands within the first poll, so start tight and
        // back off: a slow publisher must not be polled hundreds of times per
        // second for the whole timeout window. The ceiling only ever slows
        // polling down, so a caller asking for a slower interval keeps its own.
        const publicationPollCeiling = Math.max(MAX_PUBLICATION_POLL_MS, publicationPollMs);
        const publicationPollSchedule = Schedule.exponential(
          Duration.millis(publicationPollMs),
        ).pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(
              Duration.millis(Math.min(Duration.toMillis(duration), publicationPollCeiling)),
            ),
          ),
        );

        /**
         * One look at a stack a caller is waiting for. `Option.none()` is the
         * retryable answer — the row is still pending, so the poll schedules
         * another look — while the two failures are final answers about a
         * publisher that will never arrive.
         */
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
          | ManagedAbandonedOperationError
          | ManagedStackNotFoundError
          | ManagedStackPublicationTimeoutError
        > =>
          pollPublication(pending).pipe(
            Effect.repeat({
              schedule: publicationPollSchedule,
              while: (answer: Option.Option<ManagedStackRecord>) => Option.isNone(answer),
            }),
            // The timeout is the caller's bound on the whole wait, so it
            // interrupts the poll rather than being checked between polls.
            Effect.timeoutOrElse({
              duration: Duration.millis(publicationTimeoutMs),
              orElse: () =>
                Effect.fail(new ManagedStackPublicationTimeoutError({ stackId: pending.id })),
            }),
            // Only an unbounded schedule guarantees the repeat stops on a
            // published stack, and this one is unbounded. A recurrence bound
            // added later would hand back the final `None` instead, so the
            // answer is checked rather than asserted through a refinement: a
            // schedule that gave up is a bug in this module, not an outcome a
            // caller could act on.
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

        /**
         * Reused stacks adopt the caller's requested configuration regardless of
         * whether the record was already published or was awaited while another
         * caller published it, so the outcome never depends on that timing.
         */
        const applyRequestedConfiguration = (
          stack: ManagedStackRecord,
          configuration: ManagedStackConfiguration | undefined,
        ): Effect.Effect<ManagedStackRecord, UpdateManagedStackConfigurationFailure> =>
          configuration === undefined || Object.keys(configuration).length === 0
            ? Effect.succeed(stack)
            : updateStackRecord(stack.id, configuration);

        const provisionOrdinaryStack = (
          provisionOptions: ProvisionOrdinaryStackOptions,
        ): Effect.Effect<ProvisionOrdinaryStackResult, ProvisionManagedStackFailure> =>
          Effect.gen(function* () {
            const stackName = provisionOptions.stackName ?? DEFAULT_MANAGED_STACK_NAME;
            if (!stackNamePattern.test(stackName)) {
              return yield* Effect.fail(new InvalidManagedStackNameError({ stackName }));
            }
            const canonicalPath = yield* canonicalizeOrdinaryWorkspacePath(
              provisionOptions.workspacePath,
            );
            const marker = yield* ensureOrdinaryWorkspaceIdentity(canonicalPath, idFactory);
            const stackId = yield* managedUuid("stackId");
            const locationId = yield* managedUuid("checkout location id");
            const operationToken = yield* managedUuid("operation token");
            const paths = yield* Effect.try({
              try: () => managedStackPaths(stateRoot, stackId),
              catch: failsWith<InvalidManagedIdentityError>(InvalidManagedIdentityError),
            });
            const prepared = yield* repository.prepareOrdinaryStack({
              identity: marker.identity,
              canonicalPath,
              locationId,
              stackId,
              stackName,
              paths,
              operationToken,
              ownerPid,
              now: now(),
              configuration: provisionOptions.configuration ?? {},
            });

            if (prepared.outcome === "existing") {
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
                  provisionOptions.configuration,
                );
                return provisionResult("reuse", stack, marker.created);
              }
              if (prepared.operation === undefined) {
                return yield* Effect.fail(
                  new ManagedAbandonedOperationError({ stackId: prepared.stack.id }),
                );
              }
              // A stored pid that is not a usable pid means there is no owner to
              // wait for, exactly as a missing one does: probing it could report
              // a dead publisher as alive and make this caller wait out the whole
              // publication timeout instead of reporting the abandoned claim.
              // Provisioning has no report to put a refused probe in, so a seam
              // that cannot answer is a defect here rather than an outcome.
              if (
                !isUsableManagedOwnerPid(prepared.operation.ownerPid) ||
                !(yield* Effect.orDie(probeProcessAlive(prepared.operation.ownerPid)))
              ) {
                return yield* Effect.fail(
                  new ManagedAbandonedOperationError({ stackId: prepared.stack.id }),
                );
              }
              const awaited = yield* awaitPublication(prepared.stack);
              const published = yield* applyRequestedConfiguration(
                awaited,
                provisionOptions.configuration,
              );
              return provisionResult("reuse", published, marker.created);
            }

            const pending = prepared.stack;
            const operation = prepared.operation;
            // Between preparing the pending row and publishing it, this call
            // owns a registry row, an operation claim, and the directories it
            // created, so the compensation has to run even when the fiber is
            // interrupted: a caller that times out or closes the service must
            // not leave a pending stack and a leaked directory behind. Only the
            // provisioning steps are interruptible; the rollback is not.
            //
            // The mask starts after `prepareOrdinaryStack`, so it covers the row
            // this call owns but not the act of creating it. That is sound only
            // because every repository this package ships decides synchronously:
            // both adapters run the pending row and its claim as one SQLite
            // transaction or one in-memory mutation, with no suspension point an
            // interruption could land on. An asynchronous embedder repository
            // breaks that assumption — interrupted mid-prepare it would leave a
            // pending row and a claim nothing compensates — so the mask must be
            // extended to cover row creation before async repositories become
            // real. `deleteStack`'s claim has the same shape.
            return yield* Effect.uninterruptibleMask((restore) =>
              restore(
                Effect.gen(function* () {
                  yield* fs.makeDirectory(pending.paths.data, { recursive: true, mode: 0o700 });
                  yield* fs.makeDirectory(pending.paths.logs, { recursive: true, mode: 0o700 });
                  yield* fs.makeDirectory(pending.paths.runtime, { recursive: true, mode: 0o700 });
                  if (provisionOptions.initialize !== undefined) {
                    yield* provisionOptions.initialize(pending);
                  }
                  if (provisionOptions.validate !== undefined) {
                    yield* provisionOptions.validate(pending);
                  }
                  const published = yield* repository.publishPendingStack(
                    pending.id,
                    operation.token,
                    now(),
                  );
                  return provisionResult("create", published, marker.created);
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
                    // A provision the caller abandoned is not an initialization
                    // that failed: the interruption is the outcome, and
                    // reporting it as a failure would tell the caller its own
                    // timeout was the stack's fault.
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
              ),
            );
          });

        const inspectOrdinaryWorkspace = (
          workspacePath: string,
        ): Effect.Effect<InspectOrdinaryWorkspaceResult, InvalidManagedIdentityError> =>
          Effect.gen(function* () {
            const canonicalPath = yield* canonicalizeOrdinaryWorkspacePath(workspacePath);
            const identity = yield* readOrdinaryWorkspaceIdentity(canonicalPath);
            if (identity === undefined) {
              return unregisteredWorkspace;
            }
            const stacks = (yield* repository.listStacks()).filter(
              (stack) =>
                stack.projectId === identity.projectId &&
                stack.checkoutId === identity.checkoutId &&
                stack.contextId === identity.contextId,
            );
            return { registered: stacks.length > 0, identity, stacks };
          });

        const deleteStack = <E = never>(
          stackId: string,
          deleteOptions?: {
            readonly stop?: (stack: ManagedStackRecord) => Effect.Effect<void, E>;
          },
        ): Effect.Effect<DeleteManagedStackResult, DeleteManagedStackFailure | E> =>
          Effect.gen(function* () {
            const existing = yield* repository.getStack(stackId);
            if (existing === undefined) {
              return yield* Effect.fail(new ManagedStackNotFoundError({ stackId }));
            }
            if (existing.status === "tombstoned") {
              return deletionResult("no-op", existing, yield* reclaimStackState(existing));
            }
            const operation = yield* requireOperation(stackId, "delete");
            // The claim belongs to this call, so releasing it has to survive an
            // interruption too: a caller that gave up mid-delete must not leave
            // the stack claimed by an operation nobody will ever finish. The
            // original cause is re-raised either way, so an interrupted delete
            // stays interrupted.
            return yield* Effect.uninterruptibleMask((restore) =>
              restore(
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
                  const tombstoned = yield* repository.tombstoneStack(
                    stackId,
                    operation.token,
                    now(),
                  );
                  const dataReclamation = yield* reclaimStackState(tombstoned);
                  yield* finishDeleteOperationTolerantly(stackId, operation.token);
                  return deletionResult("delete", tombstoned, dataReclamation);
                }),
              ).pipe(releasingClaimOnFailure(stackId, operation.token)),
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
              yield* requireManagedUuid(forcedOperation.stackId, "forced recovery stackId");
              yield* requireManagedUuid(
                forcedOperation.operationToken,
                "forced recovery operation token",
              );
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
                // A persisted pid that is not a usable pid is treated as no owner
                // at all: asking the liveness probe about it could report a live
                // owner and wedge this claim forever, which is the failure
                // recovery exists to fix.
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
                  // A tombstoned row is a deletion that died before releasing its
                  // claim. Its registry state is already final, so
                  // `reconcileOperation` ignores the lifecycle for it — and
                  // tombstoning zeroed the runtime metadata an inspector would
                  // need, so asking could only answer "unknown" and leak the
                  // stack directory forever.
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
                  // Both remaining outcomes leave state on disk that no registry
                  // row will ever point at again: a discarded pending stack's
                  // partial provisioning, or the data a crashed deletion never
                  // got to remove. The stack is reported under either id list
                  // only once that data is actually gone; otherwise the removal
                  // failure is the whole report.
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
                        operationReleased: yield* failRecoveryBestEffort(
                          claimedStack,
                          operation,
                          error,
                        ),
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

        const pruneCheckoutLocations = <E = never>(
          shouldPrune: (location: ManagedCheckoutLocation) => Effect.Effect<boolean, E>,
        ): Effect.Effect<number, E> =>
          Effect.gen(function* () {
            const stale: Array<string> = [];
            for (const location of yield* repository.listCheckoutLocations()) {
              if (yield* shouldPrune(location)) {
                stale.push(location.id);
              }
            }
            return yield* repository.pruneCheckoutLocations(stale);
          });

        return {
          stateRoot,
          provisionOrdinaryStack,
          inspectOrdinaryWorkspace,
          inspectStack: (stackId) => repository.getStack(stackId),
          listStacks: (listOptions) => repository.listStacks(listOptions),
          updateStack: updateStackRecord,
          deleteStack,
          reconcileAbandonedOperations,
          pruneCheckoutLocations,
        };
      }),
    );
  }
}
