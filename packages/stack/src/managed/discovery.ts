import { Effect, FileSystem, type PlatformError } from "effect";
import {
  InvalidManagedIdentityError,
  UnsupportedGitWorkspaceError,
  type ManagedCheckoutLocation,
  type ManagedCheckoutKind,
  type ManagedContextDescriptor,
  type ManagedContextKind,
  type ManagedIdentityTransitionRecord,
  type ManagedIdentityClaims,
  type ManagedOperationRecord,
  type ManagedStackProjection,
  type ManagedIdentityTriple,
} from "./model.ts";
import {
  branchRefExists,
  GitConfigStore,
  inspectWorkspace,
  readBranchContextId,
  readGitCheckoutIdentityWithFileSystem,
  type GitCheckoutInspection,
  type WorkspaceInspection,
} from "./git.ts";
import {
  canonicalizeManagedWorkspacePathWithFileSystem,
  readOrdinaryWorkspaceIdentityWithFileSystem,
} from "./identity.ts";
import { gitConfigPath, ordinaryWorkspaceIdentityPath } from "./paths.ts";
import {
  ManagedStackRepository,
  protectedManagedCheckoutLocationIds,
  type ManagedStackRepositoryShape,
} from "./repository.ts";

export type ManagedWorkspaceDiscoveryState =
  | "adoptable"
  | "ambiguous"
  | "duplicate"
  | "healthy"
  | "moved"
  | "orphaned"
  | "transitioning"
  | "unregistered";

export type ManagedRecoveryOperation =
  | { readonly operation: "newCheckout"; readonly path: string }
  | { readonly operation: "rebindCheckout"; readonly checkoutId: string; readonly path: string }
  | { readonly operation: "adoptCheckout"; readonly checkoutId: string; readonly path: string }
  | { readonly operation: "adoptContext"; readonly contextId: string; readonly branch: string }
  | { readonly operation: "prune"; readonly recordIds: ReadonlyArray<string> };

export interface ManagedWorkspaceDiscoveryWorkspace {
  readonly checkoutKind: ManagedCheckoutKind;
  readonly canonicalPath: string;
  readonly workspaceRoot: string;
  readonly projectIdentityLocation: string;
  readonly checkoutIdentityLocation: string;
}

export interface ManagedWorkspaceDiscoveryContext {
  readonly kind: ManagedContextKind;
  readonly branch?: string;
  readonly commit?: string;
}

export interface ManagedWorkspaceDiscoveryIdentity {
  readonly projectId?: string;
  readonly checkoutId?: string;
  readonly contextId?: string;
}

/** Evidence from an ordinary-folder marker found beside a Git checkout. */
export interface ManagedOrdinaryMarkerEvidence {
  readonly path: string;
  readonly present: boolean;
  readonly identity?: ManagedWorkspaceDiscoveryIdentity;
}

/** One exact live ordinary-folder claim eligible for folder-to-Git migration. */
export interface ManagedFolderToGitClaim {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextId: string;
  readonly canonicalPath: string;
}

export interface ManagedBranchOwnerEvidence {
  readonly contextId?: string;
  readonly authoritativeOwnerBranch?: string;
  readonly claims: ReadonlyArray<{
    readonly branch: string;
    readonly contextId: string;
    readonly live: boolean;
  }>;
}

export type ManagedHistoricalPathProbe = "missing" | "same" | "recycled" | "inaccessible";

export interface ManagedHistoricalPathEvidence {
  readonly path: string;
  readonly locationState: ManagedCheckoutLocation["state"];
  readonly probe: ManagedHistoricalPathProbe;
}

