import { Context, type Effect } from "effect";
import {
  DuplicateManagedPortKeyError,
  InvalidManagedOwnerPidError,
  InvalidManagedPortError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  DuplicateManagedIdentityError,
  ManagedCheckoutConflictError,
  ManagedCopiedBranchConflictError,
  ManagedIdentityTransitionOwnershipError,
  ManagedInaccessiblePathError,
  type ManagedIdentityClaims,
  type ManagedIdentityTransitionKind,
  type ManagedIdentityTransitionPhase,
  type ManagedIdentityTransitionRecord,
  type ManagedCheckoutKind,
  type ManagedCheckoutLocation,
  type ManagedCheckoutScopedContextKind,
  type ManagedContextDescriptor,
  type ManagedContextRecord,
  type ManagedIdentityTriple,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedPortAssignment,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackPaths,
  type ManagedStackProjection,
  type ManagedStackRecord,
} from "./model.ts";
import type { ManagedOperationOwnershipError } from "./model.ts";

export interface ManagedContextRegistrationInput {
  readonly requestedId: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly context: ManagedContextDescriptor;
  readonly now: string;
  readonly checkoutScopedExisting?: ManagedContextRecord;
  readonly requestedExisting?: ManagedContextRecord;
}

export type ManagedContextRegistrationDecision =
  | {
      readonly outcome: "existing";
      readonly contextId: string;
      readonly refreshLocator?: string;
    }
  | { readonly outcome: "create"; readonly context: ManagedContextRecord };

/**
 * Pure policy for resolving the context a registration should use. Storage
 * adapters supply the rows they observed and apply the returned decision inside
 * their own atomic boundary.
 */
export const decideManagedContextRegistration = (
  input: ManagedContextRegistrationInput,
): ManagedContextRegistrationDecision => {
  if (input.context.kind !== "branch" && input.checkoutScopedExisting !== undefined) {
    return { outcome: "existing", contextId: input.checkoutScopedExisting.id };
  }

  const existing = input.requestedExisting;
  if (existing !== undefined) {
    const existingClaim = existing.checkoutId ?? existing.projectId;
    const requestedClaim = input.context.kind === "branch" ? input.projectId : input.checkoutId;
    if (existing.kind !== input.context.kind || existingClaim !== requestedClaim) {
      throw new DuplicateManagedIdentityError({
        identityId: input.requestedId,
        existingClaim,
        requestedClaim,
      });
    }
    return {
      outcome: "existing",
      contextId: input.requestedId,
      refreshLocator:
        input.context.kind === "branch" && existing.locator !== input.context.locator
          ? input.context.locator
          : undefined,
    };
  }

  return {
    outcome: "create",
    context: {
      id: input.requestedId,
      projectId: input.projectId,
      checkoutId: input.context.kind === "branch" ? undefined : input.checkoutId,
      kind: input.context.kind,
      locator: input.context.kind === "branch" ? input.context.locator : undefined,
      ownerBranch: input.context.kind === "branch" ? input.context.locator : undefined,
      createdAt: input.now,
    },
  };
};
export interface ApplyManagedCheckoutLocationInput {
  readonly checkoutId: string;
  readonly locationId: string;
  readonly canonicalPath: string;
  readonly now: string;
  /**
   * When returning to a superseded path, the discovery probe must identify the
   * exact active row it proved missing. The repository rechecks that CAS token
   * under its transaction so two live locations can never be recovered by
   * guesswork.
   */
  readonly expectedActiveLocationId?: string;
}

export interface ManagedCheckoutLocationDecision {
  readonly outcome: "active" | "rebound" | "blocked";
  readonly location: ManagedCheckoutLocation;
  readonly supersededLocationId?: string;
  readonly updates?: ReadonlyArray<ManagedCheckoutLocation>;
}

export interface ManagedCheckoutLocationDecisionInput {
  readonly requested: ApplyManagedCheckoutLocationInput;
  readonly checkoutLocations: ReadonlyArray<ManagedCheckoutLocation>;
  readonly checkoutExists: boolean;
}

export interface RegisterManagedCheckoutIdentityInput {
  readonly identity: ManagedIdentityTriple;
  readonly checkoutKind: ManagedCheckoutKind;
  readonly checkoutRootPath: string;
  readonly locationId: string;
  readonly context: ManagedContextDescriptor;
  readonly now: string;
}

export interface ManagedCheckoutIdentityRegistration {
  readonly identity: ManagedIdentityTriple;
  readonly checkoutKind: ManagedCheckoutKind;
  readonly contextId: string;
  readonly context: ManagedContextRecord;
  readonly location: ManagedCheckoutLocation;
}

export type ManagedCheckoutIdentityRegistrationFailure =
  | DuplicateManagedIdentityError
  | ManagedIdentityRecoveryError;

export interface ManagedCheckoutIdentityDecisionInput {
  readonly requested: RegisterManagedCheckoutIdentityInput;
  readonly existingCheckout?: { readonly projectId: string; readonly kind: ManagedCheckoutKind };
  readonly checkoutLocations: ReadonlyArray<ManagedCheckoutLocation>;
  readonly checkoutScopedExisting?: ManagedContextRecord;
  readonly requestedExisting?: ManagedContextRecord;
}

export interface ManagedCheckoutIdentityDecision {
  readonly registration: ManagedCheckoutIdentityRegistration;
  readonly locationDecision: ManagedCheckoutLocationDecision;
}

