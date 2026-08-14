import { randomUUID } from "node:crypto";
import { Context, Effect, FileSystem, Layer } from "effect";
import {
  DEFAULT_MANAGED_STACK_NAME,
  DuplicateManagedIdentityError,
  InvalidManagedIdentityError,
  ManagedCheckoutConflictError,
  ManagedInaccessiblePathError,
  InvalidManagedOwnerPidError,
  InvalidManagedStackNameError,
  ManagedAbandonedOperationError,
  ManagedOperationInProgressError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackPublicationTimeoutError,
  UnsafeManagedStackPathError,
  UnsupportedGitWorkspaceError,
  type ManagedIdentityTriple,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackProjection,
  type ManagedStackRecord,
  type ManagedStackSelection,
} from "./model.ts";
import { GitConfigStore } from "./git.ts";
import { createManagedUuid } from "./ids.ts";
import { requireExplicitManagedStateRoot } from "./paths.ts";
import { fromCallback, isBooleanAnswer } from "./callback.ts";
import { errorCode } from "./error-code.ts";
import { failsWith } from "./failure.ts";
import {
  assertManagedOwnerPid,
  ManagedStackRepository,
  type AbandonManagedIdentityTransitionResult,
  type PrepareStackFailure,
} from "./repository.ts";
import type { ManagedIdentityRecoveryError } from "./repository.ts";
import type { ManagedWorkspaceDiscovery } from "./discovery.ts";
import { discoveryObservation } from "./discovery-observation.ts";
import {
  makeStackLifecycle,
  type StackLifecycle,
  type DeleteManagedStackFailure as LifecycleDeleteManagedStackFailure,
  type DeleteManagedStackResult as LifecycleDeleteManagedStackResult,
  type ManagedOperationRecoveryFailure as LifecycleManagedOperationRecoveryFailure,
  type ManagedPruneFailure as LifecycleManagedPruneFailure,
  type ManagedPruneRequest as LifecycleManagedPruneRequest,
  type ManagedPruneResult as LifecycleManagedPruneResult,
  type ReconcileAbandonedOperationsOptions as LifecycleReconcileAbandonedOperationsOptions,
  type ReconcileAbandonedOperationsResult as LifecycleReconcileAbandonedOperationsResult,
  type RetainedManagedOperation as LifecycleRetainedManagedOperation,
  type RegisterManagedStackInput,
  type RegisterManagedStackResult,
  type UpdateManagedStackConfigurationFailure as LifecycleUpdateManagedStackConfigurationFailure,
} from "./stack-lifecycle.ts";
import {
  makeWorkspaceIdentity,
  requireResolvedIdentity,
  type ManagedCheckoutRecoveryRequest,
  type ManagedIdentityTransitionAbandonRequest,
  type ResolvedManagedContext,
  type ResolvedManagedIdentity,
  type ResolvedManagedWorkspace,
  type ResolvedWorkspacePlan,
} from "./workspace-identity.ts";

export type {
  ManagedCheckoutRecoveryRequest,
  ManagedIdentityTransitionAbandonRequest,
  ResolvedManagedContext,
  ResolvedManagedIdentity,
  ResolvedManagedWorkspace,
} from "./workspace-identity.ts";