export interface ManagedWorkspaceDiscovery {
  readonly state: ManagedWorkspaceDiscoveryState;
  readonly workspace: ManagedWorkspaceDiscoveryWorkspace;
  readonly context: ManagedWorkspaceDiscoveryContext;
  readonly contextDescriptor: ManagedContextDescriptor;
  readonly identity: ManagedWorkspaceDiscoveryIdentity;
  /** Ordinary marker is evidence only; it never becomes the active Git identity. */
  readonly ordinaryMarker?: ManagedOrdinaryMarkerEvidence;
  /** Exact live ordinary-folder claims eligible for one folder-to-Git migration. */
  readonly folderToGitClaims: ReadonlyArray<ManagedFolderToGitClaim>;
  readonly registryContextId?: string;
  readonly stacks: ReadonlyArray<ManagedStackProjection>;
  readonly locations: ReadonlyArray<ManagedCheckoutLocation>;
  /** Registry claims by another checkout at the inspected canonical path. */
  readonly conflictingLocations?: ReadonlyArray<ManagedCheckoutLocation>;
  readonly ownerEvidence?: ManagedBranchOwnerEvidence;
  readonly activeOperations: ReadonlyArray<ManagedOperationRecord>;
  readonly activeTransition?: ManagedIdentityTransitionRecord;
  readonly conflicts: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly recoveryOperations: ReadonlyArray<ManagedRecoveryOperation>;
  /** Previous claimed paths whose ownership could not be verified safely. */
  readonly inaccessiblePaths?: ReadonlyArray<string>;
  /** Probes of previous locations used to guard identity recovery transitions. */
  readonly historicalPathEvidence?: ReadonlyArray<ManagedHistoricalPathEvidence>;
}

const checkoutKindOf = (inspection: GitCheckoutInspection): ManagedCheckoutKind =>
  inspection.checkoutKind === "primary" ? "git" : inspection.checkoutKind;

const completeIdentity = (
  identity: ManagedWorkspaceDiscoveryIdentity,
): identity is ManagedIdentityTriple =>
  identity.projectId !== undefined &&
  identity.checkoutId !== undefined &&
  identity.contextId !== undefined;

const NEW_CHECKOUT_ORDINARY_TOPOLOGY = "topology:ordinary";
const NEW_CHECKOUT_DETACHED_TOPOLOGY = "topology:detached";

const newCheckoutTopologyMatches = (
  transition: ManagedIdentityTransitionRecord,
  context: ManagedWorkspaceDiscoveryContext,
): boolean => {
  if (context.kind === "branch") return transition.branch === context.branch;
  return (
    transition.branch === undefined &&
    transition.expectedGitValue ===
      (context.kind === "workspace"
        ? NEW_CHECKOUT_ORDINARY_TOPOLOGY
        : NEW_CHECKOUT_DETACHED_TOPOLOGY)
  );
};

const transitionMatches = (
  transition: ManagedIdentityTransitionRecord,
  identity: ManagedWorkspaceDiscoveryIdentity,
  context: ManagedWorkspaceDiscoveryContext,
  workspaceRoot: string,
): boolean => {
  if (transition.phase === "finalized") return false;
  if (transition.kind === "new-checkout") {
    return transition.path === workspaceRoot && newCheckoutTopologyMatches(transition, context);
  }
  const branch = context.kind === "branch" ? context.branch : undefined;
  return (
    (transition.kind !== "folder-to-git" || transition.branch === branch) &&
    ((transition.projectId === identity.projectId &&
      transition.checkoutId === undefined &&
      transition.contextId === undefined &&
      transition.branch === undefined &&
      transition.path === undefined) ||
      transition.path === workspaceRoot ||
      (transition.checkoutId !== undefined && transition.checkoutId === identity.checkoutId) ||
      (transition.contextId !== undefined && transition.contextId === identity.contextId) ||
      (transition.branch !== undefined &&
        transition.branch === branch &&
        transition.projectId === identity.projectId))
  );
};

const matchingStacks = (
  repository: ManagedStackRepositoryShape,
  identity: ManagedWorkspaceDiscoveryIdentity,
): Effect.Effect<ReadonlyArray<ManagedStackProjection>> =>
  completeIdentity(identity) ? repository.listStackProjections({ identity }) : Effect.succeed([]);