export const decideManagedCheckoutIdentity = (
  input: ManagedCheckoutIdentityDecisionInput,
): ManagedCheckoutIdentityDecision => {
  if (
    input.existingCheckout !== undefined &&
    input.existingCheckout.projectId !== input.requested.identity.projectId
  ) {
    throw new DuplicateManagedIdentityError({
      identityId: input.requested.identity.checkoutId,
      existingClaim: input.existingCheckout.projectId,
      requestedClaim: input.requested.identity.projectId,
    });
  }
  const contextDecision = decideManagedContextRegistration({
    requestedId: input.requested.identity.contextId,
    projectId: input.requested.identity.projectId,
    checkoutId: input.requested.identity.checkoutId,
    context: input.requested.context,
    now: input.requested.now,
    checkoutScopedExisting: input.checkoutScopedExisting,
    requestedExisting: input.requestedExisting,
  });
  const context =
    contextDecision.outcome === "create"
      ? contextDecision.context
      : input.requestedExisting === undefined
        ? input.checkoutScopedExisting
        : {
            ...input.requestedExisting,
            locator: contextDecision.refreshLocator ?? input.requestedExisting.locator,
          };
  if (context === undefined) {
    throw new Error("Managed context decision did not identify a context row");
  }
  const locationDecision = decideManagedCheckoutLocation({
    requested: {
      checkoutId: input.requested.identity.checkoutId,
      locationId: input.requested.locationId,
      canonicalPath: input.requested.checkoutRootPath,
      now: input.requested.now,
    },
    checkoutLocations: input.checkoutLocations,
    checkoutExists: true,
  });
  if (locationDecision.outcome === "blocked") {
    throw new ManagedCheckoutConflictError({
      checkoutId: input.requested.identity.checkoutId,
      canonicalPath: input.requested.checkoutRootPath,
    });
  }
  return {
    registration: {
      identity: {
        ...input.requested.identity,
        contextId: context.id,
      },
      checkoutKind: input.requested.checkoutKind,
      contextId: context.id,
      context,
      location: locationDecision.location,
    },
    locationDecision,
  };
};

/** Shared location policy. Adapters only persist the returned rows atomically. */
export const decideManagedCheckoutLocation = (
  input: ManagedCheckoutLocationDecisionInput,
): ManagedCheckoutLocationDecision => {
  if (input.checkoutExists === false) {
    throw new ManagedCheckoutConflictError({
      checkoutId: input.requested.checkoutId,
      canonicalPath: input.requested.canonicalPath,
    });
  }
  const byId = input.checkoutLocations.find((row) => row.id === input.requested.locationId);
  if (
    byId !== undefined &&
    (byId.checkoutId !== input.requested.checkoutId ||
      byId.canonicalPath !== input.requested.canonicalPath)
  ) {
    throw new ManagedCheckoutConflictError({
      checkoutId: input.requested.checkoutId,
      canonicalPath: input.requested.canonicalPath,
      existingCheckoutId: byId.checkoutId,
    });
  }
  if (input.requested.canonicalPath.trim().length === 0) {
    throw new ManagedInaccessiblePathError({ path: input.requested.canonicalPath });
  }
  const checkoutRows = input.checkoutLocations.filter(
    (row) => row.checkoutId === input.requested.checkoutId,
  );
  const pathRows = input.checkoutLocations.filter(
    (row) => row.canonicalPath === input.requested.canonicalPath,
  );
  // A superseded row is historical provenance, not a live claim. It must not
  // block a different checkout from reusing a path the original checkout has
  // vacated; active and blocked rows remain hard conflicts.
  const conflictingPath = pathRows.find(
    (row) => row.checkoutId !== input.requested.checkoutId && row.state !== "superseded",
  );
  if (conflictingPath !== undefined) {
    const location: ManagedCheckoutLocation = {
      id: input.requested.locationId,
      checkoutId: input.requested.checkoutId,
      canonicalPath: input.requested.canonicalPath,
      state: "blocked",
      lastSeenAt: input.requested.now,
    };
    return {
      outcome: "blocked",
      location,
      supersededLocationId: conflictingPath.id,
      updates: [
        { ...conflictingPath, state: "blocked", lastSeenAt: input.requested.now },
        location,
      ],
    };
  }
  const supersededPath = pathRows.find(
    (row) => row.checkoutId === input.requested.checkoutId && row.state === "superseded",
  );
  const activeCheckoutLocation = checkoutRows.find((row) => row.state === "active");
  const activePath = pathRows.find(
    (row) => row.checkoutId === input.requested.checkoutId && row.state === "active",
  );
  if (activePath !== undefined) {
    return {
      outcome: "active",
      location: { ...activePath, lastSeenAt: input.requested.now },
    };
  }
  const blockedPath = pathRows.find(
    (row) => row.checkoutId === input.requested.checkoutId && row.state === "blocked",
  );
  if (blockedPath !== undefined) {
    return {
      outcome: "blocked",
      location: { ...blockedPath, lastSeenAt: input.requested.now },
      updates: [{ ...blockedPath, lastSeenAt: input.requested.now }],
    };
  }
  if (
    supersededPath !== undefined &&
    activeCheckoutLocation !== undefined &&
    input.requested.expectedActiveLocationId === activeCheckoutLocation.id
  ) {
    return {
      outcome: "rebound",
      supersededLocationId: activeCheckoutLocation.id,
      updates: [
        { ...activeCheckoutLocation, state: "superseded", lastSeenAt: input.requested.now },
      ],
      location: {
        id: input.requested.locationId,
        checkoutId: input.requested.checkoutId,
        canonicalPath: input.requested.canonicalPath,
        state: "active",
        reboundFromLocationId: activeCheckoutLocation.id,
        lastSeenAt: input.requested.now,
      },
    };
  }
  if (supersededPath !== undefined && activeCheckoutLocation !== undefined) {
    const location: ManagedCheckoutLocation = {
      ...supersededPath,
      state: "blocked",
      lastSeenAt: input.requested.now,
    };
    return {
      outcome: "blocked",
      location,
      supersededLocationId: activeCheckoutLocation.id,
      updates: [
        { ...supersededPath, state: "blocked", lastSeenAt: input.requested.now },
        { ...activeCheckoutLocation, state: "blocked", lastSeenAt: input.requested.now },
      ],
    };
  }
  if (supersededPath !== undefined) {
    return {
      outcome: "blocked",
      location: { ...supersededPath, state: "blocked", lastSeenAt: input.requested.now },
      updates: [{ ...supersededPath, state: "blocked", lastSeenAt: input.requested.now }],
    };
  }
  const active = checkoutRows.find((row) => row.state === "active");
  if (active === undefined) {
    return {
      outcome: "active",
      location: {
        id: input.requested.locationId,
        checkoutId: input.requested.checkoutId,
        canonicalPath: input.requested.canonicalPath,
        state: "active",
        lastSeenAt: input.requested.now,
      },
    };
  }
  if (
    input.requested.expectedActiveLocationId !== undefined &&
    input.requested.expectedActiveLocationId !== active.id
  ) {
    throw new ManagedCheckoutConflictError({
      checkoutId: input.requested.checkoutId,
      canonicalPath: input.requested.canonicalPath,
    });
  }
  return {
    outcome: "rebound",
    supersededLocationId: active.id,
    updates: [{ ...active, state: "superseded", lastSeenAt: input.requested.now }],
    location: {
      id: input.requested.locationId,
      checkoutId: input.requested.checkoutId,
      canonicalPath: input.requested.canonicalPath,
      state: "active",
      reboundFromLocationId: active.id,
      lastSeenAt: input.requested.now,
    },
  };
};

