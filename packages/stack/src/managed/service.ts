import { randomUUID } from "node:crypto";
import { Context, Effect, FileSystem, Layer } from "effect";
import {
  DEFAULT_MANAGED_STACK_NAME,
  DuplicateManagedIdentityError,
  ManagedCopiedBranchConflictError,
  InvalidManagedIdentityError,
  ManagedCheckoutConflictError,
  ManagedIdentityTransitionOwnershipError,
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
  type ManagedCheckoutKind,
  type ManagedContextDescriptor,
  type ManagedContextKind,
  type ManagedIdentityTriple,
  type ManagedIdentityTransitionRecord,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackProjection,
  type ManagedStackRecord,
  type ManagedStackSelection,
} from "./model.ts";
import {
  ensureOrdinaryWorkspaceIdentity,
  publishGitCheckoutIdentity,
  publishOrdinaryWorkspaceIdentity,
} from "./identity.ts";
import {
  ensureBranchContextId,
  ensureGitCheckoutIdentity,
  GIT_PROJECT_ID_KEY,
  GitConfigStore,
  gitBranchContextIdKey,
  inspectWorkspace,
  replaceBranchContextId,
  readBranchContextId,
  readGitCheckoutIdentityWithFileSystem,
  type GitCheckoutInspection,
} from "./git.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import {
  ordinaryWorkspaceIdentityPath,
  gitConfigPath,
  requireExplicitManagedStateRoot,
} from "./paths.ts";
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
import { discoverWorkspace, type ManagedWorkspaceDiscovery } from "./discovery.ts";
import {
  NEW_CHECKOUT_DETACHED_TOPOLOGY,
  NEW_CHECKOUT_ORDINARY_TOPOLOGY,
  checkoutKindOf,
  newCheckoutTopologyMatches,
} from "./topology.ts";
import { discoveryObservation } from "./discovery-observation.ts";
import {
  makeStackLifecycle,
  type DeleteManagedStackFailure as LifecycleDeleteManagedStackFailure,
  type DeleteManagedStackResult as LifecycleDeleteManagedStackResult,
  type ManagedOperationRecoveryFailure as LifecycleManagedOperationRecoveryFailure,
  type ManagedPruneFailure as LifecycleManagedPruneFailure,
  type ManagedPruneRequest as LifecycleManagedPruneRequest,
  type ManagedPruneResult as LifecycleManagedPruneResult,
  type ReconcileAbandonedOperationsOptions as LifecycleReconcileAbandonedOperationsOptions,
  type ReconcileAbandonedOperationsResult as LifecycleReconcileAbandonedOperationsResult,
  type RetainedManagedOperation as LifecycleRetainedManagedOperation,
  type RegisterManagedStackFailure,
  type RegisterManagedStackInput,
  type RegisterManagedStackResult,
  type UpdateManagedStackConfigurationFailure as LifecycleUpdateManagedStackConfigurationFailure,
} from "./stack-lifecycle.ts";

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

/** A read observation consumed by an explicit checkout recovery operation. */
export interface ManagedCheckoutRecoveryRequest {
  /** The workspace to recover. `path` is accepted as the recovery-operation spelling. */
  readonly workspacePath?: string;
  readonly path?: string;
  /** Expected checkout identity; omitted to use the discovered marker. */
  readonly checkoutId?: string;
  /** Expected branch/context for explicit context adoption or branch repair. */
  readonly branch?: string;
  readonly contextId?: string;
  /** A discovery report obtained immediately before requesting recovery. */
  readonly observation?: ManagedWorkspaceDiscovery;
}

export interface ManagedIdentityTransitionAbandonRequest {
  readonly transitionId: string;
  readonly workspacePath?: string;
  readonly path?: string;
  readonly observation?: ManagedWorkspaceDiscovery;
}

/** Explicit metadata records selected for safe, non-destructive pruning. */
export type ManagedPruneRequest = LifecycleManagedPruneRequest;

/** The repository policy result for a metadata-only prune request. */
export type ManagedPruneResult = LifecycleManagedPruneResult;

export type ManagedPruneFailure = LifecycleManagedPruneFailure;

/** What the workspace turned out to be, and where its identities are kept. */
export interface ResolvedManagedWorkspace {
  readonly checkoutKind: ManagedCheckoutKind;
  readonly canonicalPath: string;
  /** The checkout's top-level directory; the canonical path for a folder. */
  readonly workspaceRoot: string;
  /**
   * Where the project identity lives: the common git directory of a repository,
   * or the identity marker of an ordinary folder.
   */
  readonly projectIdentityLocation: string;
  /** Where this checkout's own identity lives, under the same rule. */
  readonly checkoutIdentityLocation: string;
}

export interface ResolvedManagedContext {
  readonly kind: ManagedContextKind;
  /** The branch a branch context was resolved under. */
  readonly branch?: string;
  /** The commit a detached `HEAD` is parked on; never part of the identity. */
  readonly commit?: string;
}

/**
 * The identity triple, with each part absent until something has claimed it. A
 * `status` resolve of a workspace nothing has ever started reports all three as
 * absent, because claiming one would be a write.
 */
export interface ResolvedManagedIdentity {
  readonly projectId?: string;
  readonly checkoutId?: string;
  readonly contextId?: string;
}

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
  | RegisterManagedStackFailure
  | UnsupportedGitWorkspaceError
  | UpdateManagedStackConfigurationFailure;

export type DeleteManagedStackFailure = LifecycleDeleteManagedStackFailure;

export interface ManagedStackServiceShape {
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
  readonly inspectStack: (stackId: string) => Effect.Effect<ManagedStackProjection | undefined>;
  readonly listStacks: (options?: {
    readonly includeTombstoned?: boolean;
  }) => Effect.Effect<ReadonlyArray<ManagedStackProjection>>;
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
  readonly prune: (
    request: ManagedPruneRequest,
  ) => Effect.Effect<ManagedPruneResult, ManagedPruneFailure>;
}

const selectionForStack = (stack: ManagedStackRecord): ManagedStackSelection => ({
  projectId: stack.projectId,
  checkoutId: stack.checkoutId,
  contextId: stack.contextId,
  stackId: stack.id,
  stackName: stack.name,
});

const observationMatches = (
  report: ManagedWorkspaceDiscovery,
  inspection:
    | GitCheckoutInspection
    | { readonly kind: "ordinary-folder"; readonly canonicalPath: string },
): boolean => {
  if (inspection.kind === "ordinary-folder") {
    return (
      report.workspace.checkoutKind === "ordinary" &&
      report.workspace.workspaceRoot === inspection.canonicalPath
    );
  }
  const branch = inspection.head.kind === "detached" ? undefined : inspection.head.branch;
  const commit = inspection.head.kind === "detached" ? inspection.head.commit : undefined;
  return (
    report.workspace.workspaceRoot === inspection.workspaceRoot &&
    report.workspace.projectIdentityLocation === inspection.commonDirectory &&
    report.workspace.checkoutIdentityLocation === inspection.gitDirectory &&
    report.context.branch === branch &&
    report.context.commit === commit
  );
};