const projectIdentityClaims = (
  allClaims: ManagedIdentityClaims,
  identity: ManagedWorkspaceDiscoveryIdentity,
): ManagedIdentityClaims => {
  if (identity.projectId === undefined) return allClaims;
  const checkoutProjects = allClaims.checkoutProjects.filter(
    (checkout) => checkout.projectId === identity.projectId,
  );
  const contexts = allClaims.contexts.filter((context) => context.projectId === identity.projectId);
  const checkoutIds = new Set(checkoutProjects.map((checkout) => checkout.checkoutId));
  const contextIds = new Set(contexts.map((context) => context.id));
  return {
    checkoutProjects,
    locations: allClaims.locations.filter((location) => checkoutIds.has(location.checkoutId)),
    contexts,
    transitions: allClaims.transitions.filter(
      (transition) =>
        transition.projectId === identity.projectId ||
        (transition.checkoutId !== undefined && checkoutIds.has(transition.checkoutId)) ||
        (transition.contextId !== undefined && contextIds.has(transition.contextId)),
    ),
  };
};

interface WorkspaceClassificationEvidence {
  readonly activeTransition?: ManagedIdentityTransitionRecord;
  readonly duplicateLocations: boolean;
  readonly samePathClaims: number;
  readonly markerRegistryConflict: boolean;
  readonly sameCheckoutReappeared: boolean;
  readonly inaccessiblePaths: number;
  readonly recycledPaths: number;
  readonly authoritativeOwnerBranch?: string;
  readonly contextKind: ManagedWorkspaceDiscoveryContext["kind"];
  readonly currentBranch?: string;
  readonly authoritativeOwnerLive: boolean;
  readonly liveOwnerClaims: ReadonlyArray<{ readonly branch: string }>;
  readonly currentLocation?: ManagedCheckoutLocation;
  readonly anyActiveLocation?: ManagedCheckoutLocation;
  readonly folderToGitClaims: number;
  readonly gitCheckout: boolean;
  readonly identity: ManagedWorkspaceDiscoveryIdentity;
  readonly checkoutProjectKnown: boolean;
  readonly checkoutProjectOwnership: "unknown" | "matching" | "foreign";
  readonly contextPresent: boolean;
  readonly locationCount: number;
  readonly activeLocation?: ManagedCheckoutLocation;
  readonly workspaceRoot: string;
  readonly canonicalPath: string;
}

interface WorkspaceClassification {
  readonly state: ManagedWorkspaceDiscoveryState;
  readonly conflicts: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly recoveryOperations: ReadonlyArray<ManagedRecoveryOperation>;
}