export interface RefreshManagedContextOwnerInput {
  readonly contextId: string;
  readonly ownerBranch: string;
  readonly locator?: string;
  /** Require the current owner to still match before publishing a replacement. */
  readonly expectedOwnerBranch?: string;
  readonly now: string;
}

export const decideManagedContextOwnerRefresh = (input: {
  readonly existing?: ManagedContextRecord;
  readonly requested: RefreshManagedContextOwnerInput;
}): ManagedContextRecord => {
  if (input.existing === undefined || input.existing.kind !== "branch") {
    throw new ManagedCopiedBranchConflictError({ branch: input.requested.ownerBranch });
  }
  if (
    input.requested.expectedOwnerBranch !== undefined &&
    input.existing.ownerBranch !== input.requested.expectedOwnerBranch
  ) {
    throw new ManagedCopiedBranchConflictError({ branch: input.requested.ownerBranch });
  }
  return {
    ...input.existing,
    ownerBranch: input.requested.ownerBranch,
    locator: input.requested.locator ?? input.existing.locator,
  };
};

export interface MigrateManagedContextToBranchInput {
  readonly contextId: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly branch: string;
  readonly now: string;
}

export type MigrateManagedContextToBranchFailure =
  | DuplicateManagedIdentityError
  | ManagedCopiedBranchConflictError;

export interface MigrateManagedContextToDetachedInput {
  readonly contextId: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly now: string;
}

export type MigrateManagedContextToDetachedFailure = DuplicateManagedIdentityError;

/** Preserves an ordinary context ID while making its ownership checkout-detached. */
export const decideManagedContextToDetached = (input: {
  readonly requested: MigrateManagedContextToDetachedInput;
  readonly existing?: ManagedContextRecord;
  readonly detachedExisting?: ManagedContextRecord;
}): ManagedContextRecord => {
  const { requested, existing, detachedExisting } = input;
  const requestedClaim = `${requested.projectId}/${requested.checkoutId}/detached`;
  if (existing === undefined) {
    throw new DuplicateManagedIdentityError({
      identityId: requested.contextId,
      existingClaim: "missing context",
      requestedClaim,
    });
  }
  if (existing.projectId !== requested.projectId || existing.checkoutId !== requested.checkoutId) {
    throw new DuplicateManagedIdentityError({
      identityId: existing.id,
      existingClaim: `${existing.projectId}/${existing.checkoutId ?? existing.kind}`,
      requestedClaim,
    });
  }
  if (detachedExisting !== undefined && detachedExisting.id !== existing.id) {
    throw new DuplicateManagedIdentityError({
      identityId: requested.contextId,
      existingClaim: detachedExisting.id,
      requestedClaim,
    });
  }
  if (existing.kind === "detached") return existing;
  if (existing.kind !== "workspace") {
    throw new DuplicateManagedIdentityError({
      identityId: existing.id,
      existingClaim: existing.kind,
      requestedClaim,
    });
  }
  return { ...existing, kind: "detached", locator: undefined, ownerBranch: undefined };
};

/**
 * Decides the one ownership transition that turns an ordinary-folder context
 * into a project-scoped branch context. Adapters pass every branch context
 * observed in the same transaction so a copied branch can never win by racing
 * the conversion. The context id and creation time are deliberately retained:
 * stacks already pointing at this context remain attached to the same identity.
 */
