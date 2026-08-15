import { Effect, FileSystem } from "effect";
import {
  DuplicateManagedIdentityError,
  ManagedCopiedBranchConflictError,
  InvalidManagedIdentityError,
  ManagedCheckoutConflictError,
  ManagedIdentityTransitionOwnershipError,
  ManagedInaccessiblePathError,
  UnsupportedGitWorkspaceError,
  type ManagedCheckoutKind,
  type ManagedContextDescriptor,
  type ManagedContextKind,
  type ManagedIdentityTriple,
  type ManagedIdentityClaims,
  type ManagedIdentityTransitionRecord,
} from "./model.ts";
import {
  ensureOrdinaryWorkspaceIdentity,
  publishGitCheckoutIdentity,
  publishOrdinaryWorkspaceIdentity,
  readOrdinaryWorkspaceIdentityWithFileSystem,
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
import { assertManagedUuid } from "./ids.ts";
import { gitConfigPath } from "./paths.ts";
import {
  ManagedStackRepository,
  type AbandonManagedIdentityTransitionResult,
  type ManagedIdentityRecoveryError,
  type ManagedStackRepositoryShape,
} from "./repository.ts";
import { discoverWorkspace, type ManagedWorkspaceDiscovery } from "./discovery.ts";
import {
  NEW_CHECKOUT_DETACHED_TOPOLOGY,
  NEW_CHECKOUT_ORDINARY_TOPOLOGY,
  checkoutKindOf,
  newCheckoutTopologyMatches,
} from "./topology.ts";
import { discoveryObservation } from "./discovery-observation.ts";
import { workspaceMetadata } from "./workspace-metadata.ts";

export interface WorkspaceIdentityDependencies {
  readonly repository: ManagedStackRepositoryShape;
  readonly withWorkspaceServices: <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | GitConfigStore>,
  ) => Effect.Effect<A, E>;
  readonly idFactory: () => string;
  readonly managedUuid: (label: string) => Effect.Effect<string, InvalidManagedIdentityError>;
  readonly now: () => string;
}

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

/**
 * The settled workspace, context, and identity facts shared between identity
 * policy and the service composition while resolving a managed stack.
 */
export interface ResolvedWorkspacePlan {
  readonly workspace: ResolvedManagedWorkspace;
  readonly context: ResolvedManagedContext;
  readonly contextDescriptor: ManagedContextDescriptor;
  readonly identity: ResolvedManagedIdentity;
  readonly identityMarkerCreated: boolean;
}

interface FirstStartClaim {
  readonly plan: ResolvedWorkspacePlan;
  readonly transition?: ManagedIdentityTransitionRecord;
}

/**
 * The identity a mutating resolve must have ended up with. Every claim
 * produces all three parts or fails, so a gap here is a bug in the identity
 * policy rather than a state a caller could be in — but it is reported rather
 * than asserted, because inventing an identity is the one thing this policy
 * must never do.
 */