const classifyWorkspace = (evidence: WorkspaceClassificationEvidence): WorkspaceClassification => {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const recoveryOperations: ManagedRecoveryOperation[] = [];
  const identityComplete = completeIdentity(evidence.identity);
  const knownCheckoutActiveElsewhere =
    evidence.identity.projectId === undefined &&
    evidence.checkoutProjectKnown &&
    evidence.activeLocation === undefined &&
    evidence.anyActiveLocation !== undefined;
  const knownCheckoutMissingProjectAtActivePath =
    evidence.identity.projectId === undefined &&
    evidence.checkoutProjectKnown &&
    evidence.activeLocation !== undefined;
  let state: ManagedWorkspaceDiscoveryState;
  if (evidence.activeTransition !== undefined) {
    state = "transitioning";
    warnings.push(
      `Identity transition ${evidence.activeTransition.id} is ${evidence.activeTransition.phase}`,
    );
  } else if (
    evidence.duplicateLocations ||
    evidence.samePathClaims > 0 ||
    evidence.markerRegistryConflict ||
    knownCheckoutActiveElsewhere ||
    knownCheckoutMissingProjectAtActivePath ||
    evidence.checkoutProjectOwnership === "foreign" ||
    evidence.sameCheckoutReappeared ||
    evidence.inaccessiblePaths > 0 ||
    evidence.recycledPaths > 0 ||
    (evidence.authoritativeOwnerBranch !== undefined &&
      evidence.contextKind === "branch" &&
      evidence.authoritativeOwnerBranch !== evidence.currentBranch &&
      evidence.authoritativeOwnerLive) ||
    evidence.currentLocation?.state === "blocked" ||
    (evidence.currentLocation?.state === "superseded" &&
      evidence.anyActiveLocation !== undefined &&
      evidence.anyActiveLocation.id !== evidence.currentLocation.id)
  ) {
    state = "duplicate";
    conflicts.push(
      evidence.duplicateLocations
        ? `Checkout ${evidence.identity.checkoutId} has multiple active locations`
        : evidence.markerRegistryConflict
          ? "Workspace marker context conflicts with registry context"
          : knownCheckoutActiveElsewhere
            ? `Checkout ${evidence.identity.checkoutId} is already active at another path`
            : knownCheckoutMissingProjectAtActivePath
              ? `Checkout ${evidence.identity.checkoutId} is missing its registered project marker`
              : evidence.checkoutProjectOwnership === "foreign"
                ? `Checkout ${evidence.identity.checkoutId} belongs to another project`
                : `Workspace path ${evidence.canonicalPath} is claimed by another checkout`,
    );
  } else if (
    evidence.authoritativeOwnerBranch === undefined &&
    evidence.liveOwnerClaims.length > 1
  ) {
    state = "ambiguous";
    conflicts.push(`Context ${evidence.identity.contextId} is claimed by multiple live branches`);
  } else if (
    evidence.authoritativeOwnerBranch !== undefined &&
    evidence.contextKind === "branch" &&
    evidence.currentBranch !== evidence.authoritativeOwnerBranch &&
    !evidence.authoritativeOwnerLive &&
    evidence.liveOwnerClaims.length === 1 &&
    evidence.liveOwnerClaims[0]?.branch === evidence.currentBranch
  ) {
    state = "adoptable";
    warnings.push("Authoritative branch owner is absent; branch adoption is required");
    if (evidence.identity.contextId !== undefined && evidence.currentBranch !== undefined) {
      recoveryOperations.push({
        operation: "adoptContext",
        contextId: evidence.identity.contextId,
        branch: evidence.currentBranch,
      });
    }
  } else if (
    evidence.authoritativeOwnerBranch !== undefined &&
    evidence.contextKind === "branch" &&
    evidence.currentBranch !== evidence.authoritativeOwnerBranch &&
    !evidence.authoritativeOwnerLive &&
    evidence.liveOwnerClaims.length > 1
  ) {
    state = "ambiguous";
    conflicts.push(`Context ${evidence.identity.contextId} has multiple plausible live owners`);
  } else if (evidence.folderToGitClaims > 1) {
    state = "duplicate";
    conflicts.push("Multiple live ordinary-folder claims match this Git checkout path");
  } else if (evidence.folderToGitClaims === 1 && evidence.gitCheckout && !identityComplete) {
    state = "adoptable";
    warnings.push("An exact ordinary-folder claim can be migrated into Git-owned identity");
  } else if (
    evidence.contextKind === "branch" &&
    evidence.currentBranch !== undefined &&
    identityComplete &&
    evidence.contextPresent &&
    evidence.authoritativeOwnerBranch === undefined
  ) {
    state = "orphaned";
    warnings.push("Branch context has no authoritative owner; recovery is required");
    recoveryOperations.push({
      operation: "adoptContext",
      contextId: evidence.identity.contextId,
      branch: evidence.currentBranch,
    });
  } else if (
    identityComplete &&
    evidence.activeLocation === undefined &&
    evidence.anyActiveLocation !== undefined
  ) {
    state = "moved";
    recoveryOperations.push({
      operation: "rebindCheckout",
      checkoutId: evidence.identity.checkoutId,
      path: evidence.workspaceRoot,
    });
  } else if (
    identityComplete &&
    ((!evidence.contextPresent && evidence.locationCount > 0) ||
      (evidence.authoritativeOwnerBranch !== undefined && evidence.liveOwnerClaims.length === 0))
  ) {
    state = "orphaned";
    if (
      evidence.contextKind === "branch" &&
      evidence.currentBranch !== undefined &&
      evidence.identity.contextId !== undefined
    ) {
      recoveryOperations.push({
        operation: "adoptContext",
        contextId: evidence.identity.contextId,
        branch: evidence.currentBranch,
      });
    }
  } else if (identityComplete && evidence.activeLocation !== undefined) {
    state = "healthy";
  } else if (
    evidence.identity.checkoutId !== undefined &&
    evidence.identity.contextId !== undefined &&
    evidence.locationCount > 0
  ) {
    state = "adoptable";
    recoveryOperations.push({
      operation: "adoptCheckout",
      checkoutId: evidence.identity.checkoutId,
      path: evidence.workspaceRoot,
    });
  } else if (
    !identityComplete ||
    (evidence.locationCount === 0 &&
      evidence.activeLocation === undefined &&
      evidence.anyActiveLocation === undefined &&
      evidence.checkoutProjectOwnership === "unknown" &&
      (!evidence.contextPresent || (evidence.gitCheckout && evidence.contextKind === "branch")))
  ) {
    state = "unregistered";
    recoveryOperations.push({ operation: "newCheckout", path: evidence.workspaceRoot });
  } else {
    state = "duplicate";
    conflicts.push("Workspace evidence does not match a recoverable identity state");
  }
  return { state, conflicts, warnings, recoveryOperations };
};