const sameManagedWorkspaceTopology = (
  report: ManagedWorkspaceDiscovery,
  freshReport: ManagedWorkspaceDiscovery,
): boolean =>
  report.workspace.checkoutKind === freshReport.workspace.checkoutKind &&
  report.workspace.workspaceRoot === freshReport.workspace.workspaceRoot &&
  report.workspace.projectIdentityLocation === freshReport.workspace.projectIdentityLocation &&
  report.workspace.checkoutIdentityLocation === freshReport.workspace.checkoutIdentityLocation &&
  report.context.kind === freshReport.context.kind &&
  report.context.branch === freshReport.context.branch &&
  report.context.commit === freshReport.context.commit;

const identityPublicationIsMonotonic = (
  report: ManagedWorkspaceDiscovery,
  freshReport: ManagedWorkspaceDiscovery,
): boolean =>
  (report.identity.projectId === undefined ||
    report.identity.projectId === freshReport.identity.projectId) &&
  (report.identity.checkoutId === undefined ||
    report.identity.checkoutId === freshReport.identity.checkoutId) &&
  (report.identity.contextId === undefined ||
    report.identity.contextId === freshReport.identity.contextId);

const identityPublicationAdvanced = (
  report: ManagedWorkspaceDiscovery,
  freshReport: ManagedWorkspaceDiscovery,
): boolean =>
  (report.identity.projectId === undefined && freshReport.identity.projectId !== undefined) ||
  (report.identity.checkoutId === undefined && freshReport.identity.checkoutId !== undefined) ||
  (report.identity.contextId === undefined && freshReport.identity.contextId !== undefined);

/** A same-topology start may have published part of the Git identity meanwhile. */
const concurrentIdentityPublication = (
  report: ManagedWorkspaceDiscovery,
  freshReport: ManagedWorkspaceDiscovery,
): boolean =>
  report.state === "unregistered" &&
  freshReport.state === "unregistered" &&
  freshReport.conflicts.length === 0 &&
  freshReport.activeTransition === undefined &&
  sameManagedWorkspaceTopology(report, freshReport) &&
  identityPublicationIsMonotonic(report, freshReport) &&
  identityPublicationAdvanced(report, freshReport);

/**
 * What a workspace resolved to before any stack is looked up: where the
 * identities live, which context the working tree is in, and whichever parts of
 * the identity triple exist at this point.
 */
