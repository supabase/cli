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
  ManagedRuntimeStartError,
  ManagedLegacyPortConflictError,
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
  type ManagedPortDrift,
  type ManagedPortIntentDocument,
  type ManagedRuntimeMetadata,
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
import { benignConcurrentRegistration } from "./workspace-settlement.ts";
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
import { ManagedPortCoordinator } from "./port-coordinator.ts";
import type { ManagedPortStartFailure } from "./port-coordinator.ts";
import { resolvePortIntents } from "./port-intent.ts";
import type { ConfigPortKey } from "../PortCatalog.ts";
import type { ManagedRuntimePortAllocation } from "./stack-lifecycle.ts";
export type { ManagedRuntimePortAllocation } from "./stack-lifecycle.ts";

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

type ManagedStackResolveConfiguration = Omit<ManagedStackConfiguration, "ports">;

interface ResolveManagedStackBaseOptions {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
  readonly legacyPortConflict?: {
    readonly key: ConfigPortKey;
    readonly port: number;
    readonly ownerId?: string;
  };
  readonly configuration?: ManagedStackResolveConfiguration;
}

export interface ResolveManagedStackStatusOptions extends ResolveManagedStackBaseOptions {
  readonly operation: "status";
  readonly initialize?: never;
}

export interface ResolveManagedStackStartOptions extends ResolveManagedStackBaseOptions {
  readonly operation: "start";
  /**
   * Provisioning steps a caller owns. A runtime failure is wrapped as a typed
   * {@link ManagedRuntimeStartError} after the accepted durable assignment has
   * been settled as a failed stack.
   */
  readonly initialize: (
    stack: ManagedStackRecord,
    allocation: ManagedRuntimePortAllocation,
  ) => Effect.Effect<ManagedRuntimeMetadata, ManagedRuntimeStartError>;
  readonly validate?: (stack: ManagedStackRecord) => Effect.Effect<void, unknown>;
}