export const requireResolvedIdentity = (
  plan: ResolvedWorkspacePlan,
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

const newCheckoutTransitionMatches = (
  transition: ManagedIdentityTransitionRecord | undefined,
  transitionId: string,
  targetIdentity: ManagedIdentityTriple,
  report: ManagedWorkspaceDiscovery,
): boolean =>
  transition !== undefined &&
  transition.kind === "new-checkout" &&
  transition.id === transitionId &&
  transition.path === report.workspace.workspaceRoot &&
  transition.projectIdentityLocation === report.workspace.projectIdentityLocation &&
  transition.projectId === targetIdentity.projectId &&
  transition.checkoutId === targetIdentity.checkoutId &&
  transition.contextId === targetIdentity.contextId &&
  transition.targetGitValue === targetIdentity.contextId &&
  newCheckoutTopologyMatches(transition, report.context);

export const makeWorkspaceIdentity = ({
  repository,
  withWorkspaceServices,
  idFactory,
  managedUuid,
  now,
}: WorkspaceIdentityDependencies) => {
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
    ResolvedWorkspacePlan,
    | InvalidManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityTransitionOwnershipError
  > =>
    Effect.gen(function* () {
      const canonicalPath = report.workspace.canonicalPath;
      const freshReport = yield* discover(canonicalPath);
      const sameWorkspaceTopology = sameManagedWorkspaceTopology(report, freshReport);
      const exactNewCheckoutPublication =
        targetIdentity !== undefined &&
        (freshReport.activeTransition?.phase === "reserved" ||
          freshReport.activeTransition?.phase === "git-written") &&
        newCheckoutTransitionMatches(
          freshReport.activeTransition,
          transitionId,
          targetIdentity,
          freshReport,
        ) &&
        freshReport.state === "transitioning" &&
        freshReport.conflicts.length === 0 &&
        sameWorkspaceTopology &&
        identityPublicationIsMonotonic(report, freshReport);
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
        !concurrentIdentityPublication(report, freshReport) &&
        !exactNewCheckoutPublication
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
        return yield* Effect.fail(new ManagedIdentityTransitionOwnershipError({ transitionId }));
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
      const metadata = workspaceMetadata(inspection);

      if (inspection.kind === "ordinary-folder") {
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
          ...metadata,
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
        const checkoutIdentityCreated = yield* withWorkspaceServices(
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
        return {
          ...metadata,
          identity: targetIdentity,
          identityMarkerCreated: checkoutIdentityCreated,
        };
      }
      const claimed = yield* withWorkspaceServices(
        ensureGitCheckoutIdentity(inspection, idFactory),
      );
      const checkoutId = claimed.checkoutId;
      const head = inspection.head;
      return {
        ...metadata,
        // An unborn branch names a context exactly as a born one does: it is
        // the state a fresh repository starts in, and a first start there
        // must not be treated as a detached `HEAD`.
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

  const abandonReservedTransition = (transition: ManagedIdentityTransitionRecord, path: string) =>
    repository.abandonIdentityTransition({
      id: transition.id,
      expectedPhase: "reserved",
      kind: transition.kind,
      path,
      projectId: transition.projectId,
      checkoutId: transition.checkoutId,
      contextId: transition.contextId,
      branch: transition.branch,
      projectIdentityLocation: transition.projectIdentityLocation,
      expectedGitValue: transition.expectedGitValue,
      targetGitValue: transition.targetGitValue,
      expectedOwnerBranch: transition.expectedOwnerBranch,
    });

  const pathIsDefinitelyMissing = (path: string): Effect.Effect<boolean> =>
    withWorkspaceServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.stat(path).pipe(
          Effect.as(false),
          Effect.catchTag("PlatformError", (error) =>
            Effect.succeed(error.reason._tag === "NotFound"),
          ),
        );
      }),
    );

  /**
   * A stale Git checkout publication can be released only when its original
   * worktree is definitely gone, its exact shared project is still current,
   * and no registry claim has consumed the reserved identity. Reserved rows
   * are abandoned; a git-written row is finalized so its publication remains
   * historical rather than being mistaken for an active claim.
   */
  const releaseMissingSharedNewCheckoutReservation = (
    report: ManagedWorkspaceDiscovery,
  ): Effect.Effect<void, ManagedIdentityRecoveryError> =>
    Effect.gen(function* () {
      const claims = yield* repository.listIdentityClaims();
      const stale = claims.transitions.find(
        (transition) =>
          transition.kind === "new-checkout" &&
          (transition.phase === "reserved" || transition.phase === "git-written") &&
          transition.path !== undefined &&
          transition.path !== report.workspace.workspaceRoot &&
          transition.projectIdentityLocation === report.workspace.projectIdentityLocation,
      );
      if (
        stale?.path === undefined ||
        stale.projectId === undefined ||
        stale.checkoutId === undefined ||
        stale.contextId === undefined ||
        !(yield* pathIsDefinitelyMissing(stale.path))
      ) {
        return;
      }
      const hasRegistryClaim = (snapshot: ManagedIdentityClaims): boolean =>
        snapshot.checkoutProjects.some((checkout) => checkout.checkoutId === stale.checkoutId) ||
        snapshot.contexts.some(
          (context) => context.id === stale.contextId || context.checkoutId === stale.checkoutId,
        ) ||
        snapshot.locations.some((location) => location.checkoutId === stale.checkoutId);
      const eligible = (snapshot: ManagedIdentityClaims, current: ManagedWorkspaceDiscovery) =>
        !hasRegistryClaim(snapshot) &&
        current.workspace.projectIdentityLocation === stale.projectIdentityLocation &&
        (stale.phase === "git-written"
          ? current.identity.projectId === stale.projectId
          : current.identity.projectId === undefined ||
            current.identity.projectId === stale.projectId) &&
        current.identity.checkoutId === undefined &&
        current.identity.contextId === undefined;
      const current = yield* discover(report.workspace.workspaceRoot).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (current === undefined || !eligible(claims, current)) return;

      // Re-read both sides immediately before settling so a concurrent winner
      // or registry claim cannot be released by a stale observation.
      const latestClaims = yield* repository.listIdentityClaims();
      const latest = latestClaims.transitions.find((candidate) => candidate.id === stale.id);
      const latestCurrent = yield* discover(report.workspace.workspaceRoot).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (
        latest === undefined ||
        latest.phase !== stale.phase ||
        latest.path === undefined ||
        !(yield* pathIsDefinitelyMissing(latest.path)) ||
        latestCurrent === undefined ||
        !eligible(latestClaims, latestCurrent)
      ) {
        return;
      }
      if (latest.phase === "reserved") {
        yield* abandonReservedTransition(latest, latest.path);
      } else {
        yield* repository.finalizeIdentityTransition({
          id: latest.id,
          expectedPhase: "git-written",
          now: now(),
        });
      }
    });

  /**
   * Convert one exact ordinary-folder claim into Git-owned identity.
   * The ordinary marker is deliberately never rewritten or deleted: it
   * is historical evidence, while the registry claim and the Git files
   * are the authoritative winner. A reserved transition owns the whole
   * sequence, so an interrupted publication can only resume after every
   * expected value still matches.
   */
  interface ManagedFolderToGitRecoveryResult {
    readonly report: ManagedWorkspaceDiscovery;
    readonly identityMarkerCreated: boolean;
  }

  const migrateFolderToGit = (
    report: ManagedWorkspaceDiscovery,
  ): Effect.Effect<
    ManagedFolderToGitRecoveryResult,
    | InvalidManagedIdentityError
    | DuplicateManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityRecoveryError
  > =>
    Effect.gen(function* () {
      const resuming = report.activeTransition?.kind === "folder-to-git";
      if (!resuming) {
        if (report.folderToGitClaims.length === 0) {
          return { report, identityMarkerCreated: false };
        }
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
          return { report, identityMarkerCreated: false };
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
      if (claim === undefined || report.workspace.checkoutKind === "ordinary") {
        return { report, identityMarkerCreated: false };
      }
      const path = report.workspace.workspaceRoot;
      const inspection = yield* withWorkspaceServices(inspectWorkspace(path));
      if (inspection.kind !== "git-checkout") {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Folder-to-Git migration lost its Git workspace",
          }),
        );
      }
      if (inspection.commonDirectory !== report.workspace.projectIdentityLocation) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Folder-to-Git migration changed repositories before reservation",
          }),
        );
      }
      if (claim.canonicalPath !== path && !(yield* pathIsDefinitelyMissing(claim.canonicalPath))) {
        return yield* Effect.fail(
          new ManagedCheckoutConflictError({
            checkoutId: claim.checkoutId,
            canonicalPath: claim.canonicalPath,
          }),
        );
      }
      const projectIdentityLocation = inspection.commonDirectory;
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
              projectIdentityLocation,
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
        transition.projectIdentityLocation !== projectIdentityLocation ||
        transition.expectedGitValue !== "absent" ||
        transition.targetGitValue !== claim.contextId ||
        transition.branch !== (report.context.kind === "branch" ? report.context.branch : undefined)
      ) {
        return yield* Effect.fail(
          new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
        );
      }

      let identityMarkerCreated = false;
      if (transition.phase === "reserved") {
        const ordinaryMarker = yield* withWorkspaceServices(
          readOrdinaryWorkspaceIdentityWithFileSystem(path),
        );
        if (
          ordinaryMarker?.projectId !== claim.projectId ||
          ordinaryMarker.checkoutId !== claim.checkoutId ||
          ordinaryMarker.contextId !== claim.contextId
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
          );
        }
        if (
          claim.canonicalPath !== path &&
          !(yield* pathIsDefinitelyMissing(claim.canonicalPath))
        ) {
          return yield* Effect.fail(
            new ManagedCheckoutConflictError({
              checkoutId: claim.checkoutId,
              canonicalPath: claim.canonicalPath,
            }),
          );
        }
        const claimsAfterReserve = yield* repository.listIdentityClaims();
        const exactLocationClaims = claimsAfterReserve.locations.filter(
          (location) =>
            location.state === "active" && location.canonicalPath === claim.canonicalPath,
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
          ? yield* withWorkspaceServices(readBranchContextId(inspection, inspection.head.branch))
          : undefined;
      if (
        (gitIdentity.projectId !== undefined && gitIdentity.projectId !== claim.projectId) ||
        (gitIdentity.checkoutId !== undefined && gitIdentity.checkoutId !== claim.checkoutId) ||
        (branchContext !== undefined && branchContext !== claim.contextId)
      ) {
        if (
          transition.phase === "reserved" &&
          gitIdentity.checkoutId === undefined &&
          ((gitIdentity.projectId !== undefined && gitIdentity.projectId !== claim.projectId) ||
            (branchContext !== undefined && branchContext !== claim.contextId))
        ) {
          yield* abandonReservedTransition(transition, path);
        }
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
        identityMarkerCreated = yield* withWorkspaceServices(
          publishGitCheckoutIdentity(inspection.gitDirectory, claim.checkoutId),
        );
        if (inspection.head.kind !== "detached") {
          yield* publishConfig(gitBranchContextIdKey(inspection.head.branch), claim.contextId);
        }
        const reread = yield* withWorkspaceServices(
          readGitCheckoutIdentityWithFileSystem(inspection),
        );
        const rereadBranch =
          inspection.head.kind !== "detached"
            ? yield* withWorkspaceServices(readBranchContextId(inspection, inspection.head.branch))
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

      const claimsBeforeLocation = yield* repository.listIdentityClaims();
      const activeLocation = claimsBeforeLocation.locations.find(
        (location) => location.checkoutId === claim.checkoutId && location.state === "active",
      );
      if (activeLocation === undefined) {
        return yield* Effect.fail(
          new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
        );
      }
      if (activeLocation.canonicalPath !== path) {
        if (!(yield* pathIsDefinitelyMissing(activeLocation.canonicalPath))) {
          return yield* Effect.fail(
            new ManagedCheckoutConflictError({
              checkoutId: claim.checkoutId,
              canonicalPath: activeLocation.canonicalPath,
            }),
          );
        }
        const decision = yield* repository.applyCheckoutLocation({
          checkoutId: claim.checkoutId,
          locationId: yield* managedUuid("checkout location"),
          canonicalPath: path,
          now: now(),
          expectedActiveLocationId: activeLocation.id,
        });
        if (decision.outcome === "blocked") {
          return yield* Effect.fail(
            new ManagedCheckoutConflictError({
              checkoutId: claim.checkoutId,
              canonicalPath: path,
            }),
          );
        }
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
          ? yield* withWorkspaceServices(readBranchContextId(inspection, inspection.head.branch))
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
      return { report: migrated, identityMarkerCreated };
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
          (report.context.kind === "branch" && report.context.branch === transition.branch)) &&
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

  const publishNewCheckout = (
    report: ManagedWorkspaceDiscovery,
  ): Effect.Effect<
    {
      readonly published: ManagedWorkspaceDiscovery;
      readonly transition?: ManagedIdentityTransitionRecord;
      readonly identityMarkerCreated: boolean;
    },
    | InvalidManagedIdentityError
    | DuplicateManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityRecoveryError
  > =>
    Effect.gen(function* () {
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
      if (report.activeTransition === undefined) {
        yield* releaseMissingSharedNewCheckoutReservation(report);
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
                projectIdentityLocation: report.workspace.projectIdentityLocation,
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
        transition.projectIdentityLocation !== report.workspace.projectIdentityLocation ||
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
      const publishedIdentityMatches = (candidate: ManagedWorkspaceDiscovery): boolean =>
        candidate.conflicts.length === 0 &&
        candidate.identity.projectId === targetIdentity.projectId &&
        candidate.identity.checkoutId === targetIdentity.checkoutId &&
        candidate.identity.contextId === targetIdentity.contextId;
      const abandonReserved = () => abandonReservedTransition(transition, path);
      let identityMarkerCreated = false;
      if (transition.phase === "reserved") {
        const beforePublication = yield* discover(path);
        const beforeClaims = yield* repository.listIdentityClaims();
        const reserved = beforeClaims.transitions.find(
          (candidate) => candidate.id === transition.id,
        );
        if (
          reserved?.phase === "finalized" &&
          beforePublication.state === "healthy" &&
          beforePublication.activeTransition === undefined &&
          sameManagedWorkspaceTopology(report, beforePublication) &&
          newCheckoutTransitionMatches(
            reserved,
            transition.id,
            targetIdentity,
            beforePublication,
          ) &&
          publishedIdentityMatches(beforePublication)
        ) {
          return {
            published: beforePublication,
            transition: undefined,
            identityMarkerCreated: false,
          };
        }
        if (
          reserved === undefined ||
          reserved.phase !== "reserved" ||
          reserved.kind !== "new-checkout" ||
          reserved.path !== path ||
          reserved.projectIdentityLocation !==
            beforePublication.workspace.projectIdentityLocation ||
          !newCheckoutTopologyMatches(reserved, beforePublication.context)
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
          );
        }
        if (
          beforePublication.identity.projectId !== undefined &&
          beforePublication.identity.projectId !== targetIdentity.projectId &&
          beforePublication.identity.checkoutId === undefined
        ) {
          yield* abandonReserved();
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
          );
        }
        if (
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
        ).pipe(
          Effect.catchTag("ManagedIdentityTransitionOwnershipError", (error) =>
            Effect.gen(function* () {
              const afterFailure = yield* discover(path).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
              );
              if (
                afterFailure?.identity.projectId !== undefined &&
                afterFailure.identity.projectId !== targetIdentity.projectId &&
                afterFailure.identity.checkoutId === undefined
              ) {
                yield* abandonReserved();
              }
              return yield* Effect.fail(error);
            }),
          ),
        );
        identityMarkerCreated = claimed.identityMarkerCreated;
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
        yield* repository
          .advanceIdentityTransition({
            id: transition.id,
            expectedPhase: "reserved",
            phase: "git-written",
            now: now(),
          })
          .pipe(
            Effect.catchTag("ManagedIdentityTransitionOwnershipError", (error) =>
              Effect.gen(function* () {
                const latest = (yield* repository.listIdentityClaims()).transitions.find(
                  (candidate) => candidate.id === transition.id,
                );
                const settled = yield* discover(path);
                if (
                  latest?.phase === "finalized" &&
                  settled.state === "healthy" &&
                  settled.activeTransition === undefined &&
                  sameManagedWorkspaceTopology(beforePublication, settled) &&
                  newCheckoutTransitionMatches(latest, transition.id, targetIdentity, settled) &&
                  publishedIdentityMatches(settled)
                ) {
                  return;
                }
                return yield* Effect.fail(error);
              }),
            ),
          );
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
      return {
        published,
        transition: latestTransition.phase === "git-written" ? latestTransition : undefined,
        identityMarkerCreated,
      };
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
      const { published, transition } = yield* publishNewCheckout(report);
      if (transition !== undefined) {
        if (
          transition.projectId === undefined ||
          transition.checkoutId === undefined ||
          transition.contextId === undefined
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
          );
        }
        yield* repository.registerCheckoutIdentity({
          identity: {
            projectId: transition.projectId,
            checkoutId: transition.checkoutId,
            contextId: transition.contextId,
          },
          checkoutKind: published.workspace.checkoutKind,
          checkoutRootPath: published.workspace.workspaceRoot,
          locationId: yield* managedUuid("checkout location"),
          context: published.contextDescriptor,
          now: now(),
        });
        yield* repository.finalizeIdentityTransition({
          id: transition.id,
          expectedPhase: "git-written",
          now: now(),
        });
      }
      return yield* discover(published.workspace.workspaceRoot);
    });

  const claimFirstStart = (
    report: ManagedWorkspaceDiscovery,
  ): Effect.Effect<
    FirstStartClaim,
    | InvalidManagedIdentityError
    | DuplicateManagedIdentityError
    | UnsupportedGitWorkspaceError
    | ManagedIdentityRecoveryError
  > =>
    Effect.gen(function* () {
      const fresh = yield* discover(report.workspace.workspaceRoot);
      if (
        fresh.state === "healthy" &&
        fresh.conflicts.length === 0 &&
        fresh.activeTransition === undefined &&
        fresh.identity.projectId !== undefined &&
        fresh.identity.checkoutId !== undefined &&
        fresh.identity.contextId !== undefined
      ) {
        return {
          plan: {
            workspace: fresh.workspace,
            context: fresh.context,
            contextDescriptor: fresh.contextDescriptor,
            identity: fresh.identity,
            identityMarkerCreated: false,
          },
        };
      }
      if (
        fresh.state !== "unregistered" &&
        !(
          fresh.state === "transitioning" &&
          fresh.activeTransition?.kind === "new-checkout" &&
          fresh.activeTransition.path === fresh.workspace.workspaceRoot
        )
      ) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: `Managed workspace ${fresh.workspace.canonicalPath} is ${fresh.state}, not unregistered`,
          }),
        );
      }
      const { published, transition, identityMarkerCreated } = yield* publishNewCheckout(fresh);
      const identity =
        transition?.projectId !== undefined &&
        transition.checkoutId !== undefined &&
        transition.contextId !== undefined
          ? {
              projectId: transition.projectId,
              checkoutId: transition.checkoutId,
              contextId: transition.contextId,
            }
          : published.identity;
      return {
        plan: {
          workspace: published.workspace,
          context: published.context,
          contextDescriptor: published.contextDescriptor,
          identity,
          identityMarkerCreated,
        },
        transition,
      };
    });

  const finalizeFirstStart = (
    transition: ManagedIdentityTransitionRecord,
  ): Effect.Effect<void, ManagedIdentityTransitionOwnershipError | ManagedIdentityRecoveryError> =>
    transition.kind !== "new-checkout" || transition.phase !== "git-written"
      ? Effect.fail(new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }))
      : repository
          .finalizeIdentityTransition({
            id: transition.id,
            expectedPhase: "git-written",
            now: now(),
          })
          .pipe(Effect.asVoid);

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
          (transition.contextId !== undefined && transition.contextId !== report.identity.contextId)
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
      const transition = yield* reserveRecoveryTransition(report, operation, checkoutId, path);
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
    const activeLocations = report.locations.filter((location) => location.state === "active");
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
      const branchCopyTakeover =
        existing?.kind === "branch-copy" &&
        (existing.phase === "reserved" || existing.phase === "git-written") &&
        existing.path !== undefined &&
        existing.path !== report.workspace.workspaceRoot &&
        existing.projectIdentityLocation !== undefined &&
        existing.projectIdentityLocation === report.workspace.projectIdentityLocation &&
        existing.projectId !== undefined &&
        existing.projectId === report.identity.projectId &&
        existing.checkoutId !== undefined &&
        existing.contextId !== undefined &&
        existing.branch !== undefined &&
        existing.branch ===
          (report.context.kind === "branch" ? report.context.branch : undefined) &&
        existing.expectedGitValue === existing.contextId &&
        existing.targetGitValue !== undefined &&
        existing.targetGitValue !== existing.contextId &&
        report.identity.checkoutId === undefined &&
        (report.identity.contextId === existing.contextId ||
          report.identity.contextId === existing.targetGitValue) &&
        report.conflicts.length === 0 &&
        report.conflictingLocations === undefined &&
        report.inaccessiblePaths === undefined;
      if (branchCopyTakeover && existing !== undefined) {
        const path = report.workspace.workspaceRoot;
        const target = existing.targetGitValue;
        const current = yield* discover(path);
        if (
          !(yield* pathIsDefinitelyMissing(existing.path)) ||
          current.activeTransition?.id !== existing.id ||
          current.activeTransition.kind !== "branch-copy" ||
          current.activeTransition.phase !== existing.phase ||
          current.workspace.projectIdentityLocation !== existing.projectIdentityLocation ||
          current.identity.projectId !== existing.projectId ||
          current.identity.checkoutId !== undefined ||
          (current.identity.contextId !== existing.contextId &&
            current.identity.contextId !== target) ||
          current.context.kind !== "branch" ||
          current.context.branch !== existing.branch ||
          current.conflicts.length > 0 ||
          current.conflictingLocations !== undefined ||
          current.inaccessiblePaths !== undefined
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: existing.id }),
          );
        }
        if (existing.phase === "reserved") {
          const inspection = yield* withWorkspaceServices(inspectWorkspace(path));
          if (inspection.kind !== "git-checkout" || inspection.head.kind === "detached") {
            return yield* Effect.fail(
              new ManagedIdentityTransitionOwnershipError({ transitionId: existing.id }),
            );
          }
          const observed = yield* withWorkspaceServices(
            readBranchContextId(inspection, existing.branch),
          );
          if (observed !== existing.contextId && observed !== target) {
            return yield* Effect.fail(
              new ManagedIdentityTransitionOwnershipError({ transitionId: existing.id }),
            );
          }
          if (observed === existing.contextId) {
            yield* withWorkspaceServices(
              replaceBranchContextId(inspection, existing.branch, existing.contextId, target),
            );
          }
          const winner = yield* withWorkspaceServices(
            readBranchContextId(inspection, existing.branch),
          );
          if (winner !== target) {
            return yield* Effect.fail(
              new ManagedIdentityTransitionOwnershipError({ transitionId: existing.id }),
            );
          }
          yield* repository.advanceIdentityTransition({
            id: existing.id,
            expectedPhase: "reserved",
            phase: "git-written",
            now: now(),
          });
        }
        const latest = (yield* repository.listIdentityClaims()).transitions.find(
          (candidate) => candidate.id === existing.id,
        );
        const settled = yield* discover(path);
        if (
          !(yield* pathIsDefinitelyMissing(existing.path)) ||
          latest?.kind !== "branch-copy" ||
          latest.phase !== "git-written" ||
          latest.projectId !== existing.projectId ||
          latest.checkoutId !== existing.checkoutId ||
          latest.contextId !== existing.contextId ||
          latest.branch !== existing.branch ||
          latest.path !== existing.path ||
          latest.projectIdentityLocation !== existing.projectIdentityLocation ||
          latest.expectedGitValue !== existing.expectedGitValue ||
          latest.targetGitValue !== existing.targetGitValue ||
          settled.identity.projectId !== existing.projectId ||
          settled.identity.checkoutId !== undefined ||
          settled.identity.contextId !== target ||
          settled.context.kind !== "branch" ||
          settled.context.branch !== existing.branch ||
          settled.conflicts.length > 0
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: existing.id }),
          );
        }
        yield* repository.finalizeIdentityTransition({
          id: latest.id,
          expectedPhase: "git-written",
          now: now(),
        });
        return yield* discover(path);
      }
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
        existing?.branch ?? (report.context.kind === "branch" ? report.context.branch : undefined);
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
            projectIdentityLocation: report.workspace.projectIdentityLocation,
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
          (current.identity.contextId !== contextId && current.identity.contextId !== target) ||
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
        const observed = yield* withWorkspaceServices(readBranchContextId(inspection, branch));
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
      const path = report.workspace.workspaceRoot;
      const takeover = report.activeTransition;
      const takeoverBranch = report.context.kind === "branch" ? report.context.branch : undefined;
      const missingOriginalCheckoutTakeover =
        takeover?.kind === "adopt-context" &&
        takeover.phase === "reserved" &&
        takeover.path !== undefined &&
        takeover.path !== path &&
        takeover.projectIdentityLocation !== undefined &&
        takeover.projectIdentityLocation === report.workspace.projectIdentityLocation &&
        takeover.projectId !== undefined &&
        takeover.projectId === report.identity.projectId &&
        takeover.contextId !== undefined &&
        takeover.contextId === report.identity.contextId &&
        takeover.branch === takeoverBranch &&
        takeover.expectedOwnerBranch !== undefined &&
        takeover.expectedOwnerBranch !== takeover.branch &&
        report.identity.checkoutId === undefined;
      if (missingOriginalCheckoutTakeover && takeover !== undefined) {
        const transitionContextId = takeover.contextId;
        const transitionBranch = takeover.branch;
        const transitionExpectedOwnerBranch = takeover.expectedOwnerBranch;
        if (transitionContextId === undefined || transitionBranch === undefined) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: takeover.id }),
          );
        }
        const current = yield* discover(path);
        const currentTransition = current.activeTransition;
        if (
          currentTransition?.id !== takeover.id ||
          currentTransition.phase !== "reserved" ||
          !(yield* pathIsDefinitelyMissing(takeover.path)) ||
          current.workspace.projectIdentityLocation !== takeover.projectIdentityLocation ||
          current.identity.projectId !== takeover.projectId ||
          current.identity.checkoutId !== undefined ||
          current.identity.contextId !== takeover.contextId ||
          current.context.kind !== "branch" ||
          current.context.branch !== takeover.branch ||
          current.ownerEvidence?.authoritativeOwnerBranch !== transitionExpectedOwnerBranch ||
          transitionExpectedOwnerBranch === undefined
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: takeover.id }),
          );
        }
        yield* repository.refreshContextOwner({
          contextId: transitionContextId,
          ownerBranch: transitionBranch,
          locator: transitionBranch,
          expectedOwnerBranch: transitionExpectedOwnerBranch,
          now: now(),
        });
        yield* repository.advanceIdentityTransition({
          id: takeover.id,
          expectedPhase: "reserved",
          phase: "git-written",
          now: now(),
        });
        const latest = (yield* repository.listIdentityClaims()).transitions.find(
          (candidate) => candidate.id === takeover.id,
        );
        if (latest?.phase !== "git-written") {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: takeover.id }),
          );
        }
        yield* repository.finalizeIdentityTransition({
          id: latest.id,
          expectedPhase: "git-written",
          now: now(),
        });
        return yield* discover(path);
      }
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
      const expectedOwnerBranch =
        resuming && transition !== undefined
          ? transition.expectedOwnerBranch
          : report.ownerEvidence?.authoritativeOwnerBranch;
      if (operation === undefined && !resuming) {
        return yield* Effect.fail(
          new InvalidManagedIdentityError({
            message: "Managed context adoption is not an advertised recovery operation",
          }),
        );
      }
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
              projectIdentityLocation: report.workspace.projectIdentityLocation,
              expectedGitValue: contextId,
              targetGitValue: contextId,
              expectedOwnerBranch,
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
        const currentOwnerBranch = current.ownerEvidence?.authoritativeOwnerBranch;
        if (currentOwnerBranch !== expectedOwnerBranch && currentOwnerBranch !== branch) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: reserved.id }),
          );
        }
        if (currentOwnerBranch === expectedOwnerBranch) {
          if (
            expectedOwnerBranch !== undefined &&
            current.ownerEvidence?.claims.some(
              (claim) => claim.branch === expectedOwnerBranch && claim.live,
            )
          ) {
            return yield* Effect.fail(
              new ManagedCopiedBranchConflictError({
                branch,
                existingContextId: contextId,
                requestedContextId: contextId,
              }),
            );
          }
          yield* repository.refreshContextOwner({
            contextId,
            ownerBranch: branch,
            locator: branch,
            expectedOwnerBranch,
            now: now(),
          });
        }
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
        report.activeTransition.projectIdentityLocation !== transition.projectIdentityLocation ||
        report.activeTransition.expectedGitValue !== transition.expectedGitValue ||
        report.activeTransition.targetGitValue !== transition.targetGitValue ||
        report.activeTransition.expectedOwnerBranch !== transition.expectedOwnerBranch
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
            (report.context.kind !== "branch" || report.context.branch !== transition.branch)))
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
        const context = claims.contexts.find((candidate) => candidate.id === transition.contextId);
        if (
          context === undefined ||
          context.ownerBranch !== transition.expectedOwnerBranch ||
          context.ownerBranch === transition.branch
        ) {
          return yield* Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
          );
        }
      } else if (
        transition.kind === "rebind-checkout" &&
        (report.locations.some(
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
        projectIdentityLocation: transition.projectIdentityLocation,
        expectedGitValue: transition.expectedGitValue,
        targetGitValue: transition.targetGitValue,
        expectedOwnerBranch: transition.expectedOwnerBranch,
      });
    });

  return {
    discover,
    claimFirstStart,
    finalizeFirstStart,
    migrateFolderToGit,
    newCheckout,
    rebindCheckout,
    branchCopyIsUnambiguous,
    repairCopiedBranch,
    adoptContext,
    abandonIdentityTransition,
    sameManagedWorkspaceTopology,
    identityPublicationIsMonotonic,
    concurrentIdentityPublication,
  };
};
