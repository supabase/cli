import { Effect, FileSystem, type PlatformError } from "effect";
import {
  InvalidManagedIdentityError,
  UnsupportedGitWorkspaceError,
  type ManagedCheckoutLocation,
  type ManagedCheckoutKind,
  type ManagedContextDescriptor,
  type ManagedContextKind,
  type ManagedIdentityTransitionRecord,
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
import { ManagedStackRepository, type ManagedStackRepositoryShape } from "./repository.ts";

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

export interface ManagedBranchOwnerEvidence {
  readonly contextId?: string;
  readonly authoritativeOwnerBranch?: string;
  readonly claims: ReadonlyArray<{
    readonly branch: string;
    readonly contextId: string;
    readonly live: boolean;
  }>;
}

export interface ManagedWorkspaceDiscovery {
  readonly state: ManagedWorkspaceDiscoveryState;
  readonly workspace: ManagedWorkspaceDiscoveryWorkspace;
  readonly context: ManagedWorkspaceDiscoveryContext;
  readonly contextDescriptor: ManagedContextDescriptor;
  readonly identity: ManagedWorkspaceDiscoveryIdentity;
  readonly registryContextId?: string;
  readonly stacks: ReadonlyArray<ManagedStackProjection>;
  readonly locations: ReadonlyArray<ManagedCheckoutLocation>;
  readonly ownerEvidence?: ManagedBranchOwnerEvidence;
  readonly activeOperations: ReadonlyArray<ManagedOperationRecord>;
  readonly activeTransition?: ManagedIdentityTransitionRecord;
  readonly conflicts: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly recoveryOperations: ReadonlyArray<ManagedRecoveryOperation>;
}

const checkoutKindOf = (inspection: GitCheckoutInspection): ManagedCheckoutKind =>
  inspection.checkoutKind === "primary" ? "git" : inspection.checkoutKind;

const completeIdentity = (
  identity: ManagedWorkspaceDiscoveryIdentity,
): identity is ManagedIdentityTriple =>
  identity.projectId !== undefined &&
  identity.checkoutId !== undefined &&
  identity.contextId !== undefined;

const transitionMatches = (
  transition: ManagedIdentityTransitionRecord,
  identity: ManagedWorkspaceDiscoveryIdentity,
  branch: string | undefined,
  workspaceRoot: string,
): boolean =>
  transition.phase !== "finalized" &&
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
      transition.projectId === identity.projectId));