export const decideManagedContextToBranch = (input: {
  readonly requested: MigrateManagedContextToBranchInput;
  readonly existing?: ManagedContextRecord;
  readonly branchContexts: ReadonlyArray<ManagedContextRecord>;
}): ManagedContextRecord => {
  const { requested, existing } = input;
  if (existing === undefined) {
    throw new DuplicateManagedIdentityError({
      identityId: requested.contextId,
      existingClaim: "missing context",
      requestedClaim: `${requested.projectId}/${requested.checkoutId}`,
    });
  }
  if (existing.projectId !== requested.projectId) {
    throw new DuplicateManagedIdentityError({
      identityId: existing.id,
      existingClaim: existing.projectId,
      requestedClaim: requested.projectId,
    });
  }
  const competing = input.branchContexts.find(
    (candidate) =>
      candidate.id !== existing.id &&
      candidate.projectId === requested.projectId &&
      candidate.kind === "branch" &&
      (candidate.ownerBranch === requested.branch || candidate.locator === requested.branch),
  );
  if (existing.kind === "branch") {
    if (
      existing.checkoutId === undefined &&
      existing.ownerBranch === requested.branch &&
      existing.locator === requested.branch &&
      competing === undefined
    ) {
      return existing;
    }
    throw new ManagedCopiedBranchConflictError({
      branch: requested.branch,
      existingContextId: existing.id,
      requestedContextId: requested.contextId,
    });
  }
  if (existing.kind !== "workspace" || existing.checkoutId !== requested.checkoutId) {
    throw new DuplicateManagedIdentityError({
      identityId: existing.id,
      existingClaim: existing.checkoutId ?? existing.kind,
      requestedClaim: requested.checkoutId,
    });
  }

  if (competing !== undefined) {
    throw new ManagedCopiedBranchConflictError({
      branch: requested.branch,
      existingContextId: competing.id,
      requestedContextId: requested.contextId,
    });
  }

  return {
    ...existing,
    checkoutId: undefined,
    kind: "branch",
    locator: requested.branch,
    ownerBranch: requested.branch,
  };
};

export interface ReserveManagedIdentityTransitionInput {
  readonly id: string;
  readonly kind: ManagedIdentityTransitionKind;
  readonly projectId?: string;
  readonly checkoutId?: string;
  readonly contextId?: string;
  readonly branch?: string;
  readonly path?: string;
  readonly projectIdentityLocation?: string;
  readonly expectedGitValue?: string;
  readonly targetGitValue?: string;
  readonly expectedOwnerBranch?: string;
  readonly now: string;
}

export interface AdvanceManagedIdentityTransitionInput {
  readonly id: string;
  readonly expectedPhase: ManagedIdentityTransitionPhase;
  readonly phase: ManagedIdentityTransitionPhase;
  readonly now: string;
}

export interface FinalizeManagedIdentityTransitionInput {
  readonly id: string;
  readonly expectedPhase: ManagedIdentityTransitionPhase;
  readonly now: string;
}

export interface AbandonManagedIdentityTransitionInput {
  readonly id: string;
  readonly expectedPhase: "reserved";
  readonly kind: ManagedIdentityTransitionKind;
  readonly path: string;
  readonly projectId?: string;
  readonly checkoutId?: string;
  readonly contextId?: string;
  readonly branch?: string;
  readonly expectedGitValue?: string;
  readonly targetGitValue?: string;
  readonly expectedOwnerBranch?: string;
  readonly projectIdentityLocation?: string;
}

export type AbandonManagedIdentityTransitionResult =
  | { readonly outcome: "abandoned" }
  | { readonly outcome: "already-absent" };

export interface PruneManagedIdentityMetadataInput {
  readonly locationIds: ReadonlyArray<string>;
}

export interface PruneManagedIdentityMetadataResult {
  readonly removed: number;
  readonly prunedRecordIds: ReadonlyArray<string>;
  readonly preservedRecordIds: ReadonlyArray<string>;
  readonly unknownRecordIds: ReadonlyArray<string>;
}

/** Location rows that discovery may advertise but metadata pruning must retain. */
export const protectedManagedCheckoutLocationIds = (input: {
  readonly locations: ReadonlyArray<ManagedCheckoutLocation>;
  readonly transitions: ReadonlyArray<ManagedIdentityTransitionRecord>;
}): ReadonlySet<string> => {
  const protectedIds = new Set(
    input.locations
      .filter((location) => location.state === "active" || location.state === "blocked")
      .map((location) => location.id),
  );
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const location of input.locations) {
      if (
        location.reboundFromLocationId !== undefined &&
        protectedIds.has(location.id) &&
        !protectedIds.has(location.reboundFromLocationId)
      ) {
        protectedIds.add(location.reboundFromLocationId);
        expanded = true;
      }
    }
  }
  for (const transition of input.transitions) {
    if (transition.phase === "finalized") continue;
    for (const location of input.locations) {
      if (
        (transition.checkoutId !== undefined && transition.checkoutId === location.checkoutId) ||
        (transition.path !== undefined && transition.path === location.canonicalPath)
      ) {
        protectedIds.add(location.id);
      }
    }
  }
  return protectedIds;
};