type PreviousLocationProbe = ManagedHistoricalPathProbe;

const probePreviousLocation = (
  fs: FileSystem.FileSystem,
  path: string,
  checkoutId: string,
): Effect.Effect<PreviousLocationProbe, never, FileSystem.FileSystem | GitConfigStore> =>
  Effect.gen(function* () {
    const stat = yield* fs.stat(path).pipe(
      Effect.as<"exists">("exists"),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed<PreviousLocationProbe>("missing")
          : Effect.succeed<PreviousLocationProbe>("inaccessible"),
      ),
    );
    if (stat !== "exists") return stat;
    const inspection = yield* Effect.exit(inspectWorkspace(path));
    if (inspection._tag === "Failure") return "inaccessible";
    if (inspection.value.kind === "ordinary-folder") {
      const marker = yield* Effect.exit(readOrdinaryWorkspaceIdentityWithFileSystem(path));
      return marker._tag === "Success" && marker.value?.checkoutId === checkoutId
        ? "same"
        : marker._tag === "Failure"
          ? "inaccessible"
          : "recycled";
    }
    const marker = yield* Effect.exit(readGitCheckoutIdentityWithFileSystem(inspection.value));
    return marker._tag === "Success" && marker.value.checkoutId === checkoutId
      ? "same"
      : marker._tag === "Failure"
        ? "inaccessible"
        : "recycled";
  });

const inspectBranchOwners = (
  inspection: GitCheckoutInspection,
  contextId: string | undefined,
): Effect.Effect<
  ManagedBranchOwnerEvidence,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  FileSystem.FileSystem | GitConfigStore
> =>
  Effect.gen(function* () {
    const store = yield* GitConfigStore;
    const claims =
      contextId === undefined
        ? []
        : (yield* store.getRegexp(
            gitConfigPath(inspection.commonDirectory),
            "^branch\\..*\\.supabaseContextId$",
          ))
            .filter((match) => match.value === contextId)
            .map((match) => match.key.slice("branch.".length, -".supabaseContextId".length));
    const liveClaims: Array<{
      readonly branch: string;
      readonly contextId: string;
      readonly live: boolean;
    }> = [];
    const fs = yield* FileSystem.FileSystem;
    for (const branch of claims) {
      liveClaims.push({
        branch,
        contextId: contextId ?? "",
        live:
          (inspection.head.kind === "unborn" && inspection.head.branch === branch) ||
          (yield* branchRefExists(fs, inspection.commonDirectory, `refs/heads/${branch}`).pipe(
            Effect.catchTag("PlatformError", (error: PlatformError.PlatformError) =>
              Effect.fail(
                new UnsupportedGitWorkspaceError({
                  path: inspection.commonDirectory,
                  reason: `Git refs are inaccessible (${error.message})`,
                  workspaceCause: "metadata-inaccessible",
                }),
              ),
            ),
          )),
      });
    }
    return { contextId, claims: liveClaims };
  });