export interface ManagedStackServiceOptions {
  readonly stateRoot: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly ownerPid?: number;
  readonly publicationTimeoutMs?: number;
  readonly publicationPollMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

/**
 * What a resolve is allowed to do.
 *
 * `status` is strictly read-only — it claims no identity, creates no registry
 * row, and writes no marker — so the same resolution a `start` would reach can be
 * reported for a workspace that has never been registered. `start` is the
 * mutating counterpart: it claims whatever identity is missing and registers the
 * stack.
 */
export type ResolveManagedStackOperation = "start" | "status";

export interface ResolveManagedStackOptions {
  readonly workspacePath: string;
  readonly operation: ResolveManagedStackOperation;
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

/** Explicit metadata records selected for safe, non-destructive pruning. */
export type ManagedPruneRequest = LifecycleManagedPruneRequest;

/** The repository policy result for a metadata-only prune request. */
export type ManagedPruneResult = LifecycleManagedPruneResult;

export type ManagedPruneFailure = LifecycleManagedPruneFailure;

/** Whether the named stack exists yet, and if it does, what it is doing. */
export type ResolvedManagedStackState = "unregistered" | ManagedStackLifecycle;

export interface ManagedStackResolution {
  readonly operation: ResolveManagedStackOperation;
  readonly outcome: "create" | "report" | "reuse";
  readonly workspace: ResolvedManagedWorkspace;
  readonly context: ResolvedManagedContext;
  readonly identity: ResolvedManagedIdentity;
  readonly stackName: string;
  readonly state: ResolvedManagedStackState;
  readonly selection?: ManagedStackSelection;
  readonly stack?: ManagedStackProjection;
  /** Every live stack already registered in the resolved project, checkout, and context, this one included. */
  readonly stacks: ReadonlyArray<ManagedStackProjection>;
  /** Whether this call published a checkout identity that did not exist yet. */
  readonly identityMarkerCreated: boolean;
}

/**
 * A resolve that was allowed to claim, so its identity and stack are settled
 * facts rather than things that may not exist yet.
 */
export interface StartedManagedStackResolution extends ManagedStackResolution {
  readonly operation: "start";
  readonly outcome: "create" | "reuse";
  readonly identity: ManagedIdentityTriple;
  readonly selection: ManagedStackSelection;
  readonly stack: ManagedStackProjection;
}

export type DeleteManagedStackResult = LifecycleDeleteManagedStackResult;
export type ReconcileAbandonedOperationsOptions<E = unknown> =
  LifecycleReconcileAbandonedOperationsOptions<E>;
export type RetainedManagedOperation = LifecycleRetainedManagedOperation;
export type ManagedOperationRecoveryFailure = LifecycleManagedOperationRecoveryFailure;
export type ReconcileAbandonedOperationsResult = LifecycleReconcileAbandonedOperationsResult;

export type UpdateManagedStackConfigurationFailure =
  LifecycleUpdateManagedStackConfigurationFailure;

export type ResolveManagedStackFailure =
  | InvalidManagedIdentityError
  | DuplicateManagedIdentityError
  | ManagedIdentityRecoveryError
  | InvalidManagedStackNameError
  | ManagedAbandonedOperationError
  | ManagedOperationInProgressError
  | ManagedStackInitializationError
  | ManagedStackNotFoundError
  | ManagedStackPublicationTimeoutError
  | PrepareStackFailure
  | UnsupportedGitWorkspaceError
  | UpdateManagedStackConfigurationFailure;

export type DeleteManagedStackFailure = LifecycleDeleteManagedStackFailure;

export interface ManagedStackServiceShape extends Pick<
  StackLifecycle,
  | "inspectStack"
  | "listStacks"
  | "updateStack"
  | "deleteStack"
  | "reconcileAbandonedOperations"
  | "prune"
> {
  readonly stateRoot: string;
  readonly discoverWorkspace: (
    workspacePath: string,
  ) => Effect.Effect<
    ManagedWorkspaceDiscovery,
    InvalidManagedIdentityError | UnsupportedGitWorkspaceError
  >;
  readonly newCheckout: (
    options: ManagedCheckoutRecoveryRequest,
  ) => Effect.Effect<
    ManagedWorkspaceDiscovery,
    | InvalidManagedIdentityError
    | DuplicateManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityRecoveryError
  >;
  readonly rebindCheckout: (
    options: ManagedCheckoutRecoveryRequest,
  ) => Effect.Effect<
    ManagedWorkspaceDiscovery,
    | InvalidManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityRecoveryError
    | ManagedInaccessiblePathError
  >;
  readonly adoptContext: (
    options: ManagedCheckoutRecoveryRequest,
  ) => Effect.Effect<
    ManagedWorkspaceDiscovery,
    InvalidManagedIdentityError | UnsupportedGitWorkspaceError | ManagedIdentityRecoveryError
  >;
  readonly abandonIdentityTransition: (
    options: ManagedIdentityTransitionAbandonRequest,
  ) => Effect.Effect<
    AbandonManagedIdentityTransitionResult,
    | InvalidManagedIdentityError
    | DuplicateManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityRecoveryError
  >;
  /**
   * The one path from a workspace path to a stack, for every workspace shape and
   * both operations. Nothing else in the managed surface classifies a workspace
   * or decides an identity, so a `status` and the `start` that follows it cannot
   * disagree about which stack they are talking about.
   *
   * A `start` resolve always settles on a stack, which is what the narrower
   * overload reports.
   */
  readonly resolveStack: {
    (
      options: ResolveManagedStackOptions & { readonly operation: "start" },
    ): Effect.Effect<StartedManagedStackResolution, ResolveManagedStackFailure>;
    (
      options: ResolveManagedStackOptions,
    ): Effect.Effect<ManagedStackResolution, ResolveManagedStackFailure>;
  };
}

const selectionForStack = (stack: ManagedStackRecord): ManagedStackSelection => ({
  projectId: stack.projectId,
  checkoutId: stack.checkoutId,
  contextId: stack.contextId,
  stackId: stack.id,
  stackName: stack.name,
});

const stackNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Deliberately conservative: only a definite `ESRCH` proves the owner is gone,
 * so a permission error (`EPERM`) keeps the claim rather than stealing it. It
 * must never be asked about a value that is not a pid — `kill(0, 0)` signals
 * the caller's own process group, and a fractional pid throws, either of which
 * would report a dead owner as alive and wedge recovery forever. Callers
 * therefore validate persisted pids before probing them.
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
 * Public managed-stack contract and composition root. Policy implementations
 * are supplied by the workspace-identity and stack-lifecycle modules below.
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
    FileSystem.FileSystem | GitConfigStore | ManagedStackRepository
  > {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const repository = yield* ManagedStackRepository;
        const fs = yield* FileSystem.FileSystem;
        // Captured while the layer is built, so every method this service returns
        // is requirement-free: a caller holding the service never has to know
        // that resolving a workspace reads git config and the filesystem.
        const gitConfigStore = yield* GitConfigStore;
        const withWorkspaceServices = <A, E>(
          effect: Effect.Effect<A, E, FileSystem.FileSystem | GitConfigStore>,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.provideService(GitConfigStore, gitConfigStore),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
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

        /**
         * `isProcessAlive` is a caller-supplied seam that may answer
         * synchronously or asynchronously, and may refuse to answer at all.
         * Recovery reports a refusal as a retained operation, so the refusal is
         * kept in the error channel here rather than being turned into a defect.
         */
        const probeProcessAlive = (pid: number): Effect.Effect<boolean, unknown> =>
          fromCallback(() => isProcessAlive(pid), isBooleanAnswer);

        const stackLifecycle = makeStackLifecycle({
          repository,
          fileSystem: fs,
          stateRoot,
          managedUuid,
          now,
          ownerPid,
          publicationTimeoutMs,
          publicationPollMs,
          probeProcessAlive,
        });

        const workspaceIdentity = makeWorkspaceIdentity({
          repository,
          withWorkspaceServices,
          idFactory,
          managedUuid,
          now,
        });

        /**
         * Every live stack of one resolved project, checkout, and context, as a
         * reader sees them. The repository identity filter avoids enumerating and
         * hydrating unrelated stacks; the retained filter protects this service
         * contract for injected repositories that may not implement that scope.
         */
        const contextStacks = (
          identity: ManagedIdentityTriple,
        ): Effect.Effect<ReadonlyArray<ManagedStackProjection>> =>
          Effect.map(repository.listStackProjections({ identity }), (stacks) =>
            stacks.filter(
              (stack) =>
                stack.projectId === identity.projectId &&
                stack.checkoutId === identity.checkoutId &&
                stack.contextId === identity.contextId,
            ),
          );

        const requireProjection = (
          stack: ManagedStackRecord,
        ): Effect.Effect<ManagedStackProjection> =>
          Effect.flatMap(repository.getStackProjection(stack.id), (projection) =>
            projection === undefined
              ? Effect.die(
                  new Error(`Managed stack ${stack.id} vanished while it was being resolved`),
                )
              : Effect.succeed(projection),
          );

        /**
         * A settled mutating resolve. The identity is read back off the stack
         * rather than off the plan: a checkout-scoped context the registry already
         * had wins over the one this call minted, so the row is the only place the
         * resolved context is certain.
         */
        const startedResolution = (
          plan: ResolvedWorkspacePlan,
          outcome: "create" | "reuse",
          stack: ManagedStackProjection,
        ): Effect.Effect<StartedManagedStackResolution> =>
          Effect.map(
            contextStacks({
              projectId: stack.projectId,
              checkoutId: stack.checkoutId,
              contextId: stack.contextId,
            }),
            (stacks) => ({
              operation: "start",
              outcome,
              workspace: plan.workspace,
              context: plan.context,
              identity: {
                projectId: stack.projectId,
                checkoutId: stack.checkoutId,
                contextId: stack.contextId,
              },
              stackName: stack.name,
              state: stack.lifecycle,
              selection: selectionForStack(stack),
              stack,
              stacks,
              identityMarkerCreated: plan.identityMarkerCreated,
            }),
          );

        /**
         * The read-only answer: whatever identity and stacks already exist, and a
         * verdict about the named stack. Nothing here writes, so a workspace that
         * has never been started reports an absent identity rather than acquiring
         * one.
         */
        const reportResolution = (
          plan: ResolvedWorkspacePlan,
          stackName: string,
        ): Effect.Effect<ManagedStackResolution> =>
          Effect.gen(function* () {
            const { projectId, checkoutId, contextId } = plan.identity;
            const stacks =
              projectId === undefined || checkoutId === undefined || contextId === undefined
                ? []
                : yield* contextStacks({ projectId, checkoutId, contextId });
            const stack = stacks.find((candidate) => candidate.name === stackName);
            return {
              operation: "status",
              outcome: "report",
              workspace: plan.workspace,
              context: plan.context,
              identity: plan.identity,
              stackName,
              state: stack?.lifecycle ?? "unregistered",
              selection: stack === undefined ? undefined : selectionForStack(stack),
              stack,
              stacks,
              identityMarkerCreated: false,
            };
          });

        /**
         * The stack name is validated before anything else runs, so an invalid one
         * refuses without having classified a workspace, claimed an identity, or
         * created a directory.
         */
        function resolveStack(
          resolveOptions: ResolveManagedStackOptions & { readonly operation: "start" },
        ): Effect.Effect<StartedManagedStackResolution, ResolveManagedStackFailure>;
        function resolveStack(
          resolveOptions: ResolveManagedStackOptions,
        ): Effect.Effect<ManagedStackResolution, ResolveManagedStackFailure>;
        function resolveStack(
          resolveOptions: ResolveManagedStackOptions,
        ): Effect.Effect<ManagedStackResolution, ResolveManagedStackFailure> {
          return Effect.gen(function* () {
            const stackName = resolveOptions.stackName ?? DEFAULT_MANAGED_STACK_NAME;
            if (!stackNamePattern.test(stackName)) {
              return yield* Effect.fail(new InvalidManagedStackNameError({ stackName }));
            }
            const report = yield* workspaceIdentity.discover(resolveOptions.workspacePath);
            const settledReport =
              resolveOptions.operation === "start"
                ? yield* workspaceIdentity.discover(resolveOptions.workspacePath)
                : report;
            const sameWorkspaceTopology = workspaceIdentity.sameManagedWorkspaceTopology(
              report,
              settledReport,
            );
            const settledIdentityIsMonotonic = workspaceIdentity.identityPublicationIsMonotonic(
              report,
              settledReport,
            );
            const settledIdentityPublished =
              settledReport.identity.projectId !== undefined &&
              settledReport.identity.checkoutId !== undefined &&
              settledReport.identity.contextId !== undefined;
            const benignConcurrentRegistration =
              report.state === "unregistered" &&
              sameWorkspaceTopology &&
              settledIdentityIsMonotonic &&
              settledReport.activeTransition === undefined &&
              ((settledReport.state === "healthy" &&
                settledIdentityPublished &&
                settledReport.conflicts.length === 0) ||
                workspaceIdentity.concurrentIdentityPublication(report, settledReport));
            if (
              resolveOptions.operation === "start" &&
              discoveryObservation(report) !== discoveryObservation(settledReport) &&
              !benignConcurrentRegistration
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed workspace changed during discovery; rediscovery is required",
                }),
              );
            }
            let recoveryReportForStart = settledReport;
            if (
              resolveOptions.operation === "start" &&
              (settledReport.folderToGitClaims.length > 0 ||
                (settledReport.state === "transitioning" &&
                  settledReport.activeTransition?.kind === "folder-to-git"))
            ) {
              recoveryReportForStart = yield* workspaceIdentity.migrateFolderToGit(settledReport);
            }
            if (resolveOptions.operation === "start" && settledReport.state === "moved") {
              recoveryReportForStart = yield* workspaceIdentity.rebindCheckout({
                workspacePath: resolveOptions.workspacePath,
                checkoutId: settledReport.identity.checkoutId,
                observation: settledReport,
              });
            }
            if (
              resolveOptions.operation === "start" &&
              (((settledReport.state === "adoptable" || settledReport.state === "orphaned") &&
                settledReport.recoveryOperations.some(
                  (operation) => operation.operation === "adoptContext",
                )) ||
                (settledReport.state === "transitioning" &&
                  settledReport.activeTransition?.kind === "adopt-context"))
            ) {
              recoveryReportForStart = yield* workspaceIdentity.adoptContext({
                workspacePath: resolveOptions.workspacePath,
                observation: settledReport,
              });
            }
            if (
              resolveOptions.operation === "start" &&
              ((recoveryReportForStart.state === "duplicate" &&
                workspaceIdentity.branchCopyIsUnambiguous(recoveryReportForStart)) ||
                (recoveryReportForStart.state === "transitioning" &&
                  recoveryReportForStart.activeTransition?.kind === "branch-copy"))
            ) {
              recoveryReportForStart =
                yield* workspaceIdentity.repairCopiedBranch(recoveryReportForStart);
            }
            const plan: ResolvedWorkspacePlan = {
              workspace: recoveryReportForStart.workspace,
              context: recoveryReportForStart.context,
              contextDescriptor: recoveryReportForStart.contextDescriptor,
              identity:
                resolveOptions.operation === "status" &&
                recoveryReportForStart.registryContextId !== undefined
                  ? {
                      ...recoveryReportForStart.identity,
                      contextId: recoveryReportForStart.registryContextId,
                    }
                  : recoveryReportForStart.identity,
              identityMarkerCreated: false,
            };
            if (
              resolveOptions.operation === "start" &&
              recoveryReportForStart.inaccessiblePaths !== undefined &&
              recoveryReportForStart.inaccessiblePaths.length > 0
            ) {
              return yield* Effect.fail(
                new ManagedInaccessiblePathError({
                  path: recoveryReportForStart.inaccessiblePaths[0] ?? resolveOptions.workspacePath,
                }),
              );
            }
            if (resolveOptions.operation === "status") {
              return yield* reportResolution(plan, stackName);
            }
            if (
              recoveryReportForStart.state === "duplicate" &&
              recoveryReportForStart.identity.checkoutId !== undefined
            ) {
              return yield* Effect.fail(
                new ManagedCheckoutConflictError({
                  checkoutId: recoveryReportForStart.identity.checkoutId,
                  canonicalPath: recoveryReportForStart.workspace.workspaceRoot,
                }),
              );
            }
            const settledPlan =
              recoveryReportForStart.state === "unregistered"
                ? yield* workspaceIdentity.claimUnregisteredWorkspace(recoveryReportForStart)
                : recoveryReportForStart.state === "healthy"
                  ? plan
                  : yield* Effect.fail(
                      new InvalidManagedIdentityError({
                        message: `Managed workspace ${recoveryReportForStart.workspace.canonicalPath} is ${recoveryReportForStart.state}`,
                      }),
                    );
            const registrationInput: RegisterManagedStackInput = {
              identity: yield* requireResolvedIdentity(settledPlan),
              checkoutKind: settledPlan.workspace.checkoutKind,
              checkoutRootPath: settledPlan.workspace.workspaceRoot,
              context: settledPlan.contextDescriptor,
              stackName,
              configuration: resolveOptions.configuration,
              initialize: resolveOptions.initialize,
              validate: resolveOptions.validate,
            };
            const registered: RegisterManagedStackResult =
              yield* stackLifecycle.registerStack(registrationInput);
            return yield* startedResolution(
              settledPlan,
              registered.outcome,
              yield* requireProjection(registered.stack),
            );
          });
        }

        return {
          stateRoot,
          discoverWorkspace: workspaceIdentity.discover,
          newCheckout: workspaceIdentity.newCheckout,
          rebindCheckout: workspaceIdentity.rebindCheckout,
          adoptContext: workspaceIdentity.adoptContext,
          abandonIdentityTransition: workspaceIdentity.abandonIdentityTransition,
          resolveStack,
          inspectStack: stackLifecycle.inspectStack,
          listStacks: stackLifecycle.listStacks,
          updateStack: stackLifecycle.updateStack,
          deleteStack: stackLifecycle.deleteStack,
          reconcileAbandonedOperations: stackLifecycle.reconcileAbandonedOperations,
          prune: stackLifecycle.prune,
        };
      }),
    );
  }
}