export const decideManagedIdentityMetadataPrune = (input: {
  readonly locations: ReadonlyArray<ManagedCheckoutLocation>;
  readonly locationIds: ReadonlyArray<string>;
  readonly transitions: ReadonlyArray<ManagedIdentityTransitionRecord>;
}): PruneManagedIdentityMetadataResult => {
  const selected = new Set(input.locationIds);
  const protectedIds = protectedManagedCheckoutLocationIds(input);
  const prunedRecordIds: string[] = [];
  const preservedRecordIds: string[] = [];
  const unknownRecordIds: string[] = [];
  for (const id of selected) {
    const location = input.locations.find((candidate) => candidate.id === id);
    if (location === undefined) {
      unknownRecordIds.push(id);
      continue;
    }
    if (protectedIds.has(id)) preservedRecordIds.push(id);
    else prunedRecordIds.push(id);
  }
  return {
    removed: prunedRecordIds.length,
    prunedRecordIds,
    preservedRecordIds,
    unknownRecordIds,
  };
};

export type ManagedIdentityRecoveryError =
  | ManagedCheckoutConflictError
  | ManagedCopiedBranchConflictError
  | ManagedIdentityTransitionOwnershipError
  | ManagedInaccessiblePathError;

export const transitionResourceKeys = (input: {
  readonly kind: ManagedIdentityTransitionKind;
  readonly projectId?: string;
  readonly checkoutId?: string;
  readonly contextId?: string;
  readonly branch?: string;
  readonly path?: string;
  readonly projectIdentityLocation?: string;
}): ReadonlyArray<string> => {
  const nonEmpty = (value: string | undefined): string | undefined => {
    const normalized = value?.trim();
    return normalized === undefined || normalized.length === 0 ? undefined : normalized;
  };
  const projectId = nonEmpty(input.projectId);
  const checkoutId = nonEmpty(input.checkoutId);
  const contextId = nonEmpty(input.contextId);
  const branch = nonEmpty(input.branch);
  const path = nonEmpty(input.path);
  const projectIdentityLocation = nonEmpty(input.projectIdentityLocation);
  const keys: string[] = [];
  if (input.kind === "new-checkout") {
    if (path !== undefined) keys.push(`path:${path}`);
    if (projectIdentityLocation !== undefined) {
      keys.push(`project-identity:${projectIdentityLocation}`);
    }
  } else if (input.kind === "rebind-checkout" || input.kind === "folder-to-git") {
    if (checkoutId !== undefined) keys.push(`checkout:${checkoutId}`);
    if (path !== undefined) keys.push(`path:${path}`);
    if (input.kind === "folder-to-git" && projectIdentityLocation !== undefined) {
      keys.push(`project-identity:${projectIdentityLocation}`);
    }
  } else {
    if (contextId !== undefined) keys.push(`context:${contextId}`);
    if (projectId !== undefined && branch !== undefined) {
      keys.push(`branch:${projectId}:${branch}`);
    }
  }
  return keys;
};

export const decideManagedIdentityTransitionReservation = (input: {
  readonly requested: ReserveManagedIdentityTransitionInput;
  readonly existing?: ManagedIdentityTransitionRecord;
  readonly resourceOwner?: ManagedIdentityTransitionRecord;
  /** Context owner observed under the adapter's reservation transaction. */
  readonly contextOwnerBranch?: string;
  /** Whether the context row was present in that same reservation transaction. */
  readonly contextPresent?: boolean;
}): ManagedIdentityTransitionRecord => {
  const requested = input.requested;
  const requestedResources = transitionResourceKeys(requested);
  if (requestedResources.length === 0) {
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: requested.id });
  }
  if (input.existing !== undefined) {
    const same =
      input.existing.kind === requested.kind &&
      input.existing.projectId === requested.projectId &&
      input.existing.checkoutId === requested.checkoutId &&
      input.existing.contextId === requested.contextId &&
      input.existing.branch === requested.branch &&
      input.existing.path === requested.path &&
      input.existing.projectIdentityLocation === requested.projectIdentityLocation &&
      input.existing.expectedGitValue === requested.expectedGitValue &&
      input.existing.targetGitValue === requested.targetGitValue &&
      input.existing.expectedOwnerBranch === requested.expectedOwnerBranch;
    if (!same) throw new ManagedIdentityTransitionOwnershipError({ transitionId: requested.id });
    return input.existing;
  }
  if (requested.kind === "adopt-context") {
    if (
      requested.contextId === undefined ||
      input.contextPresent !== true ||
      requested.branch === undefined ||
      requested.branch === requested.expectedOwnerBranch ||
      input.contextOwnerBranch !== requested.expectedOwnerBranch
    ) {
      throw new ManagedIdentityTransitionOwnershipError({ transitionId: requested.id });
    }
  }
  if (input.resourceOwner !== undefined && input.resourceOwner.id !== requested.id) {
    throw new ManagedIdentityTransitionOwnershipError({
      transitionId: requested.id,
      resource: requestedResources.join(","),
    });
  }
  return {
    id: requested.id,
    kind: requested.kind,
    phase: "reserved",
    projectId: requested.projectId,
    checkoutId: requested.checkoutId,
    contextId: requested.contextId,
    branch: requested.branch,
    path: requested.path,
    projectIdentityLocation: requested.projectIdentityLocation,
    expectedGitValue: requested.expectedGitValue,
    targetGitValue: requested.targetGitValue,
    expectedOwnerBranch: requested.expectedOwnerBranch,
    createdAt: requested.now,
    updatedAt: requested.now,
  };
};