const matchingStacks = (
  repository: ManagedStackRepositoryShape,
  identity: ManagedWorkspaceDiscoveryIdentity,
): Effect.Effect<ReadonlyArray<ManagedStackProjection>> =>
  completeIdentity(identity) ? repository.listStackProjections({ identity }) : Effect.succeed([]);

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

    const claims = yield* repository.listIdentityClaims(identity.projectId);
    const locations =
      identity.checkoutId === undefined
        ? claims.locations
        : claims.locations.filter((location) => location.checkoutId === identity.checkoutId);
    const samePathClaims = claims.locations.filter(
      (location) =>
        location.canonicalPath === metadata.workspace.workspaceRoot &&
        location.checkoutId !== identity.checkoutId,
    );

    const stacks = yield* matchingStacks(repository, identity);
    const stackIds = new Set(stacks.map((stack) => stack.id));
    const activeOperations = (yield* repository.listActiveOperations()).filter((operation) =>
      stackIds.has(operation.stackId),
    );
    const activeTransition = claims.transitions.find((transition) =>
      transitionMatches(
        transition,
        identity,
        metadata.context.kind === "branch" ? metadata.context.branch : undefined,
        metadata.workspace.workspaceRoot,
      ),
    );

    const conflicts: string[] = [];
    const warnings: string[] = [];
    const recoveryOperations: ManagedRecoveryOperation[] = [];
    const activeLocation = locations.find(
      (location) =>
        location.state === "active" && location.canonicalPath === metadata.workspace.workspaceRoot,
    );
    const currentLocation = locations.find(
      (location) => location.canonicalPath === metadata.workspace.workspaceRoot,
    );
    const anyActiveLocation = locations.find((location) => location.state === "active");
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
    let state: ManagedWorkspaceDiscoveryState;
    if (activeTransition !== undefined) {
      state = "transitioning";
      warnings.push(`Identity transition ${activeTransition.id} is ${activeTransition.phase}`);
    } else if (
      duplicateLocations ||
      samePathClaims.length > 0 ||
      markerRegistryConflict ||
      (ownerEvidence?.authoritativeOwnerBranch !== undefined &&
        metadata.context.kind === "branch" &&
        ownerEvidence.authoritativeOwnerBranch !== metadata.context.branch &&
        authoritativeOwnerLive) ||
      currentLocation?.state === "blocked" ||
      (currentLocation?.state === "superseded" &&
        anyActiveLocation !== undefined &&
        anyActiveLocation.id !== currentLocation.id)
    ) {
      state = "duplicate";
      conflicts.push(
        duplicateLocations
          ? `Checkout ${identity.checkoutId} has multiple active locations`
          : markerRegistryConflict
            ? `Workspace marker context conflicts with registry context`
            : `Workspace path ${canonicalPath} is claimed by another checkout`,
      );
    } else if (
      ownerEvidence?.authoritativeOwnerBranch === undefined &&
      liveOwnerClaims.length > 1
    ) {
      state = "ambiguous";
      conflicts.push(`Context ${identity.contextId} is claimed by multiple live branches`);
    } else if (
      ownerEvidence?.authoritativeOwnerBranch !== undefined &&
      metadata.context.kind === "branch" &&
      metadata.context.branch !== ownerEvidence.authoritativeOwnerBranch &&
      !authoritativeOwnerLive
    ) {
      state = "adoptable";
      warnings.push("Authoritative branch owner is absent; branch adoption is required");
      if (identity.contextId !== undefined && metadata.context.branch !== undefined) {
        recoveryOperations.push({
          operation: "adoptContext",
          contextId: identity.contextId,
          branch: metadata.context.branch,
        });
      }
    } else if (
      metadata.context.kind === "branch" &&
      currentBranch !== undefined &&
      completeIdentity(identity) &&
      context !== undefined &&
      context.ownerBranch === undefined
    ) {
      state = "orphaned";
      warnings.push("Branch context has no authoritative owner; recovery is required");
      recoveryOperations.push({
        operation: "adoptContext",
        contextId: identity.contextId,
        branch: currentBranch,
      });
    } else if (
      completeIdentity(identity) &&
      activeLocation === undefined &&
      anyActiveLocation !== undefined
    ) {
      state = "moved";
      recoveryOperations.push({
        operation: "rebindCheckout",
        checkoutId: identity.checkoutId,
        path: metadata.workspace.workspaceRoot,
      });
    } else if (
      completeIdentity(identity) &&
      (context === undefined || (ownerEvidence !== undefined && liveOwnerClaims.length === 0))
    ) {
      state = "orphaned";
      if (
        metadata.context.kind === "branch" &&
        metadata.context.branch !== undefined &&
        identity.contextId !== undefined
      ) {
        recoveryOperations.push({
          operation: "adoptContext",
          contextId: identity.contextId,
          branch: metadata.context.branch,
        });
      }
    } else if (completeIdentity(identity) && activeLocation !== undefined) {
      state = "healthy";
    } else if (
      identity.checkoutId !== undefined &&
      identity.contextId !== undefined &&
      locations.length > 0
    ) {
      state = "adoptable";
      if (identity.checkoutId !== undefined) {
        recoveryOperations.push({
          operation: "adoptCheckout",
          checkoutId: identity.checkoutId,
          path: metadata.workspace.workspaceRoot,
        });
      }
    } else {
      state = "unregistered";
      recoveryOperations.push({ operation: "newCheckout", path: metadata.workspace.workspaceRoot });
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
      registryContextId,
      stacks,
      locations,
      ownerEvidence,
      activeOperations,
      activeTransition,
      conflicts,
      warnings,
      recoveryOperations,
    };
  });