const workspaceMetadata = (
  inspection: WorkspaceInspection,
): {
  readonly workspace: ManagedWorkspaceDiscoveryWorkspace;
  readonly context: ManagedWorkspaceDiscoveryContext;
  readonly contextDescriptor: ManagedContextDescriptor;
} => {
  if (inspection.kind === "ordinary-folder") {
    const markerPath = ordinaryWorkspaceIdentityPath(inspection.canonicalPath);
    return {
      workspace: {
        checkoutKind: "ordinary",
        canonicalPath: inspection.canonicalPath,
        workspaceRoot: inspection.canonicalPath,
        projectIdentityLocation: markerPath,
        checkoutIdentityLocation: markerPath,
      },
      context: { kind: "workspace" },
      contextDescriptor: { kind: "workspace" },
    };
  }
  const context: ManagedWorkspaceDiscoveryContext =
    inspection.head.kind === "detached"
      ? { kind: "detached", commit: inspection.head.commit }
      : { kind: "branch", branch: inspection.head.branch };
  const contextDescriptor: ManagedContextDescriptor =
    inspection.head.kind === "detached"
      ? { kind: "detached" }
      : { kind: "branch", locator: inspection.head.branch };
  return {
    workspace: {
      checkoutKind: checkoutKindOf(inspection),
      canonicalPath: inspection.canonicalPath,
      workspaceRoot: inspection.workspaceRoot,
      projectIdentityLocation: inspection.commonDirectory,
      checkoutIdentityLocation: inspection.gitDirectory,
    },
    context,
    contextDescriptor,
  };
};

/** Read-only managed identity discovery. No repository or identity writes occur. */
export const discoverWorkspace = (
  workspacePath: string,
): Effect.Effect<
  ManagedWorkspaceDiscovery,
  InvalidManagedIdentityError | UnsupportedGitWorkspaceError,
  FileSystem.FileSystem | GitConfigStore | ManagedStackRepository