export const decideManagedIdentityTransitionAdvance = (
  existing: ManagedIdentityTransitionRecord,
  input: AdvanceManagedIdentityTransitionInput,
): ManagedIdentityTransitionRecord => {
  if (existing.id !== input.id) {
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  }
  const predecessor: Readonly<
    Record<ManagedIdentityTransitionPhase, ManagedIdentityTransitionPhase | undefined>
  > = {
    reserved: undefined,
    "git-written": "reserved",
    finalized: "git-written",
  };
  if (input.phase === existing.phase) {
    if (
      input.expectedPhase !== existing.phase &&
      input.expectedPhase !== predecessor[existing.phase]
    ) {
      throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
    }
    return existing;
  }
  if (input.expectedPhase !== existing.phase) {
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  }
  const nextPhase: Readonly<
    Record<ManagedIdentityTransitionPhase, ManagedIdentityTransitionPhase | undefined>
  > = {
    reserved: "git-written",
    "git-written": "finalized",
    finalized: undefined,
  };
  if (nextPhase[existing.phase] !== input.phase) {
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  }
  return { ...existing, phase: input.phase, updatedAt: input.now };
};

export const decideManagedIdentityTransitionFinalize = (
  existing: ManagedIdentityTransitionRecord,
  input: FinalizeManagedIdentityTransitionInput,
): ManagedIdentityTransitionRecord => {
  if (input.expectedPhase !== "git-written") {
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  }
  return decideManagedIdentityTransitionAdvance(existing, {
    id: input.id,
    expectedPhase: input.expectedPhase,
    phase: "finalized",
    now: input.now,
  });
};

export const decideManagedIdentityTransitionAbandon = (
  existing: ManagedIdentityTransitionRecord | undefined,
  input: AbandonManagedIdentityTransitionInput,
): AbandonManagedIdentityTransitionResult => {
  if (existing === undefined) return { outcome: "already-absent" };
  const exact =
    existing.id === input.id &&
    existing.phase === input.expectedPhase &&
    existing.kind === input.kind &&
    existing.path === input.path &&
    existing.projectId === input.projectId &&
    existing.checkoutId === input.checkoutId &&
    existing.contextId === input.contextId &&
    existing.branch === input.branch &&
    existing.projectIdentityLocation === input.projectIdentityLocation &&
    existing.expectedGitValue === input.expectedGitValue &&
    existing.targetGitValue === input.targetGitValue &&
    existing.expectedOwnerBranch === input.expectedOwnerBranch;
  if (!exact) throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  return { outcome: "abandoned" };
};
/**
 * Everything one stack registration needs, with every identity already minted by
 * the service: the registry stores the decision, it never makes it.
 *
 * The project, the checkout, its one location, and the context are upserted
 * inside the very transaction that creates the pending stack, so a registration
 * that refuses leaves none of them behind and the live-stack uniqueness of
 * `(checkoutId, contextId, stackName)` is decided under the same lock.
 */
export interface PrepareStackInput {
  readonly identity: ManagedIdentityTriple;
  readonly checkoutKind: ManagedCheckoutKind;
  /**
   * The checkout's canonical top-level directory, which is the one location a
   * checkout has — never the directory a caller happened to run in. A checkout
   * holds exactly one location, so a nested path here would both record a
   * subdirectory as the checkout's whole location and make the next start from
   * anywhere else in the same checkout a duplicate-identity refusal.
   */
  readonly checkoutRootPath: string;
  readonly locationId: string;
  readonly context: ManagedContextDescriptor;
  readonly stackId: string;
  readonly stackName: string;
  readonly paths: ManagedStackPaths;
  readonly operationToken: string;
  readonly ownerPid?: number;
  readonly now: string;
  readonly configuration: ManagedStackConfiguration;
}

/**
 * The registration's outcome. A checkout-scoped context the checkout already has
 * wins over the one the caller minted, so the stack's own `contextId` is the
 * authoritative answer to which context was used.
 */
export type PrepareStackResult =
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

export interface ManagedPortReservation {
  readonly stackId: string;
  readonly stackName: string;
  readonly lifecycle: ManagedStackLifecycle;
  readonly assignment: ManagedPortAssignment;
}