export type ResolveManagedStackOptions =
  | ResolveManagedStackStartOptions
  | ResolveManagedStackStatusOptions;

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
  readonly portDrift: ReadonlyArray<ManagedPortDrift>;
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
  | ManagedRuntimeStartError
  | ManagedLegacyPortConflictError
  | ManagedPortStartFailure
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
      options: ResolveManagedStackStartOptions,
    ): Effect.Effect<StartedManagedStackResolution, ResolveManagedStackFailure>;
    (
      options: ResolveManagedStackStatusOptions,
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
          portCoordinator: ManagedPortCoordinator.make({ repository }),
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

        const portDriftFor = (
          stack: ManagedStackRecord,
          portDocument: ManagedPortIntentDocument,
        ): ReadonlyArray<ManagedPortDrift> => {
          const configured = new Map(
            resolvePortIntents(portDocument).map((request) => [request.key, request]),
          );
          return stack.ports.flatMap((assignment) => {
            const request = configured.get(assignment.key);
            const configuredIntent = request?.intent ?? "automatic";
            const configuredPort = request?.intent === "exact" ? request.port : undefined;
            return assignment.intent !== configuredIntent ||
              (configuredIntent === "exact" && assignment.port !== configuredPort)
              ? [
                  {
                    key: assignment.key,
                    actualIntent: assignment.intent,
                    actualPort: assignment.port,
                    configuredIntent,
                    ...(configuredPort === undefined ? {} : { configuredPort }),
                  },
                ]
              : [];
          });
        };

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
          portDocument: ManagedPortIntentDocument,
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
              portDrift: portDriftFor(stack, portDocument),
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
          portDocument: ManagedPortIntentDocument,
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
              portDrift: stack === undefined ? [] : portDriftFor(stack, portDocument),
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
            if (resolveOptions.legacyPortConflict !== undefined) {
              return yield* Effect.fail(
                new ManagedLegacyPortConflictError(resolveOptions.legacyPortConflict),
              );
            }
            const portDocument = resolveOptions.portDocument;
            const report = yield* workspaceIdentity.discover(resolveOptions.workspacePath);
            const settledReport =
              resolveOptions.operation === "start"
                ? yield* workspaceIdentity.discover(resolveOptions.workspacePath)
                : report;
            if (
              resolveOptions.operation === "start" &&
              discoveryObservation(report) !== discoveryObservation(settledReport) &&
              !benignConcurrentRegistration(report, settledReport)
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed workspace changed during discovery; rediscovery is required",
                }),
              );
            }
            if (resolveOptions.operation === "start") {
              const stableIdentityCandidate = {
                ...settledReport.identity,
                ...(settledReport.registryContextId === undefined
                  ? {}
                  : { contextId: settledReport.registryContextId }),
              };
              if (
                stableIdentityCandidate.projectId !== undefined &&
                stableIdentityCandidate.checkoutId !== undefined &&
                stableIdentityCandidate.contextId !== undefined
              ) {
                const stableIdentity: ManagedIdentityTriple = {
                  projectId: stableIdentityCandidate.projectId,
                  checkoutId: stableIdentityCandidate.checkoutId,
                  contextId: stableIdentityCandidate.contextId,
                };
                const stablePlan: ResolvedWorkspacePlan = {
                  workspace: settledReport.workspace,
                  context: settledReport.context,
                  contextDescriptor: settledReport.contextDescriptor,
                  identity: stableIdentity,
                  identityMarkerCreated: false,
                };
                const existingStableStack = (yield* contextStacks(stableIdentity)).find(
                  (candidate) => candidate.name === stackName,
                );
                if (
                  existingStableStack?.lifecycle === "running" &&
                  settledReport.state !== "transitioning" &&
                  (settledReport.state !== "duplicate" ||
                    workspaceIdentity.branchCopyIsUnambiguous(settledReport)) &&
                  settledReport.state !== "ambiguous"
                ) {
                  return yield* startedResolution(
                    stablePlan,
                    "reuse",
                    existingStableStack,
                    portDocument,
                  );
                }
              }
            }
            let recoveryReportForStart = settledReport;
            let identityMarkerCreated = false;
            if (resolveOptions.operation === "start") {
              const automaticRecoveryKind = (
                candidate: ManagedWorkspaceDiscovery,
              ):
                | "folder-to-git"
                | "rebind-checkout"
                | "adopt-context"
                | "branch-copy"
                | undefined => {
                if (
                  candidate.folderToGitClaims.length > 0 ||
                  (candidate.state === "transitioning" &&
                    candidate.activeTransition?.kind === "folder-to-git")
                ) {
                  return "folder-to-git";
                }
                if (
                  candidate.state === "moved" ||
                  (candidate.state === "transitioning" &&
                    candidate.activeTransition?.kind === "rebind-checkout")
                ) {
                  return "rebind-checkout";
                }
                if (
                  ((candidate.state === "adoptable" || candidate.state === "orphaned") &&
                    candidate.recoveryOperations.some(
                      (operation) => operation.operation === "adoptContext",
                    )) ||
                  (candidate.state === "transitioning" &&
                    candidate.activeTransition?.kind === "adopt-context")
                ) {
                  return "adopt-context";
                }
                if (
                  (candidate.state === "duplicate" &&
                    workspaceIdentity.branchCopyIsUnambiguous(candidate)) ||
                  (candidate.state === "transitioning" &&
                    candidate.activeTransition?.kind === "branch-copy")
                ) {
                  return "branch-copy";
                }
                return undefined;
              };
              const maxRecoveryIterations = 8;
              let iteration = 0;
              while (true) {
                const kind = automaticRecoveryKind(recoveryReportForStart);
                if (kind === undefined) break;
                if (iteration >= maxRecoveryIterations) {
                  return yield* Effect.fail(
                    new InvalidManagedIdentityError({
                      message: "Managed workspace recovery did not converge",
                    }),
                  );
                }
                const before = discoveryObservation(recoveryReportForStart);
                if (kind === "folder-to-git") {
                  const migrated =
                    yield* workspaceIdentity.migrateFolderToGit(recoveryReportForStart);
                  recoveryReportForStart = migrated.report;
                  identityMarkerCreated ||= migrated.identityMarkerCreated;
                } else if (kind === "rebind-checkout") {
                  recoveryReportForStart = yield* workspaceIdentity.rebindCheckout({
                    workspacePath: resolveOptions.workspacePath,
                    checkoutId: recoveryReportForStart.identity.checkoutId,
                    observation: recoveryReportForStart,
                  });
                } else if (kind === "adopt-context") {
                  recoveryReportForStart = yield* workspaceIdentity.adoptContext({
                    workspacePath: resolveOptions.workspacePath,
                    observation: recoveryReportForStart,
                  });
                } else {
                  recoveryReportForStart =
                    yield* workspaceIdentity.repairCopiedBranch(recoveryReportForStart);
                }
                iteration += 1;
                if (before === discoveryObservation(recoveryReportForStart)) {
                  return yield* Effect.fail(
                    new InvalidManagedIdentityError({
                      message: "Managed workspace recovery made no progress",
                    }),
                  );
                }
              }
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
              identityMarkerCreated,
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
              return yield* reportResolution(plan, stackName, portDocument);
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
            const firstStartResolution =
              recoveryReportForStart.state === "unregistered" ||
              (recoveryReportForStart.state === "transitioning" &&
                recoveryReportForStart.activeTransition?.kind === "new-checkout")
                ? yield* workspaceIdentity.claimFirstStart(recoveryReportForStart)
                : recoveryReportForStart.state === "healthy"
                  ? { plan, transition: undefined }
                  : yield* Effect.fail(
                      new InvalidManagedIdentityError({
                        message: `Managed workspace ${recoveryReportForStart.workspace.canonicalPath} is ${recoveryReportForStart.state}`,
                      }),
                    );
            const settledPlan = firstStartResolution.plan;
            const firstStartTransition = firstStartResolution.transition;
            const settledIdentity = yield* requireResolvedIdentity(settledPlan);
            const existingStack = (yield* contextStacks(settledIdentity)).find(
              (candidate) => candidate.name === stackName,
            );
            if (existingStack?.lifecycle === "running") {
              if (firstStartTransition !== undefined) {
                yield* workspaceIdentity.finalizeFirstStart(firstStartTransition);
              }
              return yield* startedResolution(settledPlan, "reuse", existingStack, portDocument);
            }
            const registrationInput: RegisterManagedStackInput = {
              identity: settledIdentity,
              checkoutKind: settledPlan.workspace.checkoutKind,
              checkoutRootPath: settledPlan.workspace.workspaceRoot,
              context: settledPlan.contextDescriptor,
              stackName,
              configuration: resolveOptions.configuration,
              portDocument,
              legacyPortConflict: resolveOptions.legacyPortConflict,
              initialize: resolveOptions.initialize,
              validate: resolveOptions.validate,
            };
            const registered: RegisterManagedStackResult =
              yield* stackLifecycle.registerStack(registrationInput);
            if (firstStartTransition !== undefined) {
              yield* workspaceIdentity.finalizeFirstStart(firstStartTransition);
            }
            return yield* startedResolution(
              settledPlan,
              registered.outcome,
              yield* requireProjection(registered.stack),
              portDocument,
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