> =>
  Effect.gen(function* () {
    const repository = yield* ManagedStackRepository;
    const canonicalPath = yield* canonicalizeManagedWorkspacePathWithFileSystem(workspacePath);
    const inspection = yield* inspectWorkspace(canonicalPath);
    const metadata = workspaceMetadata(inspection);
    let identity: ManagedWorkspaceDiscoveryIdentity = {};
    let registryContextId: string | undefined;
    let ownerEvidence: ManagedBranchOwnerEvidence | undefined;
    let ordinaryMarker: ManagedOrdinaryMarkerEvidence | undefined;

    if (inspection.kind === "ordinary-folder") {
      const marker = yield* readOrdinaryWorkspaceIdentityWithFileSystem(canonicalPath);
      identity =
        marker === undefined
          ? {}
          : {
              projectId: marker.projectId,
              checkoutId: marker.checkoutId,
              contextId: marker.contextId,
            };
      if (marker?.checkoutId !== undefined) {
        const context = yield* repository.findCheckoutContext(marker.checkoutId, "workspace");
        registryContextId = context?.id;
      }
    } else {
      // A tracked `.supabase/identity.json` can be left behind by a folder
      // becoming a repository. It is read as transition evidence only; its
      // values never populate the active Git identity below.
      const markerPath = ordinaryWorkspaceIdentityPath(canonicalPath);
      const fs = yield* FileSystem.FileSystem;
      const markerExists = yield* fs
        .exists(markerPath)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
      const marker = yield* Effect.exit(readOrdinaryWorkspaceIdentityWithFileSystem(canonicalPath));
      ordinaryMarker = {
        path: markerPath,
        present: markerExists,
        identity: marker._tag === "Success" ? marker.value : undefined,
      };
      const stored = yield* readGitCheckoutIdentityWithFileSystem(inspection);
      const contextId =
        inspection.head.kind === "detached"
          ? undefined
          : yield* readBranchContextId(inspection, inspection.head.branch);
      identity = { projectId: stored.projectId, checkoutId: stored.checkoutId, contextId };
      if (inspection.head.kind === "detached" && stored.checkoutId !== undefined) {
        const context = yield* repository.findCheckoutContext(stored.checkoutId, "detached");
        registryContextId = context?.id;
        if (context !== undefined) identity = { ...identity, contextId: context.id };
      }
      if (metadata.context.kind === "branch") {
        ownerEvidence = yield* inspectBranchOwners(inspection, contextId);
      }
    }

    const allClaims = yield* repository.listIdentityClaims();
    const claims = projectIdentityClaims(allClaims, identity);
    const claimedCheckoutProject =
      identity.checkoutId === undefined
        ? undefined
        : allClaims.checkoutProjects.find((checkout) => checkout.checkoutId === identity.checkoutId)
            ?.projectId;
    const checkoutProjectOwnership =
      identity.projectId === undefined || claimedCheckoutProject === undefined
        ? "unknown"
        : claimedCheckoutProject === identity.projectId
          ? "matching"
          : "foreign";
    // A new-checkout transition is reserved before the marker has an identity,
    // so its project scope is intentionally empty. Read the complete transition
    // set when a marker now supplies a project ID; otherwise an interrupted
    // publication would disappear from discovery instead of remaining resumable.
    const folderToGitClaims: ReadonlyArray<ManagedFolderToGitClaim> =
      inspection.kind === "git-checkout"
        ? allClaims.locations
            .filter(
              (location) =>
                location.state === "active" &&
                location.canonicalPath === metadata.workspace.workspaceRoot,
            )
            .flatMap((location) => {
              const context = allClaims.contexts.find(
                (candidate) =>
                  candidate.checkoutId === location.checkoutId && candidate.kind === "workspace",
              );
              return context === undefined
                ? []
                : [
                    {
                      projectId: context.projectId,
                      checkoutId: location.checkoutId,
                      contextId: context.id,
                      canonicalPath: location.canonicalPath,
                    },
                  ];
            })
        : [];
    const locations =
      identity.checkoutId === undefined
        ? claims.locations
        : claims.locations.filter((location) => location.checkoutId === identity.checkoutId);
    const folderClaimCheckoutIds = new Set(folderToGitClaims.map((claim) => claim.checkoutId));
    const samePathClaims = allClaims.locations.filter(
      (location) =>
        location.canonicalPath === metadata.workspace.workspaceRoot &&
        location.checkoutId !== identity.checkoutId &&
        !folderClaimCheckoutIds.has(location.checkoutId),
    );

    const stacks = yield* matchingStacks(repository, identity);
    const stackIds = new Set(stacks.map((stack) => stack.id));
    const activeOperations = (yield* repository.listActiveOperations()).filter((operation) =>
      stackIds.has(operation.stackId),
    );
    const activeTransition = allClaims.transitions.find((transition) =>
      transitionMatches(transition, identity, metadata.context, metadata.workspace.workspaceRoot),
    );

    const activeLocation = locations.find(
      (location) =>
        location.state === "active" && location.canonicalPath === metadata.workspace.workspaceRoot,
    );
    const currentLocation = locations.find(
      (location) => location.canonicalPath === metadata.workspace.workspaceRoot,
    );
    const anyActiveLocation = locations.find((location) => location.state === "active");
    const previousPathProbes: ReadonlyArray<{
      readonly path: string;
      readonly locationState: ManagedCheckoutLocation["state"];
      readonly result: PreviousLocationProbe;
    }> = completeIdentity(identity)
      ? yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const probes: Array<{
            readonly path: string;
            readonly locationState: ManagedCheckoutLocation["state"];
            readonly result: PreviousLocationProbe;
          }> = [];
          const candidates =
            activeLocation === undefined
              ? locations.filter((candidate) => candidate.state === "active")
              : locations.filter(
                  (candidate) => candidate.state === "superseded" || candidate.state === "blocked",
                );
          for (const location of candidates.filter(
            (candidate) => candidate.canonicalPath !== metadata.workspace.workspaceRoot,
          )) {
            probes.push({
              path: location.canonicalPath,
              locationState: location.state,
              result: yield* probePreviousLocation(fs, location.canonicalPath, identity.checkoutId),
            });
          }
          return probes;
        })
      : [];
    const inaccessiblePaths = previousPathProbes
      .filter((probe) => probe.result === "inaccessible")
      .map((probe) => probe.path);
    const recycledPaths = previousPathProbes
      .filter((probe) => probe.result === "recycled")
      .map((probe) => probe.path);
    const sameCheckoutReappeared = previousPathProbes.some((probe) => probe.result === "same");
    const historicalPathEvidence = previousPathProbes.map(({ path, locationState, result }) => ({
      path,
      locationState,
      probe: result,
    }));
    const sameContextClaims =
      identity.contextId === undefined
        ? []
        : claims.contexts.filter((context) => context.id === identity.contextId);
    const context = sameContextClaims[0];
    const markerRegistryConflict =
      inspection.kind === "ordinary-folder" &&
      registryContextId !== undefined &&
      identity.contextId !== undefined &&
      registryContextId !== identity.contextId;
    const currentBranch = metadata.context.kind === "branch" ? metadata.context.branch : undefined;
    if (ownerEvidence !== undefined && context?.ownerBranch !== undefined) {
      ownerEvidence = { ...ownerEvidence, authoritativeOwnerBranch: context.ownerBranch };
    }
    const liveOwnerClaims = ownerEvidence?.claims.filter((claim) => claim.live) ?? [];
    const authoritativeOwnerLive =
      ownerEvidence?.authoritativeOwnerBranch === undefined
        ? false
        : ownerEvidence.claims.some(
            (claim) => claim.branch === ownerEvidence?.authoritativeOwnerBranch && claim.live,
          );
    const duplicateLocations =
      identity.checkoutId !== undefined
        ? locations.filter((location) => location.state === "active").length > 1
        : false;
    const classification = classifyWorkspace({
      activeTransition,
      duplicateLocations,
      samePathClaims: samePathClaims.length,
      markerRegistryConflict,
      sameCheckoutReappeared,
      inaccessiblePaths: inaccessiblePaths.length,
      recycledPaths: recycledPaths.length,
      authoritativeOwnerBranch: ownerEvidence?.authoritativeOwnerBranch,
      contextKind: metadata.context.kind,
      currentBranch,
      authoritativeOwnerLive,
      liveOwnerClaims,
      currentLocation,
      anyActiveLocation,
      folderToGitClaims: folderToGitClaims.length,
      gitCheckout: inspection.kind === "git-checkout",
      identity,
      checkoutProjectKnown: claimedCheckoutProject !== undefined,
      checkoutProjectOwnership,
      contextPresent: context !== undefined,
      locationCount: locations.length,
      activeLocation,
      workspaceRoot: metadata.workspace.workspaceRoot,
      canonicalPath,
    });
    const { state } = classification;
    const conflicts = [...classification.conflicts];
    const warnings = [...classification.warnings];
    const recoveryOperations = [...classification.recoveryOperations];
    const protectedLocationIds = protectedManagedCheckoutLocationIds({
      locations,
      transitions: allClaims.transitions,
    });
    if (activeTransition === undefined && conflicts.length === 0) {
      const pruneRecordIds = historicalPathEvidence
        .filter(
          (evidence) => evidence.locationState === "superseded" && evidence.probe === "missing",
        )
        .flatMap((evidence) => {
          const location = locations.find(
            (candidate) =>
              candidate.canonicalPath === evidence.path && candidate.state === "superseded",
          );
          return location === undefined || protectedLocationIds.has(location.id)
            ? []
            : [location.id];
        });
      if (pruneRecordIds.length > 0) {
        recoveryOperations.push({ operation: "prune", recordIds: pruneRecordIds });
      }
    }
    if (ownerEvidence !== undefined && context?.ownerBranch !== undefined) {
      if (metadata.context.kind === "branch" && context.ownerBranch !== metadata.context.branch) {
        warnings.push(
          `Authoritative owner is ${context.ownerBranch}, current branch is ${metadata.context.branch}`,
        );
      }
    }
    return {
      state,
      ...metadata,
      identity,
      ordinaryMarker,
      folderToGitClaims,
      registryContextId,
      stacks,
      locations,
      conflictingLocations: samePathClaims.length === 0 ? undefined : samePathClaims,
      ownerEvidence,
      activeOperations,
      activeTransition,
      conflicts,
      warnings,
      recoveryOperations,
      inaccessiblePaths: inaccessiblePaths.length === 0 ? undefined : inaccessiblePaths,
      historicalPathEvidence:
        historicalPathEvidence.length === 0 ? undefined : historicalPathEvidence,
    };
  });