export interface ClaimManagedStartPortsInput {
  readonly stackId: string;
  readonly operationToken: string;
  readonly ports: ReadonlyArray<ManagedPortAssignment>;
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

/** Failures both adapters raise while registering a stack. */
export type PrepareStackFailure =
  | ManagedIdentityRecoveryError
  | DuplicateManagedIdentityError
  | DuplicateManagedPortKeyError
  | InvalidManagedOwnerPidError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPortReservationError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while claiming an operation for a stack. */
export type ClaimManagedOperationFailure =
  | InvalidManagedOwnerPidError
  | ManagedOperationOwnershipError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while reconfiguring a published stack. */
export type UpdateManagedStackFailure =
  | DuplicateManagedPortKeyError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPendingStackUpdateError
  | ManagedPortReservationError
  | ManagedRunningStackPortChangeError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while atomically claiming a start's ports. */
export type ClaimManagedStartPortsFailure =
  | DuplicateManagedPortKeyError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPortReservationError
  | ManagedRunningStackPortChangeError
  | ManagedStackNotFoundError;

/**
 * Failures both adapters raise while settling an abandoned operation. Adopting a
 * stack re-reserves the ports it claims, so another stack holding one of them
 * fails the reconciliation rather than stealing the lease.
 */
export type ReconcileManagedOperationFailure =
  | DuplicateManagedPortKeyError
  | InvalidManagedPortError
  | ManagedOperationOwnershipError
  | ManagedPortReservationError
  | ManagedStackNotFoundError;

/** Failures both adapters raise while resolving a stack under a live claim. */
export type OwnedManagedStackFailure = ManagedOperationOwnershipError | ManagedStackNotFoundError;

/**
 * The registry contract shared by the persistent SQLite adapters and the
 * in-memory test seam.
 *
 * Every method is an `Effect` whose error channel names the domain failures that
 * decision can reach. Storage-level failures — a corrupt row, an unexpected
 * driver error — are defects instead: they are not outcomes a caller can act on.
 */
export interface ManagedStackRepositoryShape {
  readonly registerCheckoutIdentity: (
    input: RegisterManagedCheckoutIdentityInput,
  ) => Effect.Effect<
    ManagedCheckoutIdentityRegistration,
    ManagedCheckoutIdentityRegistrationFailure
  >;
  readonly listIdentityClaims: (projectId?: string) => Effect.Effect<ManagedIdentityClaims>;
  readonly applyCheckoutLocation: (
    input: ApplyManagedCheckoutLocationInput,
  ) => Effect.Effect<ManagedCheckoutLocationDecision, ManagedIdentityRecoveryError>;
  readonly refreshContextOwner: (
    input: RefreshManagedContextOwnerInput,
  ) => Effect.Effect<ManagedContextRecord, ManagedIdentityRecoveryError>;
  readonly migrateContextToBranch: (
    input: MigrateManagedContextToBranchInput,
  ) => Effect.Effect<ManagedContextRecord, MigrateManagedContextToBranchFailure>;
  readonly migrateContextToDetached: (
    input: MigrateManagedContextToDetachedInput,
  ) => Effect.Effect<ManagedContextRecord, MigrateManagedContextToDetachedFailure>;
  readonly reserveIdentityTransition: (
    input: ReserveManagedIdentityTransitionInput,
  ) => Effect.Effect<ManagedIdentityTransitionRecord, ManagedIdentityRecoveryError>;
  readonly advanceIdentityTransition: (
    input: AdvanceManagedIdentityTransitionInput,
  ) => Effect.Effect<ManagedIdentityTransitionRecord, ManagedIdentityRecoveryError>;
  readonly finalizeIdentityTransition: (
    input: FinalizeManagedIdentityTransitionInput,
  ) => Effect.Effect<ManagedIdentityTransitionRecord, ManagedIdentityRecoveryError>;
  readonly abandonIdentityTransition: (
    input: AbandonManagedIdentityTransitionInput,
  ) => Effect.Effect<AbandonManagedIdentityTransitionResult, ManagedIdentityRecoveryError>;
  readonly pruneIdentityMetadata: (
    input: PruneManagedIdentityMetadataInput,
  ) => Effect.Effect<PruneManagedIdentityMetadataResult, ManagedIdentityRecoveryError>;
  readonly prepareStack: (
    input: PrepareStackInput,
  ) => Effect.Effect<PrepareStackResult, PrepareStackFailure>;
  readonly publishPendingStack: (
    stackId: string,
    operationToken: string,
    now: string,
  ) => Effect.Effect<ManagedStackRecord, OwnedManagedStackFailure>;
  readonly abortPendingStack: (
    stackId: string,
    operationToken: string,
  ) => Effect.Effect<void, OwnedManagedStackFailure>;
  readonly getStack: (stackId: string) => Effect.Effect<ManagedStackRecord | undefined>;
  readonly listStacks: (options?: {
    readonly includeTombstoned?: boolean;
  }) => Effect.Effect<ReadonlyArray<ManagedStackRecord>>;
  /**
   * The reader's view of a stack, joined to its checkout and context.
   *
   * Kept apart from {@link getStack} deliberately: every lifecycle decision in
   * the policy layer needs the stack row and nothing else, so only the paths
   * that actually report to a caller pay for the join.
   */
  readonly getStackProjection: (
    stackId: string,
  ) => Effect.Effect<ManagedStackProjection | undefined>;
  readonly listStackProjections: (options?: {
    readonly includeTombstoned?: boolean;
    /** When present, filter before hydrating ports for a resolve. */
    readonly identity?: ManagedIdentityTriple;
  }) => Effect.Effect<ReadonlyArray<ManagedStackProjection>>;
  /**
   * The one context a checkout has of a checkout-scoped kind, if it has one.
   *
   * A read-only resolve of a detached `HEAD` has no other way to find the
   * context it would use: unlike a branch, a detached `HEAD` stores nothing in
   * git, so the registry is where that context lives.
   */
  readonly findCheckoutContext: (
    checkoutId: string,
    kind: ManagedCheckoutScopedContextKind,
  ) => Effect.Effect<ManagedContextRecord | undefined>;
  readonly claimOperation: (
    input: ClaimManagedOperationInput,
  ) => Effect.Effect<ClaimManagedOperationResult, ClaimManagedOperationFailure>;
  readonly finishOperation: (
    stackId: string,
    operationToken: string,
    outcome: "completed" | "failed",
    now: string,
    error?: string,
  ) => Effect.Effect<void, ManagedOperationOwnershipError>;
  readonly updateStack: (
    input: UpdateManagedStackInput,
  ) => Effect.Effect<ManagedStackRecord, UpdateManagedStackFailure>;
  readonly listPortReservations: () => Effect.Effect<ReadonlyArray<ManagedPortReservation>>;
  readonly claimStartPorts: (
    input: ClaimManagedStartPortsInput,
  ) => Effect.Effect<ManagedStackRecord, ClaimManagedStartPortsFailure>;
  readonly listActiveOperations: (
    startedBefore?: string,
  ) => Effect.Effect<ReadonlyArray<ManagedOperationRecord>>;
  readonly reconcileOperation: (
    stackId: string,
    operationToken: string,
    lifecycle: ManagedStackLifecycle,
    now: string,
  ) => Effect.Effect<ReconcileManagedOperationResult, ReconcileManagedOperationFailure>;
  readonly tombstoneStack: (
    stackId: string,
    operationToken: string,
    now: string,
  ) => Effect.Effect<ManagedStackRecord, OwnedManagedStackFailure>;
  readonly listCheckoutLocations: () => Effect.Effect<ReadonlyArray<ManagedCheckoutLocation>>;
}

/**
 * The registry a managed stack service reads and writes.
 *
 * A persistent adapter owns a database handle, so it is provided as a scoped
 * layer that closes the handle when the layer's scope closes; there is no
 * `close` method on the contract for a caller to forget.
 */
export class ManagedStackRepository extends Context.Service<
  ManagedStackRepository,
  ManagedStackRepositoryShape
>()("stack/managed/ManagedStackRepository") {}

const managedStackOccupiesPorts = (lifecycle: ManagedStackLifecycle): boolean =>
  lifecycle === "running" || lifecycle === "starting" || lifecycle === "stopping";

/**
 * The durable ownership matrix shared by every repository adapter.
 *
 * Automatic assignments are exclusive for the whole lifetime of a
 * non-tombstoned stack. Exact assignments may be duplicated while their owner
 * is stopped or failed, but an exact assignment cannot overlap an owner that
 * currently occupies its ports.
 */
export const managedPortReservationsConflict = (
  incomingStackId: string,
  incoming: ManagedPortAssignment,
  owner: ManagedPortReservation,
): boolean =>
  incomingStackId !== owner.stackId &&
  incoming.port === owner.assignment.port &&
  (incoming.intent === "automatic" ||
    owner.assignment.intent === "automatic" ||
    managedStackOccupiesPorts(owner.lifecycle));

/**
 * An operation's owner pid is only useful because recovery asks the operating
 * system whether that process is still alive, and a value that is not a pid
 * cannot be asked about: `kill(0, 0)` signals the caller's own process group
 * and a fractional pid throws, either of which would report a dead owner as
 * alive and wedge the claim forever. `undefined` is a valid answer — it records
 * that no owner is known — so it is not usable, but it is not invalid either.
 */
export const isUsableManagedOwnerPid = (ownerPid: number | undefined): ownerPid is number =>
  ownerPid !== undefined && Number.isSafeInteger(ownerPid) && ownerPid > 0;

/**
 * Rejects a pid that could never be probed, at the boundary that would persist
 * it. Shared so both adapters refuse the same inputs and no registry row can
 * carry a pid that recovery cannot reason about.
 */
export const assertManagedOwnerPid = (ownerPid: number | undefined): void => {
  if (ownerPid !== undefined && !isUsableManagedOwnerPid(ownerPid)) {
    throw new InvalidManagedOwnerPidError({ ownerPid });
  }
};

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

const portAssignmentsEqual = (
  left: ReadonlyArray<ManagedPortAssignment>,
  right: ReadonlyArray<ManagedPortAssignment>,
): boolean => {
  if (left.length !== right.length) return false;
  const byKey = new Map(right.map((assignment) => [assignment.key, assignment]));
  return left.every((assignment) => {
    const candidate = byKey.get(assignment.key);
    return (
      candidate !== undefined &&
      assignment.port === candidate.port &&
      assignment.intent === candidate.intent
    );
  });
};

/**
 * Conflict checks are required when a write claims live ownership or changes
 * the durable assignment. Re-persisting unchanged rows while stopping or
 * failing a stack must not re-claim exact ports that another stopped sibling
 * was allowed to share and has since started using.
 */
export const requiresManagedPortOwnershipValidation = (
  current: ManagedStackRecord,
  ports: ReadonlyArray<ManagedPortAssignment>,
  targetLifecycle: ManagedStackLifecycle,
): boolean =>
  managedStackOccupiesPorts(targetLifecycle) || !portAssignmentsEqual(current.ports, ports);

export const validateManagedPortAssignments = (
  stackId: string,
  ports: ReadonlyArray<ManagedPortAssignment>,
): void => {
  const keys = new Set<string>();
  const numbers = new Set<number>();
  for (const assignment of ports) {
    if (!Number.isInteger(assignment.port) || assignment.port < 1 || assignment.port > 65_535) {
      throw new InvalidManagedPortError({ port: assignment.port, key: assignment.key });
    }
    if (keys.has(assignment.key)) {
      throw new DuplicateManagedPortKeyError({ key: assignment.key });
    }
    if (numbers.has(assignment.port)) {
      throw new ManagedPortReservationError({ port: assignment.port, ownerStackId: stackId });
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
  // Sorted by key here, in the shared reconciler: SQLite reads its port rows
  // back with `ORDER BY key`, so leaving the caller's request order in place
  // would make the same request produce differently ordered records per adapter.
  const reconciled = requested
    .map((assignment) => {
      const current = persisted.get(assignment.key);
      return assignment.intent === "automatic" && current !== undefined
        ? { ...assignment, port: current.port }
        : assignment;
    })
    .sort((left, right) => compareManagedText(left.key, right.key));
  if (
    managedStackOccupiesPorts(stack.lifecycle) &&
    managedStackOccupiesPorts(targetLifecycle) &&
    !portNumbersEqual(stack.ports, reconciled)
  ) {
    throw new ManagedRunningStackPortChangeError({ stackId: stack.id });
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
    throw new ManagedStackNotFoundError({ stackId: stack.id });
  }
  if (stack.status === "pending") {
    throw new ManagedPendingStackUpdateError({ stackId: stack.id });
  }
};