interface ResolvedWorkspace {
  readonly workspace: ResolvedManagedWorkspace;
  readonly context: ResolvedManagedContext;
  readonly contextDescriptor: ManagedContextDescriptor;
  readonly identity: ResolvedManagedIdentity;
  readonly identityMarkerCreated: boolean;
}

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
 * The managed registry's policy layer: workspace classification, identity
 * ownership, provisioning order, publication waiting, deletion, and recovery of
 * abandoned operations.
 *
 * Every isolation rule the managed surface has lives here rather than in the
 * registry or in a caller: which checkout a path belongs to, which context a
 * `HEAD` names, and what a stack name is scoped by. The registry stores those
 * decisions and enforces their uniqueness; it never makes them.
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

        /**
         * The branch context of a checkout whose `HEAD` names one.
         *
         * Git owns this identity: it lives in the shared repository config, so
         * every worktree on the branch resolves the same context, and `git branch
         * -m` or a branch deletion takes it along. A read-only resolve reports the
         * absence of one rather than claiming it.
         */
        const detachedContextId = (
          checkoutId: string,
        ): Effect.Effect<string, InvalidManagedIdentityError> =>
          Effect.gen(function* () {
            const existing = yield* repository.findCheckoutContext(checkoutId, "detached");
            if (existing !== undefined) {
              return existing.id;
            }
            return yield* managedUuid("contextId");
          });

        /**
         * Classifies the workspace and resolves the identity around it, claiming
         * what is missing only when the operation is allowed to write.
         *
         * Both operations take this one path, which is what makes a `status` and
         * the `start` after it agree: they read the same git topology, derive the
         * same context from the same `HEAD`, and differ only in whether an absent
         * identity is minted or reported.
         */
        const claimUnregisteredWorkspace = (
          report: ManagedWorkspaceDiscovery,
          targetIdentity?: ManagedIdentityTriple,
          transitionId = "identity-publication",
        ): Effect.Effect<
          ResolvedWorkspace,
          | InvalidManagedIdentityError
          | UnsupportedGitWorkspaceError
          | ManagedIdentityTransitionOwnershipError
        > =>
          Effect.gen(function* () {
            const canonicalPath = report.workspace.canonicalPath;
            const freshReport = yield* discover(canonicalPath);
            const sameWorkspaceTopology = sameManagedWorkspaceTopology(report, freshReport);
            const winnerPublished =
              report.state === "unregistered" &&
              freshReport.state === "healthy" &&
              freshReport.identity.projectId !== undefined &&
              freshReport.identity.checkoutId !== undefined &&
              freshReport.identity.contextId !== undefined &&
              freshReport.conflicts.length === 0 &&
              freshReport.activeTransition === undefined &&
              sameWorkspaceTopology &&
              identityPublicationIsMonotonic(report, freshReport);
            if (
              discoveryObservation(report) !== discoveryObservation(freshReport) &&
              !winnerPublished &&
              !concurrentIdentityPublication(report, freshReport)
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message:
                    "Managed workspace changed before identity publication; rediscovery is required",
                }),
              );
            }
            if (winnerPublished) {
              return {
                workspace: freshReport.workspace,
                context: freshReport.context,
                contextDescriptor: freshReport.contextDescriptor,
                identity: freshReport.identity,
                identityMarkerCreated: false,
              };
            }
            if (
              targetIdentity !== undefined &&
              ((freshReport.identity.projectId !== undefined &&
                freshReport.identity.projectId !== targetIdentity.projectId) ||
                (freshReport.identity.checkoutId !== undefined &&
                  freshReport.identity.checkoutId !== targetIdentity.checkoutId) ||
                (freshReport.identity.contextId !== undefined &&
                  freshReport.identity.contextId !== targetIdentity.contextId))
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId }),
              );
            }
            if (
              targetIdentity !== undefined &&
              freshReport.identity.projectId === targetIdentity.projectId &&
              freshReport.identity.checkoutId === targetIdentity.checkoutId &&
              freshReport.identity.contextId === targetIdentity.contextId
            ) {
              return {
                workspace: freshReport.workspace,
                context: freshReport.context,
                contextDescriptor: freshReport.contextDescriptor,
                identity: targetIdentity,
                identityMarkerCreated: false,
              };
            }
            const inspection = yield* withWorkspaceServices(inspectWorkspace(canonicalPath));
            if (!observationMatches(freshReport, inspection)) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed workspace changed after discovery; rediscovery is required",
                }),
              );
            }

            if (inspection.kind === "ordinary-folder") {
              const markerPath = ordinaryWorkspaceIdentityPath(canonicalPath);
              const marker =
                targetIdentity === undefined
                  ? yield* ensureOrdinaryWorkspaceIdentity(canonicalPath, idFactory)
                  : yield* publishOrdinaryWorkspaceIdentity(
                      canonicalPath,
                      targetIdentity,
                      yield* managedUuid("identity temporary id"),
                    );
              const identity = marker.identity;
              const ownedContext =
                identity?.checkoutId === undefined
                  ? undefined
                  : yield* repository.findCheckoutContext(identity.checkoutId, "workspace");
              return {
                // A folder keeps all three identities in one marker, so that
                // marker is both identity locations.
                workspace: {
                  checkoutKind: "ordinary",
                  canonicalPath,
                  workspaceRoot: canonicalPath,
                  projectIdentityLocation: markerPath,
                  checkoutIdentityLocation: markerPath,
                },
                context: { kind: "workspace" },
                contextDescriptor: { kind: "workspace" },
                identity: {
                  projectId: identity?.projectId,
                  checkoutId: identity?.checkoutId,
                  contextId: ownedContext?.id ?? identity?.contextId,
                },
                identityMarkerCreated: marker?.created ?? false,
              };
            }

            if (targetIdentity !== undefined) {
              const targetTemporaryId = yield* managedUuid("git checkout identity temporary id");
              const exactConfig = (key: string, value: string) =>
                withWorkspaceServices(
                  Effect.gen(function* () {
                    const store = yield* GitConfigStore;
                    const file = gitConfigPath(inspection.commonDirectory);
                    const existing = yield* store.getAll(file, key);
                    if (existing.length === 0) yield* store.add(file, key, value);
                    const winner = yield* store.getAll(file, key);
                    if (winner.length === 0 || winner.some((candidate) => candidate !== value)) {
                      return yield* Effect.fail(
                        new ManagedIdentityTransitionOwnershipError({
                          transitionId,
                        }),
                      );
                    }
                  }),
                );
              yield* exactConfig(GIT_PROJECT_ID_KEY, targetIdentity.projectId);
              yield* withWorkspaceServices(
                publishGitCheckoutIdentity(
                  inspection.gitDirectory,
                  targetIdentity.checkoutId,
                  targetTemporaryId,
                ),
              );
              if (inspection.head.kind !== "detached") {
                yield* exactConfig(
                  gitBranchContextIdKey(inspection.head.branch),
                  targetIdentity.contextId,
                );
              }
              const head = inspection.head;
              return {
                workspace: {
                  checkoutKind: checkoutKindOf(inspection),
                  canonicalPath: inspection.canonicalPath,
                  workspaceRoot: inspection.workspaceRoot,
                  projectIdentityLocation: inspection.commonDirectory,
                  checkoutIdentityLocation: inspection.gitDirectory,
                },
                context:
                  head.kind === "detached"
                    ? { kind: "detached", commit: head.commit }
                    : { kind: "branch", branch: head.branch },
                contextDescriptor:
                  head.kind === "detached"
                    ? { kind: "detached" }
                    : { kind: "branch", locator: head.branch },
                identity: targetIdentity,
                identityMarkerCreated: true,
              };
            }
            const claimed = yield* withWorkspaceServices(
              ensureGitCheckoutIdentity(inspection, idFactory),
            );
            const checkoutId = claimed.checkoutId;
            const head = inspection.head;
            return {
              workspace: {
                checkoutKind: checkoutKindOf(inspection),
                canonicalPath: inspection.canonicalPath,
                workspaceRoot: inspection.workspaceRoot,
                projectIdentityLocation: inspection.commonDirectory,
                checkoutIdentityLocation: inspection.gitDirectory,
              },
              // An unborn branch names a context exactly as a born one does: it is
              // the state a fresh repository starts in, and a first start there
              // must not be treated as a detached `HEAD`.
              context:
                head.kind === "detached"
                  ? { kind: "detached", commit: head.commit }
                  : { kind: "branch", branch: head.branch },
              contextDescriptor:
                head.kind === "detached"
                  ? { kind: "detached" }
                  : { kind: "branch", locator: head.branch },
              identity: {
                projectId: claimed.projectId,
                checkoutId,
                contextId:
                  head.kind === "detached"
                    ? yield* detachedContextId(checkoutId)
                    : yield* withWorkspaceServices(
                        ensureBranchContextId(inspection, head.branch, idFactory),
                      ),
              },
              identityMarkerCreated: claimed?.checkoutIdentityCreated ?? false,
            };
          });

        const discover = (workspacePath: string) =>
          withWorkspaceServices(
            discoverWorkspace(workspacePath).pipe(
              Effect.provideService(ManagedStackRepository, repository),
            ),
          );

        /**
         * Convert one exact ordinary-folder claim into Git-owned identity.
         * The ordinary marker is deliberately never rewritten or deleted: it
         * is historical evidence, while the registry claim and the Git files
         * are the authoritative winner. A reserved transition owns the whole
         * sequence, so an interrupted publication can only resume after every
         * expected value still matches.
         */
        const migrateFolderToGit = (
          report: ManagedWorkspaceDiscovery,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          | InvalidManagedIdentityError
          | DuplicateManagedIdentityError
          | UnsupportedGitWorkspaceError
          | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const resuming = report.activeTransition?.kind === "folder-to-git";
            if (!resuming) {
              if (report.folderToGitClaims.length === 0) return report;
              if (report.folderToGitClaims.length > 1) {
                return yield* Effect.fail(
                  new ManagedCheckoutConflictError({
                    checkoutId: report.folderToGitClaims[0]?.checkoutId ?? "unknown",
                    canonicalPath: report.workspace.workspaceRoot,
                  }),
                );
              }
              if (
                report.state !== "adoptable" ||
                report.conflicts.length > 0 ||
                report.identity.projectId !== undefined ||
                report.identity.checkoutId !== undefined ||
                report.identity.contextId !== undefined
              ) {
                return report;
              }
            }
            const claim =
              report.folderToGitClaims[0] ??
              (report.activeTransition?.projectId !== undefined &&
              report.activeTransition.checkoutId !== undefined &&
              report.activeTransition.contextId !== undefined &&
              report.activeTransition.path !== undefined
                ? {
                    projectId: report.activeTransition.projectId,
                    checkoutId: report.activeTransition.checkoutId,
                    contextId: report.activeTransition.contextId,
                    canonicalPath: report.activeTransition.path,
                  }
                : undefined);
            if (claim === undefined || report.workspace.checkoutKind === "ordinary") return report;
            const path = report.workspace.workspaceRoot;
            const inspection = yield* withWorkspaceServices(inspectWorkspace(path));
            if (inspection.kind !== "git-checkout") {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Folder-to-Git migration lost its Git workspace",
                }),
              );
            }
            const transition =
              report.activeTransition?.kind === "folder-to-git"
                ? report.activeTransition
                : yield* repository.reserveIdentityTransition({
                    id: yield* managedUuid("identity transition"),
                    kind: "folder-to-git",
                    projectId: claim.projectId,
                    checkoutId: claim.checkoutId,
                    contextId: claim.contextId,
                    branch: report.context.kind === "branch" ? report.context.branch : undefined,
                    path,
                    expectedGitValue: "absent",
                    targetGitValue: claim.contextId,
                    now: now(),
                  });
            if (
              transition.kind !== "folder-to-git" ||
              transition.projectId !== claim.projectId ||
              transition.checkoutId !== claim.checkoutId ||
              transition.contextId !== claim.contextId ||
              transition.path !== path ||
              transition.expectedGitValue !== "absent" ||
              transition.targetGitValue !== claim.contextId ||
              transition.branch !==
                (report.context.kind === "branch" ? report.context.branch : undefined)
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }

            if (transition.phase === "reserved") {
              const claimsAfterReserve = yield* repository.listIdentityClaims();
              const exactLocationClaims = claimsAfterReserve.locations.filter(
                (location) => location.state === "active" && location.canonicalPath === path,
              );
              const exactContext = claimsAfterReserve.contexts.find(
                (context) => context.id === claim.contextId,
              );
              if (
                exactLocationClaims.length !== 1 ||
                exactLocationClaims[0]?.checkoutId !== claim.checkoutId ||
                exactContext?.projectId !== claim.projectId ||
                exactContext.checkoutId !== claim.checkoutId ||
                exactContext.kind !== "workspace"
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
            }

            const gitIdentity = yield* withWorkspaceServices(
              readGitCheckoutIdentityWithFileSystem(inspection),
            );
            const branchContext =
              inspection.head.kind !== "detached"
                ? yield* withWorkspaceServices(
                    readBranchContextId(inspection, inspection.head.branch),
                  )
                : undefined;
            if (
              (gitIdentity.projectId !== undefined && gitIdentity.projectId !== claim.projectId) ||
              (gitIdentity.checkoutId !== undefined &&
                gitIdentity.checkoutId !== claim.checkoutId) ||
              (branchContext !== undefined && branchContext !== claim.contextId)
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            if (transition.phase === "reserved") {
              const config = gitConfigPath(inspection.commonDirectory);
              const publishConfig = (key: string, value: string) =>
                withWorkspaceServices(
                  Effect.gen(function* () {
                    const store = yield* GitConfigStore;
                    const values = yield* store.getAll(config, key);
                    if (values.length === 0) {
                      yield* store.add(config, key, value);
                      const winner = yield* store.getAll(config, key);
                      if (winner[0] !== value) {
                        return yield* Effect.fail(
                          new ManagedIdentityTransitionOwnershipError({
                            transitionId: transition.id,
                          }),
                        );
                      }
                    } else if (values[0] !== value) {
                      return yield* Effect.fail(
                        new ManagedIdentityTransitionOwnershipError({
                          transitionId: transition.id,
                        }),
                      );
                    }
                  }),
                );
              yield* publishConfig(GIT_PROJECT_ID_KEY, claim.projectId);
              yield* withWorkspaceServices(
                publishGitCheckoutIdentity(inspection.gitDirectory, claim.checkoutId),
              );
              if (inspection.head.kind !== "detached") {
                yield* publishConfig(
                  gitBranchContextIdKey(inspection.head.branch),
                  claim.contextId,
                );
              }
              const reread = yield* withWorkspaceServices(
                readGitCheckoutIdentityWithFileSystem(inspection),
              );
              const rereadBranch =
                inspection.head.kind !== "detached"
                  ? yield* withWorkspaceServices(
                      readBranchContextId(inspection, inspection.head.branch),
                    )
                  : undefined;
              if (
                reread.projectId !== claim.projectId ||
                reread.checkoutId !== claim.checkoutId ||
                (inspection.head.kind !== "detached" && rereadBranch !== claim.contextId)
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
              yield* repository.advanceIdentityTransition({
                id: transition.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: now(),
              });
            }

            if (inspection.head.kind !== "detached") {
              yield* repository.migrateContextToBranch({
                contextId: claim.contextId,
                projectId: claim.projectId,
                checkoutId: claim.checkoutId,
                branch: inspection.head.branch,
                now: now(),
              });
            } else {
              yield* repository.migrateContextToDetached({
                contextId: claim.contextId,
                projectId: claim.projectId,
                checkoutId: claim.checkoutId,
                now: now(),
              });
            }
            const requiredGitIdentity = yield* withWorkspaceServices(
              readGitCheckoutIdentityWithFileSystem(inspection),
            );
            const requiredBranchContext =
              inspection.head.kind !== "detached"
                ? yield* withWorkspaceServices(
                    readBranchContextId(inspection, inspection.head.branch),
                  )
                : undefined;
            if (
              requiredGitIdentity.projectId !== claim.projectId ||
              requiredGitIdentity.checkoutId !== claim.checkoutId ||
              (inspection.head.kind !== "detached" && requiredBranchContext !== claim.contextId)
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            yield* repository.registerCheckoutIdentity({
              identity: {
                projectId: claim.projectId,
                checkoutId: claim.checkoutId,
                contextId: claim.contextId,
              },
              checkoutKind: checkoutKindOf(inspection),
              checkoutRootPath: path,
              locationId: yield* managedUuid("checkout location"),
              context:
                inspection.head.kind !== "detached"
                  ? { kind: "branch", locator: inspection.head.branch }
                  : { kind: "detached" },
              now: now(),
            });
            const latest =
              (yield* repository.listIdentityClaims()).transitions.find(
                (candidate) => candidate.id === transition.id,
              ) ?? transition;
            if (latest.phase === "git-written") {
              yield* repository.finalizeIdentityTransition({
                id: latest.id,
                expectedPhase: "git-written",
                now: now(),
              });
            }
            const migrated = yield* discover(path);
            return migrated;
          });

        const requestedRecoveryPath = (
          options: Pick<ManagedCheckoutRecoveryRequest, "workspacePath" | "path">,
        ): Effect.Effect<string, InvalidManagedIdentityError> => {
          if (
            options.workspacePath !== undefined &&
            options.path !== undefined &&
            options.workspacePath !== options.path
          ) {
            return Effect.fail(
              new InvalidManagedIdentityError({
                message: "workspacePath and path must identify the same workspace",
              }),
            );
          }
          const path = options.workspacePath ?? options.path;
          return path === undefined || path.trim().length === 0
            ? Effect.fail(
                new InvalidManagedIdentityError({
                  message: "A workspace path is required for managed checkout recovery",
                }),
              )
            : Effect.succeed(path);
        };

        const recoveryReport = (
          options: ManagedCheckoutRecoveryRequest,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          InvalidManagedIdentityError | UnsupportedGitWorkspaceError
        > =>
          Effect.gen(function* () {
            const path = yield* requestedRecoveryPath(options);
            const current = yield* discover(path);
            if (
              options.observation !== undefined &&
              discoveryObservation(options.observation) !== discoveryObservation(current)
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed workspace changed after discovery; rediscovery is required",
                }),
              );
            }
            return current;
          });

        const reserveRecoveryTransition = (
          report: ManagedWorkspaceDiscovery,
          kind: "new-checkout" | "rebind-checkout",
          checkoutId: string | undefined,
          path: string,
        ): Effect.Effect<
          ManagedIdentityTransitionRecord,
          InvalidManagedIdentityError | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const existing = report.activeTransition;
            if (
              existing !== undefined &&
              existing.kind === kind &&
              existing.path === path &&
              existing.checkoutId === checkoutId
            ) {
              return existing;
            }
            const id = yield* managedUuid("identity transition");
            return yield* repository.reserveIdentityTransition({
              id,
              kind,
              projectId: report.identity.projectId,
              checkoutId,
              contextId: report.identity.contextId,
              path,
              now: now(),
            });
          });

        const finishRecoveryTransition = (
          transition: ManagedIdentityTransitionRecord,
          report: ManagedWorkspaceDiscovery,
          checkoutId: string,
          path: string,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          InvalidManagedIdentityError | ManagedIdentityRecoveryError | UnsupportedGitWorkspaceError
        > =>
          Effect.gen(function* () {
            const transitionTargetMatches =
              transition.path === path &&
              transition.kind !== "new-checkout" &&
              transition.checkoutId === checkoutId &&
              (transition.branch === undefined ||
                (report.context.kind === "branch" &&
                  report.context.branch === transition.branch)) &&
              (transition.projectId === undefined ||
                transition.projectId === report.identity.projectId) &&
              (transition.contextId === undefined ||
                transition.contextId === report.identity.contextId) &&
              (transition.expectedGitValue === undefined ||
                transition.expectedGitValue === report.identity.contextId) &&
              (transition.targetGitValue === undefined ||
                transition.targetGitValue === report.identity.contextId);
            if (!transitionTargetMatches) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            if (report.inaccessiblePaths !== undefined && report.inaccessiblePaths.length > 0) {
              return yield* Effect.fail(
                new ManagedInaccessiblePathError({ path: report.inaccessiblePaths[0] ?? path }),
              );
            }

            const rejectHistoricalRecoveryEvidence = (
              current: ManagedWorkspaceDiscovery,
            ): Effect.Effect<void, ManagedCheckoutConflictError | ManagedInaccessiblePathError> => {
              const inaccessible = current.inaccessiblePaths?.[0];
              if (inaccessible !== undefined) {
                return Effect.fail(new ManagedInaccessiblePathError({ path: inaccessible }));
              }
              const evidence = current.historicalPathEvidence?.find(
                (candidate) => candidate.probe !== "missing",
              );
              if (evidence !== undefined) {
                return Effect.fail(
                  new ManagedCheckoutConflictError({
                    checkoutId,
                    canonicalPath: evidence.path,
                    existingCheckoutId: checkoutId,
                  }),
                );
              }
              const blockedCurrent = current.locations.find(
                (location) => location.canonicalPath === path && location.state === "blocked",
              );
              const conflicting = current.conflictingLocations?.find(
                (location) => location.canonicalPath === path,
              );
              return blockedCurrent === undefined && conflicting === undefined
                ? Effect.void
                : Effect.fail(
                    new ManagedCheckoutConflictError({
                      checkoutId,
                      canonicalPath: path,
                      existingCheckoutId: conflicting?.checkoutId ?? checkoutId,
                    }),
                  );
            };

            const verifyMarker = (current: ManagedWorkspaceDiscovery) =>
              current.identity.checkoutId === checkoutId &&
              current.identity.projectId === report.identity.projectId &&
              current.identity.contextId === report.identity.contextId &&
              current.workspace.workspaceRoot === path;
            let current = yield* discover(path);
            yield* rejectHistoricalRecoveryEvidence(current);
            if (!verifyMarker(current)) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed checkout marker changed before registry recovery",
                }),
              );
            }

            let phase = transition.phase;
            if (phase === "reserved") {
              // Marker/config publication is verified before advancing the
              // transition. Registry rows are published only after this CAS.
              yield* repository.advanceIdentityTransition({
                id: transition.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: now(),
              });
              phase = "git-written";
              current = yield* discover(path);
              yield* rejectHistoricalRecoveryEvidence(current);
              if (!verifyMarker(current)) {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Managed checkout marker changed before registry recovery",
                  }),
                );
              }
            }

            if (phase === "git-written") {
              const active = current.locations.find(
                (location) =>
                  location.checkoutId === checkoutId &&
                  location.canonicalPath === path &&
                  location.state === "active",
              );
              if (active === undefined) {
                const decision = yield* repository.applyCheckoutLocation({
                  checkoutId,
                  locationId: yield* managedUuid("checkout location"),
                  canonicalPath: path,
                  now: now(),
                  expectedActiveLocationId: current.locations.find(
                    (location) => location.checkoutId === checkoutId && location.state === "active",
                  )?.id,
                });
                if (decision.outcome === "blocked") {
                  return yield* Effect.fail(
                    new ManagedCheckoutConflictError({
                      checkoutId,
                      canonicalPath: path,
                      existingCheckoutId: decision.location.checkoutId,
                    }),
                  );
                }
              }
              current = yield* discover(path);
              yield* rejectHistoricalRecoveryEvidence(current);
              if (!verifyMarker(current)) {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Managed checkout recovery preconditions no longer hold",
                  }),
                );
              }
              const activeAfter = current.locations.find(
                (location) =>
                  location.checkoutId === checkoutId &&
                  location.canonicalPath === path &&
                  location.state === "active",
              );
              if (activeAfter === undefined) {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Managed checkout recovery preconditions no longer hold",
                  }),
                );
              }
              yield* repository.finalizeIdentityTransition({
                id: transition.id,
                expectedPhase: "git-written",
                now: now(),
              });
            }
            return yield* discover(path);
          });

        const newCheckout = (
          options: ManagedCheckoutRecoveryRequest,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          | InvalidManagedIdentityError
          | DuplicateManagedIdentityError
          | UnsupportedGitWorkspaceError
          | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const report = yield* recoveryReport(options);
            const path = report.workspace.workspaceRoot;
            if (
              report.state !== "unregistered" &&
              !(
                report.state === "transitioning" &&
                report.activeTransition?.kind === "new-checkout" &&
                report.activeTransition.path === path
              )
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: `Managed workspace ${report.workspace.canonicalPath} is ${report.state}, not unregistered`,
                }),
              );
            }
            const transition =
              report.activeTransition?.kind === "new-checkout"
                ? report.activeTransition
                : yield* Effect.gen(function* () {
                    const targetIdentity: ManagedIdentityTriple = {
                      projectId: report.identity.projectId ?? (yield* managedUuid("projectId")),
                      checkoutId: report.identity.checkoutId ?? (yield* managedUuid("checkoutId")),
                      contextId: report.identity.contextId ?? (yield* managedUuid("contextId")),
                    };
                    return yield* repository.reserveIdentityTransition({
                      id: yield* managedUuid("identity transition"),
                      kind: "new-checkout",
                      ...targetIdentity,
                      branch: report.context.kind === "branch" ? report.context.branch : undefined,
                      path,
                      expectedGitValue:
                        report.context.kind === "workspace"
                          ? NEW_CHECKOUT_ORDINARY_TOPOLOGY
                          : report.context.kind === "detached"
                            ? NEW_CHECKOUT_DETACHED_TOPOLOGY
                            : report.identity.contextId,
                      targetGitValue: targetIdentity.contextId,
                      now: now(),
                    });
                  });
            if (
              transition.kind !== "new-checkout" ||
              transition.path !== path ||
              transition.projectId === undefined ||
              transition.checkoutId === undefined ||
              transition.contextId === undefined ||
              !newCheckoutTopologyMatches(transition, report.context)
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            const targetIdentity: ManagedIdentityTriple = {
              projectId: transition.projectId,
              checkoutId: transition.checkoutId,
              contextId: transition.contextId,
            };
            if (transition.phase === "reserved") {
              const beforePublication = yield* discover(path);
              const beforeClaims = yield* repository.listIdentityClaims();
              const reserved = beforeClaims.transitions.find(
                (candidate) => candidate.id === transition.id,
              );
              if (
                reserved === undefined ||
                reserved.phase !== "reserved" ||
                reserved.kind !== "new-checkout" ||
                reserved.path !== path ||
                !newCheckoutTopologyMatches(reserved, beforePublication.context) ||
                (beforePublication.identity.projectId !== undefined &&
                  beforePublication.identity.projectId !== targetIdentity.projectId) ||
                (beforePublication.identity.checkoutId !== undefined &&
                  beforePublication.identity.checkoutId !== targetIdentity.checkoutId) ||
                (beforePublication.identity.contextId !== undefined &&
                  beforePublication.identity.contextId !== targetIdentity.contextId)
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
              const claimed = yield* claimUnregisteredWorkspace(
                beforePublication,
                targetIdentity,
                transition.id,
              );
              const identity = yield* requireResolvedIdentity(claimed);
              if (
                identity.projectId !== targetIdentity.projectId ||
                identity.checkoutId !== targetIdentity.checkoutId ||
                identity.contextId !== targetIdentity.contextId
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
              const reread = yield* discover(path);
              if (
                reread.identity.projectId !== targetIdentity.projectId ||
                reread.identity.checkoutId !== targetIdentity.checkoutId ||
                (reread.context.kind !== "detached" &&
                  reread.identity.contextId !== targetIdentity.contextId)
              ) {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Managed checkout identity publication did not settle on the winner",
                  }),
                );
              }
              yield* repository.advanceIdentityTransition({
                id: transition.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: now(),
              });
            }
            const published = yield* discover(path);
            if (
              published.identity.projectId !== targetIdentity.projectId ||
              published.identity.checkoutId !== targetIdentity.checkoutId ||
              (published.context.kind !== "detached" &&
                published.identity.contextId !== targetIdentity.contextId)
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed checkout identity publication did not settle on the winner",
                }),
              );
            }
            const latestTransition =
              (yield* repository.listIdentityClaims()).transitions.find(
                (candidate) => candidate.id === transition.id,
              ) ?? transition;
            if (latestTransition.phase === "git-written") {
              yield* repository.registerCheckoutIdentity({
                identity: {
                  projectId: targetIdentity.projectId,
                  checkoutId: targetIdentity.checkoutId,
                  contextId: targetIdentity.contextId,
                },
                checkoutKind: published.workspace.checkoutKind,
                checkoutRootPath: published.workspace.workspaceRoot,
                locationId: yield* managedUuid("checkout location"),
                context: published.contextDescriptor,
                now: now(),
              });
              yield* repository.finalizeIdentityTransition({
                id: latestTransition.id,
                expectedPhase: "git-written",
                now: now(),
              });
            }
            return yield* discover(path);
          });

        const recoverCheckout = (
          operation: "rebind-checkout",
          options: ManagedCheckoutRecoveryRequest,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          InvalidManagedIdentityError | UnsupportedGitWorkspaceError | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const report = yield* recoveryReport(options);
            const path = report.workspace.workspaceRoot;
            const checkoutId = options.checkoutId ?? report.identity.checkoutId;
            if (checkoutId === undefined || report.identity.checkoutId !== checkoutId) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed checkout recovery requires the current checkout identity",
                }),
              );
            }
            if (report.state === "transitioning") {
              const transition = report.activeTransition;
              if (
                transition === undefined ||
                transition.kind !== operation ||
                transition.checkoutId !== checkoutId ||
                transition.path !== path ||
                (transition.projectId !== undefined &&
                  transition.projectId !== report.identity.projectId) ||
                (transition.contextId !== undefined &&
                  transition.contextId !== report.identity.contextId)
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({
                    transitionId: transition?.id ?? "unknown",
                  }),
                );
              }
              return yield* finishRecoveryTransition(transition, report, checkoutId, path);
            }
            if (report.inaccessiblePaths !== undefined && report.inaccessiblePaths.length > 0) {
              return yield* Effect.fail(
                new ManagedInaccessiblePathError({ path: report.inaccessiblePaths[0] ?? path }),
              );
            }
            const validState =
              operation === "rebind-checkout"
                ? report.state === "moved" || report.state === "healthy"
                : false;
            if (!validState) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: `Managed workspace ${report.workspace.canonicalPath} is ${report.state}; explicit checkout recovery is required`,
                }),
              );
            }
            const transition = yield* reserveRecoveryTransition(
              report,
              operation,
              checkoutId,
              path,
            );
            return yield* finishRecoveryTransition(transition, report, checkoutId, path);
          });

        const rebindCheckout = (options: ManagedCheckoutRecoveryRequest) =>
          recoverCheckout("rebind-checkout", options);

        const branchCopyIsUnambiguous = (report: ManagedWorkspaceDiscovery): boolean => {
          if (
            report.context.kind !== "branch" ||
            report.context.branch === undefined ||
            report.identity.projectId === undefined ||
            report.identity.checkoutId === undefined ||
            report.identity.contextId === undefined
          ) {
            return false;
          }
          const evidence = report.ownerEvidence;
          const owner = evidence?.authoritativeOwnerBranch;
          if (owner === undefined || owner === report.context.branch) return false;
          const liveClaims = evidence?.claims.filter((claim) => claim.live) ?? [];
          const activeLocations = report.locations.filter(
            (location) => location.state === "active",
          );
          return (
            liveClaims.length === 2 &&
            liveClaims.some((claim) => claim.branch === owner) &&
            liveClaims.some((claim) => claim.branch === report.context.branch) &&
            activeLocations.length === 1 &&
            activeLocations[0]?.checkoutId === report.identity.checkoutId &&
            activeLocations[0]?.canonicalPath === report.workspace.workspaceRoot &&
            report.conflicts.length === 1 &&
            report.recoveryOperations.length === 0 &&
            report.conflictingLocations === undefined &&
            report.inaccessiblePaths === undefined &&
            (report.historicalPathEvidence ?? []).every((evidence) => evidence.probe === "missing")
          );
        };

        /**
         * A branch copied with `git branch -c` retains the old context key.
         * Repair it only after reserving the context/branch transition, then
         * reread the key before publishing the new registry context.
         */
        const repairCopiedBranch = (
          report: ManagedWorkspaceDiscovery,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          | InvalidManagedIdentityError
          | DuplicateManagedIdentityError
          | UnsupportedGitWorkspaceError
          | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const existing = report.activeTransition;
            const resuming = existing?.kind === "branch-copy";
            if (!resuming && !branchCopyIsUnambiguous(report)) {
              return yield* Effect.fail(
                new ManagedCopiedBranchConflictError({
                  branch: report.context.branch ?? "unknown",
                  existingContextId: report.identity.contextId,
                  requestedContextId: report.identity.contextId,
                }),
              );
            }
            const branch =
              existing?.branch ??
              (report.context.kind === "branch" ? report.context.branch : undefined);
            const projectId = report.identity.projectId;
            const checkoutId = report.identity.checkoutId;
            const contextId = existing?.contextId ?? report.identity.contextId;
            if (
              branch === undefined ||
              projectId === undefined ||
              checkoutId === undefined ||
              contextId === undefined
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Copied branch context repair requires a complete identity",
                }),
              );
            }
            const path = report.workspace.workspaceRoot;
            const existingTargetValid = (value: string | undefined): value is string => {
              if (value === undefined || value === contextId) return false;
              try {
                assertManagedUuid(value, "branch-copy target contextId");
                return true;
              } catch {
                return false;
              }
            };
            const existingCopyMatches =
              existing?.kind === "branch-copy" &&
              existing.projectId === projectId &&
              existing.checkoutId === checkoutId &&
              existing.contextId === contextId &&
              existing.branch === branch &&
              existing.path === path &&
              existing.expectedGitValue === contextId &&
              existingTargetValid(existing.targetGitValue);
            const transition = existingCopyMatches
              ? existing
              : yield* repository.reserveIdentityTransition({
                  id: yield* managedUuid("identity transition"),
                  kind: "branch-copy",
                  projectId,
                  checkoutId,
                  contextId,
                  branch,
                  path,
                  expectedGitValue: contextId,
                  targetGitValue: yield* managedUuid("contextId"),
                  now: now(),
                });
            const target = transition.targetGitValue;
            if (target === undefined) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            if (transition.phase === "reserved") {
              const current = yield* discover(path);
              if (
                current.identity.projectId !== projectId ||
                current.identity.checkoutId !== checkoutId ||
                (current.identity.contextId !== contextId &&
                  current.identity.contextId !== target) ||
                current.context.kind !== "branch" ||
                current.context.branch !== branch
              ) {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Copied branch changed before context repair",
                  }),
                );
              }
              const inspection = yield* withWorkspaceServices(inspectWorkspace(path));
              if (inspection.kind !== "git-checkout" || inspection.head.kind === "detached") {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Copied branch context repair requires a live branch checkout",
                  }),
                );
              }
              const observed = yield* withWorkspaceServices(
                readBranchContextId(inspection, branch),
              );
              if (observed !== contextId && observed !== target) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
              if (observed === contextId) {
                yield* withWorkspaceServices(
                  replaceBranchContextId(inspection, branch, contextId, target),
                );
              }
              const winner = yield* withWorkspaceServices(readBranchContextId(inspection, branch));
              if (winner !== target) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
              yield* repository.advanceIdentityTransition({
                id: transition.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: now(),
              });
            }
            const current = yield* discover(path);
            if (
              current.context.kind !== "branch" ||
              current.context.branch !== branch ||
              current.identity.projectId !== projectId ||
              current.identity.checkoutId !== checkoutId ||
              current.identity.contextId !== target
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Copied branch context repair did not settle on the winner",
                }),
              );
            }
            if (transition.phase === "git-written" || transition.phase === "reserved") {
              yield* repository.registerCheckoutIdentity({
                identity: { projectId, checkoutId, contextId: target },
                checkoutKind: current.workspace.checkoutKind,
                checkoutRootPath: current.workspace.workspaceRoot,
                locationId: yield* managedUuid("checkout location"),
                context: current.contextDescriptor,
                now: now(),
              });
              const latest =
                (yield* repository.listIdentityClaims()).transitions.find(
                  (candidate) => candidate.id === transition.id,
                ) ?? transition;
              if (latest.phase === "git-written") {
                yield* repository.finalizeIdentityTransition({
                  id: latest.id,
                  expectedPhase: "git-written",
                  now: now(),
                });
              }
            }
            return yield* discover(path);
          });

        const adoptContext = (
          options: ManagedCheckoutRecoveryRequest,
        ): Effect.Effect<
          ManagedWorkspaceDiscovery,
          InvalidManagedIdentityError | UnsupportedGitWorkspaceError | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const report = yield* recoveryReport(options);
            if (
              report.context.kind !== "branch" ||
              report.context.branch === undefined ||
              report.identity.contextId === undefined ||
              report.identity.projectId === undefined ||
              report.identity.checkoutId === undefined
            ) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed context adoption requires a complete branch identity",
                }),
              );
            }
            const branch = options.branch ?? report.context.branch;
            const contextId = options.contextId ?? report.identity.contextId;
            const operation = report.recoveryOperations.find(
              (candidate) =>
                candidate.operation === "adoptContext" &&
                candidate.branch === branch &&
                candidate.contextId === contextId,
            );
            const transition = report.activeTransition;
            const resuming =
              transition?.kind === "adopt-context" &&
              transition.projectId === report.identity.projectId &&
              transition.checkoutId === report.identity.checkoutId &&
              transition.contextId === contextId &&
              transition.branch === branch &&
              transition.path === report.workspace.workspaceRoot &&
              transition.expectedGitValue === contextId &&
              transition.targetGitValue === contextId;
            if (operation === undefined && !resuming) {
              return yield* Effect.fail(
                new InvalidManagedIdentityError({
                  message: "Managed context adoption is not an advertised recovery operation",
                }),
              );
            }
            const path = report.workspace.workspaceRoot;
            const reserved =
              resuming && transition !== undefined
                ? transition
                : yield* repository.reserveIdentityTransition({
                    id: yield* managedUuid("identity transition"),
                    kind: "adopt-context",
                    projectId: report.identity.projectId,
                    checkoutId: report.identity.checkoutId,
                    contextId,
                    branch,
                    path,
                    expectedGitValue: contextId,
                    targetGitValue: contextId,
                    now: now(),
                  });
            if (reserved.phase === "reserved") {
              const current = yield* discover(path);
              if (
                current.identity.contextId !== contextId ||
                current.context.kind !== "branch" ||
                current.context.branch !== branch
              ) {
                return yield* Effect.fail(
                  new InvalidManagedIdentityError({
                    message: "Managed context changed before adoption",
                  }),
                );
              }
              yield* repository.refreshContextOwner({
                contextId,
                ownerBranch: branch,
                locator: branch,
                now: now(),
              });
              yield* repository.advanceIdentityTransition({
                id: reserved.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: now(),
              });
            }
            const context = (yield* repository.listIdentityClaims(
              report.identity.projectId,
            )).contexts.find((candidate) => candidate.id === contextId);
            if (context?.ownerBranch !== branch) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: reserved.id }),
              );
            }
            const latest =
              (yield* repository.listIdentityClaims()).transitions.find(
                (candidate) => candidate.id === reserved.id,
              ) ?? reserved;
            if (latest.phase === "git-written") {
              yield* repository.finalizeIdentityTransition({
                id: latest.id,
                expectedPhase: "git-written",
                now: now(),
              });
            }
            return yield* discover(path);
          });

        const abandonIdentityTransition = (
          options: ManagedIdentityTransitionAbandonRequest,
        ): Effect.Effect<
          AbandonManagedIdentityTransitionResult,
          | InvalidManagedIdentityError
          | DuplicateManagedIdentityError
          | UnsupportedGitWorkspaceError
          | ManagedIdentityRecoveryError
        > =>
          Effect.gen(function* () {
            const path = yield* requestedRecoveryPath(options);
            const report = yield* recoveryReport({
              workspacePath: path,
              observation: options.observation,
            });
            const claims = yield* repository.listIdentityClaims();
            const transition = claims.transitions.find(
              (candidate) => candidate.id === options.transitionId,
            );
            if (transition === undefined) return { outcome: "already-absent" as const };
            if (
              report.state !== "transitioning" ||
              report.conflicts.length > 0 ||
              transition.phase !== "reserved" ||
              transition.path !== report.workspace.workspaceRoot ||
              report.activeTransition === undefined ||
              report.activeTransition.id !== transition.id ||
              report.activeTransition.kind !== transition.kind ||
              report.activeTransition.path !== transition.path ||
              report.activeTransition.projectId !== transition.projectId ||
              report.activeTransition.checkoutId !== transition.checkoutId ||
              report.activeTransition.contextId !== transition.contextId ||
              report.activeTransition.branch !== transition.branch ||
              report.activeTransition.expectedGitValue !== transition.expectedGitValue ||
              report.activeTransition.targetGitValue !== transition.targetGitValue
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            if (
              (transition.kind === "branch-copy" || transition.kind === "adopt-context") &&
              ((transition.projectId !== undefined &&
                transition.projectId !== report.identity.projectId) ||
                (transition.checkoutId !== undefined &&
                  transition.checkoutId !== report.identity.checkoutId) ||
                (transition.contextId !== undefined &&
                  transition.contextId !== report.identity.contextId) ||
                (transition.branch !== undefined &&
                  (report.context.kind !== "branch" ||
                    report.context.branch !== transition.branch)))
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            if (transition.kind === "new-checkout") {
              if (
                report.identity.projectId !== undefined ||
                report.identity.checkoutId !== undefined ||
                report.identity.contextId !== undefined
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
            } else if (transition.kind === "folder-to-git") {
              if (
                report.identity.projectId !== undefined ||
                report.identity.checkoutId !== undefined ||
                report.identity.contextId !== undefined
              ) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
            } else if (transition.kind === "branch-copy") {
              if (report.identity.contextId === transition.targetGitValue) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
            } else if (transition.kind === "adopt-context") {
              const context = claims.contexts.find(
                (candidate) => candidate.id === transition.contextId,
              );
              if (context?.ownerBranch === transition.branch) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
              if (context?.ownerBranch !== undefined) {
                return yield* Effect.fail(
                  new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
                );
              }
            } else if (
              transition.kind === "rebind-checkout" &&
              (report.workspace.checkoutKind === "ordinary" ||
                report.locations.some(
                  (location) =>
                    location.state === "active" &&
                    location.canonicalPath === report.workspace.workspaceRoot,
                ) ||
                (transition.projectId !== undefined &&
                  transition.projectId !== report.identity.projectId) ||
                (transition.checkoutId !== undefined &&
                  transition.checkoutId !== report.identity.checkoutId) ||
                (transition.contextId !== undefined &&
                  transition.contextId !== report.identity.contextId) ||
                (transition.branch !== undefined &&
                  transition.branch !==
                    (report.context.kind === "branch" ? report.context.branch : undefined)))
            ) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            if (transition.path === undefined) {
              return yield* Effect.fail(
                new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
              );
            }
            return yield* repository.abandonIdentityTransition({
              id: transition.id,
              expectedPhase: "reserved",
              kind: transition.kind,
              path: transition.path,
              projectId: transition.projectId,
              checkoutId: transition.checkoutId,
              contextId: transition.contextId,
              branch: transition.branch,
              expectedGitValue: transition.expectedGitValue,
              targetGitValue: transition.targetGitValue,
            });
          });

        /**
         * The identity a mutating resolve must have ended up with. Every claim
         * above either produces all three parts or fails, so a gap here is a bug
         * in this module rather than a state a caller could be in — but it is
         * reported rather than asserted, because inventing an identity is the one
         * thing this layer must never do.
         */
        const requireResolvedIdentity = (
          plan: ResolvedWorkspace,
        ): Effect.Effect<ManagedIdentityTriple, InvalidManagedIdentityError> => {
          const { projectId, checkoutId, contextId } = plan.identity;
          return projectId === undefined || checkoutId === undefined || contextId === undefined
            ? Effect.fail(
                new InvalidManagedIdentityError({
                  message: `${plan.workspace.canonicalPath} was resolved without a complete identity`,
                }),
              )
            : Effect.succeed({ projectId, checkoutId, contextId });
        };

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
          plan: ResolvedWorkspace,
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
          plan: ResolvedWorkspace,
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
            const report = yield* discover(resolveOptions.workspacePath);
            const settledReport =
              resolveOptions.operation === "start"
                ? yield* discover(resolveOptions.workspacePath)
                : report;
            const sameWorkspaceTopology = sameManagedWorkspaceTopology(report, settledReport);
            const settledIdentityIsMonotonic = identityPublicationIsMonotonic(
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
                concurrentIdentityPublication(report, settledReport));
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
              recoveryReportForStart = yield* migrateFolderToGit(settledReport);
            }
            if (resolveOptions.operation === "start" && settledReport.state === "moved") {
              recoveryReportForStart = yield* rebindCheckout({
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
              recoveryReportForStart = yield* adoptContext({
                workspacePath: resolveOptions.workspacePath,
                observation: settledReport,
              });
            }
            if (
              resolveOptions.operation === "start" &&
              ((recoveryReportForStart.state === "duplicate" &&
                branchCopyIsUnambiguous(recoveryReportForStart)) ||
                (recoveryReportForStart.state === "transitioning" &&
                  recoveryReportForStart.activeTransition?.kind === "branch-copy"))
            ) {
              recoveryReportForStart = yield* repairCopiedBranch(recoveryReportForStart);
            }
            const plan: ResolvedWorkspace = {
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
                ? yield* claimUnregisteredWorkspace(recoveryReportForStart)
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
          discoverWorkspace: discover,
          newCheckout,
          rebindCheckout,
          adoptContext,
          abandonIdentityTransition,
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
