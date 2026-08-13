import { Effect } from "effect";
import {
  DuplicateManagedIdentityError,
  DuplicateManagedPortKeyError,
  InvalidManagedOwnerPidError,
  InvalidManagedPortError,
  ManagedOperationOwnershipError,
  ManagedCheckoutConflictError,
  ManagedCopiedBranchConflictError,
  ManagedIdentityTransitionOwnershipError,
  ManagedInaccessiblePathError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  type ManagedCheckoutKind,
  type ManagedCheckoutLocation,
  type ManagedContextRecord,
  type ManagedIdentityTriple,
  type ManagedOperationRecord,
  type ManagedRuntimeMetadata,
  type ManagedStackConfiguration,
  type ManagedStackProjection,
  type ManagedStackRecord,
  type ManagedIdentityTransitionRecord,
  type ManagedIdentityClaims,
} from "./model.ts";
import { failsWith } from "./failure.ts";
import {
  assertManagedOwnerPid,
  assertManagedStackUpdatable,
  compareManagedText,
  decideManagedCheckoutLocation,
  decideManagedIdentityTransitionAdvance,
  decideManagedIdentityTransitionReservation,
  decideManagedIdentityTransitionFinalize,
  decideManagedContextOwnerRefresh,
  decideManagedContextToBranch,
  decideManagedIdentityMetadataPrune,
  transitionResourceKeys,
  decideManagedContextRegistration,
  decideManagedCheckoutIdentity,
  managedStackOccupiesPorts,
  reconcileManagedPortAssignments,
  validateManagedPortAssignments,
  type ClaimManagedOperationFailure,
  type ClaimManagedOperationInput,
  type ClaimManagedOperationResult,
  type ManagedStackRepositoryShape,
  type OwnedManagedStackFailure,
  type PrepareStackFailure,
  type PrepareStackInput,
  type PrepareStackResult,
  type ReconcileManagedOperationFailure,
  type ReconcileManagedOperationResult,
  type UpdateManagedStackFailure,
  type UpdateManagedStackInput,
  type ApplyManagedCheckoutLocationInput,
  type ManagedCheckoutLocationDecision,
  type RefreshManagedContextOwnerInput,
  type MigrateManagedContextToBranchInput,
  type MigrateManagedContextToBranchFailure,
  type ReserveManagedIdentityTransitionInput,
  type AdvanceManagedIdentityTransitionInput,
  type PruneManagedIdentityMetadataInput,
  type PruneManagedIdentityMetadataResult,
  type ManagedIdentityRecoveryError,
  type RegisterManagedCheckoutIdentityInput,
  type ManagedCheckoutIdentityRegistration,
  type ManagedCheckoutIdentityRegistrationFailure,
} from "./repository.ts";

interface InMemoryCheckout {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ManagedCheckoutKind;
}

const stackIdentityKey = (checkoutId: string, contextId: string, stackName: string): string =>
  `${checkoutId}\u0000${contextId}\u0000${stackName}`;

const copy = <A>(value: A): A => structuredClone(value);

const applyConfiguration = (
  stack: ManagedStackRecord,
  configuration: ManagedStackConfiguration,
  now: string,
): ManagedStackRecord => {
  const lifecycle = configuration.lifecycle ?? stack.lifecycle;
  return {
    ...stack,
    lifecycle,
    runtimeRequest: configuration.runtimeRequest ?? stack.runtimeRequest,
    runtime: configuration.runtime ?? stack.runtime,
    ports: reconcileManagedPortAssignments(stack, configuration.ports, lifecycle),
    serviceVersions: configuration.serviceVersions ?? stack.serviceVersions,
    runtimeMetadata: configuration.runtimeMetadata ?? stack.runtimeMetadata,
    configFingerprint: configuration.configFingerprint ?? stack.configFingerprint,
    credentialsReference: configuration.credentialsReference ?? stack.credentialsReference,
    updatedAt: now,
  };
};

const emptyRuntimeMetadata = (): ManagedRuntimeMetadata => ({
  processIds: {},
  containerIds: {},
});

/**
 * A test seam, exported only through `@supabase/stack/testing`: it lets
 * consumers exercise the managed service without a SQLite driver, and it is the
 * parity reference the persistent adapters are tested against. Production code
 * must go through a persistent adapter instead.
 *
 * The registry decisions themselves stay synchronous — the store is a set of
 * maps, and {@link atomic} rolls them back by snapshot — so each contract method
 * is that synchronous decision lifted into an `Effect`.
 */
export const createInMemoryManagedStackRepository = (): ManagedStackRepositoryShape => {
  const projects = new Set<string>();
  const checkouts = new Map<string, InMemoryCheckout>();
  const contexts = new Map<string, ManagedContextRecord>();
  const locations = new Map<string, ManagedCheckoutLocation>();
  const transitions = new Map<string, ManagedIdentityTransitionRecord>();
  const stacks = new Map<string, ManagedStackRecord>();
  const stackIdentities = new Map<string, string>();
  const operations = new Map<string, ManagedOperationRecord>();
  const activeOperationByStack = new Map<string, string>();
  const portOwners = new Map<number, string>();

  const atomic = <A>(run: () => A): A => {
    const snapshot = {
      projects: structuredClone([...projects]),
      checkouts: structuredClone([...checkouts]),
      contexts: structuredClone([...contexts]),
      locations: structuredClone([...locations]),
      transitions: structuredClone([...transitions]),
      stacks: structuredClone([...stacks]),
      stackIdentities: structuredClone([...stackIdentities]),
      operations: structuredClone([...operations]),
      activeOperationByStack: structuredClone([...activeOperationByStack]),
      portOwners: structuredClone([...portOwners]),
    };
    try {
      return run();
    } catch (error: unknown) {
      projects.clear();
      for (const project of snapshot.projects) projects.add(project);
      checkouts.clear();
      for (const [key, value] of snapshot.checkouts) checkouts.set(key, value);
      contexts.clear();
      for (const [key, value] of snapshot.contexts) contexts.set(key, value);
      locations.clear();
      for (const [key, value] of snapshot.locations) locations.set(key, value);
      transitions.clear();
      for (const [key, value] of snapshot.transitions) transitions.set(key, value);
      stacks.clear();
      for (const [key, value] of snapshot.stacks) stacks.set(key, value);
      stackIdentities.clear();
      for (const [key, value] of snapshot.stackIdentities) stackIdentities.set(key, value);
      operations.clear();
      for (const [key, value] of snapshot.operations) operations.set(key, value);
      activeOperationByStack.clear();
      for (const [key, value] of snapshot.activeOperationByStack) {
        activeOperationByStack.set(key, value);
      }
      portOwners.clear();
      for (const [key, value] of snapshot.portOwners) portOwners.set(key, value);
      throw error;
    }
  };

  const requireStack = (stackId: string): ManagedStackRecord => {
    const stack = stacks.get(stackId);
    if (stack === undefined) {
      throw new ManagedStackNotFoundError({ stackId });
    }
    return stack;
  };

  const requireOwnedOperation = (
    stackId: string,
    operationToken: string,
  ): ManagedOperationRecord => {
    const activeToken = activeOperationByStack.get(stackId);
    const operation = operations.get(operationToken);
    if (
      activeToken !== operationToken ||
      operation === undefined ||
      operation.stackId !== stackId ||
      operation.status !== "active"
    ) {
      throw new ManagedOperationOwnershipError({ stackId });
    }
    return operation;
  };

  const transitionPortOwnership = (
    current: ManagedStackRecord | undefined,
    next: ManagedStackRecord,
  ): void => {
    validateManagedPortAssignments(next.id, next.ports);
    if (managedStackOccupiesPorts(next.lifecycle)) {
      for (const assignment of next.ports) {
        const owner = portOwners.get(assignment.port);
        if (owner !== undefined && owner !== next.id) {
          throw new ManagedPortReservationError({ port: assignment.port, ownerStackId: owner });
        }
      }
    }
    if (current !== undefined && managedStackOccupiesPorts(current.lifecycle)) {
      for (const assignment of current.ports) {
        if (portOwners.get(assignment.port) === current.id) {
          portOwners.delete(assignment.port);
        }
      }
    }
    if (managedStackOccupiesPorts(next.lifecycle)) {
      for (const assignment of next.ports) {
        const owner = portOwners.get(assignment.port);
        if (owner !== undefined && owner !== next.id) {
          throw new ManagedPortReservationError({ port: assignment.port, ownerStackId: owner });
        }
        portOwners.set(assignment.port, next.id);
      }
    }
  };

  /**
   * Tears an unpublished stack out of every index it was registered in and
   * releases its claim, so the identity is immediately free to retry. Shared by
   * the explicit abort path and by recovery's pending branch.
   */
  const discardPendingStack = (stack: ManagedStackRecord, operationToken: string): void => {
    transitionPortOwnership(stack, { ...stack, lifecycle: "stopped", ports: [] });
    stacks.delete(stack.id);
    stackIdentities.delete(stackIdentityKey(stack.checkoutId, stack.contextId, stack.name));
    operations.delete(operationToken);
    activeOperationByStack.delete(stack.id);
  };

  const claimOperation = (input: ClaimManagedOperationInput): ClaimManagedOperationResult => {
    assertManagedOwnerPid(input.ownerPid);
    requireStack(input.stackId);
    const activeToken = activeOperationByStack.get(input.stackId);
    if (activeToken !== undefined) {
      const active = operations.get(activeToken);
      if (active !== undefined) {
        return { acquired: false, operation: copy(active) };
      }
    }

    const operation: ManagedOperationRecord = {
      token: input.token,
      stackId: input.stackId,
      kind: input.kind,
      status: "active",
      ownerPid: input.ownerPid,
      startedAt: input.now,
    };
    operations.set(operation.token, operation);
    activeOperationByStack.set(operation.stackId, operation.token);
    return { acquired: true, operation: copy(operation) };
  };

  /** Applies the shared context-registration policy to this atomic map store. */
  const registerContext = (input: PrepareStackInput): string => {
    const contextRegistration = decideManagedContextRegistration({
      requestedId: input.identity.contextId,
      projectId: input.identity.projectId,
      checkoutId: input.identity.checkoutId,
      context: input.context,
      now: input.now,
      checkoutScopedExisting:
        input.context.kind === "branch"
          ? undefined
          : [...contexts.values()].find(
              (candidate) =>
                candidate.checkoutId === input.identity.checkoutId &&
                candidate.kind === input.context.kind,
            ),
      requestedExisting: contexts.get(input.identity.contextId),
    });
    const contextId =
      contextRegistration.outcome === "create"
        ? contextRegistration.context.id
        : contextRegistration.contextId;
    if (contextRegistration.outcome === "create") {
      contexts.set(contextId, contextRegistration.context);
    } else if (contextRegistration.refreshLocator !== undefined) {
      const existing = contexts.get(contextId);
      if (existing === undefined) {
        throw new Error(`Managed context ${contextId} vanished during registration`);
      }
      contexts.set(contextId, { ...existing, locator: contextRegistration.refreshLocator });
    }
    return contextId;
  };

  const registerCheckoutIdentity = (
    input: RegisterManagedCheckoutIdentityInput,
  ): ManagedCheckoutIdentityRegistration =>
    atomic(() => {
      const existingCheckout = checkouts.get(input.identity.checkoutId);
      const decision = decideManagedCheckoutIdentity({
        requested: input,
        existingCheckout,
        checkoutLocations: [...locations.values()],
        checkoutScopedExisting:
          input.context.kind === "branch"
            ? undefined
            : [...contexts.values()].find(
                (candidate) =>
                  candidate.checkoutId === input.identity.checkoutId &&
                  candidate.kind === input.context.kind,
              ),
        requestedExisting: contexts.get(input.identity.contextId),
      });
      projects.add(input.identity.projectId);
      checkouts.set(input.identity.checkoutId, {
        id: input.identity.checkoutId,
        projectId: input.identity.projectId,
        kind: input.checkoutKind,
      });
      contexts.set(decision.registration.context.id, decision.registration.context);
      for (const updated of decision.locationDecision.updates ?? []) {
        locations.set(updated.id, updated);
      }
      locations.set(decision.registration.location.id, decision.registration.location);
      return copy(decision.registration);
    });

  const prepareStack = (input: PrepareStackInput): PrepareStackResult => {
    assertManagedOwnerPid(input.ownerPid);
    return atomic(() => {
      projects.add(input.identity.projectId);
      const checkout = checkouts.get(input.identity.checkoutId);
      if (checkout !== undefined && checkout.projectId !== input.identity.projectId) {
        throw new DuplicateManagedIdentityError({
          identityId: input.identity.checkoutId,
          existingClaim: checkout.projectId,
          requestedClaim: input.identity.projectId,
        });
      }
      checkouts.set(input.identity.checkoutId, {
        id: input.identity.checkoutId,
        projectId: input.identity.projectId,
        kind: input.checkoutKind,
      });

      const contextId = registerContext(input);

      const locationDecision = decideManagedCheckoutLocation({
        requested: {
          checkoutId: input.identity.checkoutId,
          locationId: input.locationId,
          canonicalPath: input.checkoutRootPath,
          now: input.now,
        },
        checkoutLocations: [...locations.values()],
        checkoutExists: true,
      });
      if (locationDecision.outcome !== "active") {
        throw new ManagedCheckoutConflictError({
          checkoutId: input.identity.checkoutId,
          canonicalPath: input.checkoutRootPath,
        });
      }
      locations.set(locationDecision.location.id, locationDecision.location);

      const identityKey = stackIdentityKey(input.identity.checkoutId, contextId, input.stackName);
      const existingStackId = stackIdentities.get(identityKey);
      if (existingStackId !== undefined) {
        const stack = requireStack(existingStackId);
        const activeToken = activeOperationByStack.get(stack.id);
        const operation = activeToken === undefined ? undefined : operations.get(activeToken);
        return {
          outcome: "existing",
          stack: copy(stack),
          operation: operation === undefined ? undefined : copy(operation),
        };
      }

      const baseStack: ManagedStackRecord = {
        id: input.stackId,
        projectId: input.identity.projectId,
        checkoutId: input.identity.checkoutId,
        contextId,
        name: input.stackName,
        status: "pending",
        lifecycle: "stopped",
        runtimeRequest: input.configuration.runtimeRequest ?? "auto",
        runtime: input.configuration.runtime,
        paths: input.paths,
        ports: [],
        serviceVersions: {},
        runtimeMetadata: emptyRuntimeMetadata(),
        createdAt: input.now,
        updatedAt: input.now,
      };
      const stack = applyConfiguration(baseStack, input.configuration, input.now);
      transitionPortOwnership(undefined, stack);
      stacks.set(stack.id, stack);
      stackIdentities.set(identityKey, stack.id);
      const claimed = claimOperation({
        token: input.operationToken,
        stackId: stack.id,
        kind: "start",
        ownerPid: input.ownerPid,
        now: input.now,
      });
      if (!claimed.acquired) {
        throw new ManagedOperationOwnershipError({ stackId: stack.id });
      }
      return { outcome: "create", stack: copy(stack), operation: claimed.operation };
    });
  };

  const publishPendingStack = (
    stackId: string,
    operationToken: string,
    now: string,
  ): ManagedStackRecord => {
    requireOwnedOperation(stackId, operationToken);
    const current = requireStack(stackId);
    const next: ManagedStackRecord = {
      ...current,
      status: "active",
      updatedAt: now,
    };
    stacks.set(stackId, next);
    const operation = operations.get(operationToken);
    if (operation !== undefined) {
      operations.set(operationToken, {
        ...operation,
        status: "completed",
        finishedAt: now,
      });
    }
    activeOperationByStack.delete(stackId);
    return copy(next);
  };

  const abortPendingStack = (stackId: string, operationToken: string): void => {
    requireOwnedOperation(stackId, operationToken);
    const stack = requireStack(stackId);
    if (stack.status !== "pending") {
      throw new ManagedOperationOwnershipError({ stackId });
    }
    discardPendingStack(stack, operationToken);
  };

  const finishOperation = (
    stackId: string,
    operationToken: string,
    outcome: "completed" | "failed",
    now: string,
    error?: string,
  ): void => {
    const operation = requireOwnedOperation(stackId, operationToken);
    operations.set(operationToken, {
      ...operation,
      status: outcome,
      finishedAt: now,
      error,
    });
    activeOperationByStack.delete(stackId);
  };

  const updateStack = (input: UpdateManagedStackInput): ManagedStackRecord => {
    requireOwnedOperation(input.stackId, input.operationToken);
    const current = requireStack(input.stackId);
    assertManagedStackUpdatable(current);
    const next = applyConfiguration(current, input, input.now);
    transitionPortOwnership(current, next);
    stacks.set(current.id, next);
    return copy(next);
  };

  const reconcileOperation = (
    stackId: string,
    operationToken: string,
    lifecycle: ManagedStackRecord["lifecycle"],
    now: string,
  ): ReconcileManagedOperationResult => {
    const operation = requireOwnedOperation(stackId, operationToken);
    const current = requireStack(stackId);
    if (current.status === "tombstoned") {
      // A tombstoned row under a live claim is a deletion that died before
      // releasing it. Registry state is already final, so recovery only
      // releases the claim; reviving a lifecycle here would resurrect a
      // deleted stack, and dropping the row would break idempotent deletion.
      operations.set(operationToken, {
        ...operation,
        status: "failed",
        finishedAt: now,
        error: "Recovered after an abandoned deletion",
      });
      activeOperationByStack.delete(stackId);
      return { outcome: "tombstoned", stack: copy(current) };
    }
    if (current.status === "pending" && lifecycle === "stopped") {
      discardPendingStack(current, operationToken);
      return { outcome: "discarded" };
    }
    const next: ManagedStackRecord = {
      ...current,
      status: current.status === "pending" ? "active" : current.status,
      lifecycle,
      updatedAt: now,
    };
    transitionPortOwnership(current, next);
    stacks.set(stackId, next);
    operations.set(operationToken, {
      ...operation,
      status: "failed",
      finishedAt: now,
      error: `Recovered after runtime reconciliation (${lifecycle})`,
    });
    activeOperationByStack.delete(stackId);
    return { outcome: "recovered", stack: copy(next) };
  };

  const tombstoneStack = (
    stackId: string,
    operationToken: string,
    now: string,
  ): ManagedStackRecord => {
    requireOwnedOperation(stackId, operationToken);
    const current = requireStack(stackId);
    const next: ManagedStackRecord = {
      ...current,
      status: "tombstoned",
      lifecycle: "stopped",
      ports: [],
      runtimeMetadata: emptyRuntimeMetadata(),
      updatedAt: now,
      tombstonedAt: now,
    };
    transitionPortOwnership(current, next);
    stacks.set(stackId, next);
    stackIdentities.delete(stackIdentityKey(current.checkoutId, current.contextId, current.name));
    return copy(next);
  };

  /**
   * The join the SQLite adapter does in SQL. A stack whose checkout or context
   * row is missing is a broken store rather than a listable stack, so it is a
   * defect here exactly as the adapter's inner join makes it unreachable there.
   */
  const projectStack = (stack: ManagedStackRecord): ManagedStackProjection => {
    const checkout = checkouts.get(stack.checkoutId);
    const context = contexts.get(stack.contextId);
    if (checkout === undefined || context === undefined) {
      throw new Error(`Managed stack ${stack.id} has no checkout or context row`);
    }
    return {
      ...stack,
      checkoutKind: checkout.kind,
      canonicalPath: [...locations.values()].find(
        (location) => location.checkoutId === stack.checkoutId && location.state === "active",
      )?.canonicalPath,
      contextKind: context.kind,
      contextLocator: context.locator,
    };
  };

  const listIdentityClaims = (projectId?: string): ManagedIdentityClaims => {
    const projectCheckoutIds = new Set(
      [...checkouts.values()]
        .filter((checkout) => projectId === undefined || checkout.projectId === projectId)
        .map((checkout) => checkout.id),
    );
    const projectContextIds = new Set(
      [...contexts.values()]
        .filter((context) => projectId === undefined || context.projectId === projectId)
        .map((context) => context.id),
    );
    return {
      locations: [...locations.values()]
        .filter((location) => {
          if (projectId === undefined) return true;
          return projectCheckoutIds.has(location.checkoutId);
        })
        .sort((left, right) => compareManagedText(left.canonicalPath, right.canonicalPath))
        .map(copy),
      contexts: [...contexts.values()]
        .filter((context) => projectContextIds.has(context.id))
        .sort((left, right) => compareManagedText(left.id, right.id))
        .map(copy),
      transitions: [...transitions.values()]
        .filter(
          (transition) =>
            projectId === undefined ||
            transition.projectId === projectId ||
            (transition.checkoutId !== undefined &&
              projectCheckoutIds.has(transition.checkoutId)) ||
            (transition.contextId !== undefined && projectContextIds.has(transition.contextId)),
        )
        .sort(
          (left, right) =>
            compareManagedText(left.createdAt, right.createdAt) ||
            compareManagedText(left.id, right.id),
        )
        .map(copy),
    };
  };

  const applyCheckoutLocation = (
    input: ApplyManagedCheckoutLocationInput,
  ): ManagedCheckoutLocationDecision =>
    atomic(() => {
      const decision = decideManagedCheckoutLocation({
        requested: input,
        checkoutLocations: [...locations.values()],
        checkoutExists: checkouts.has(input.checkoutId),
      });
      if (decision.updates !== undefined) {
        for (const updated of decision.updates) locations.set(updated.id, updated);
      }
      locations.set(decision.location.id, decision.location);
      return { ...decision, location: copy(decision.location) };
    });

  const refreshContextOwner = (input: RefreshManagedContextOwnerInput): ManagedContextRecord =>
    atomic(() => {
      const context = contexts.get(input.contextId);
      const next = decideManagedContextOwnerRefresh({ existing: context, requested: input });
      contexts.set(next.id, next);
      return copy(next);
    });

  const migrateContextToBranch = (
    input: MigrateManagedContextToBranchInput,
  ): ManagedContextRecord =>
    atomic(() => {
      const existing = contexts.get(input.contextId);
      const next = decideManagedContextToBranch({
        requested: input,
        existing,
        branchContexts: [...contexts.values()],
      });
      if (existing === undefined || existing !== next) {
        contexts.set(next.id, next);
      }
      return copy(next);
    });

  const reserveIdentityTransition = (
    input: ReserveManagedIdentityTransitionInput,
  ): ManagedIdentityTransitionRecord =>
    atomic(() => {
      const existing = transitions.get(input.id);
      const requestedKeys = transitionResourceKeys(input);
      const resourceOwner = [...transitions.values()].find(
        (candidate) =>
          candidate.phase !== "finalized" &&
          transitionResourceKeys(candidate).some((key) => requestedKeys.includes(key)),
      );
      const next = decideManagedIdentityTransitionReservation({
        requested: input,
        existing,
        resourceOwner,
      });
      transitions.set(next.id, next);
      return copy(next);
    });

  const advanceIdentityTransition = (
    input: AdvanceManagedIdentityTransitionInput,
  ): ManagedIdentityTransitionRecord =>
    atomic(() => {
      const existing = transitions.get(input.id);
      if (existing === undefined)
        throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
      const next = decideManagedIdentityTransitionAdvance(existing, input);
      transitions.set(next.id, next);
      return copy(next);
    });

  const pruneIdentityMetadata = (
    input: PruneManagedIdentityMetadataInput,
  ): PruneManagedIdentityMetadataResult =>
    atomic(() => {
      const decision = decideManagedIdentityMetadataPrune({
        locations: [...locations.values()],
        locationIds: input.locationIds,
        transitions: [...transitions.values()],
      });
      for (const id of decision.prunedRecordIds) locations.delete(id);
      return decision;
    });

  const listStackRecords = (options?: {
    readonly includeTombstoned?: boolean;
  }): ReadonlyArray<ManagedStackRecord> =>
    [...stacks.values()]
      .filter((stack) => options?.includeTombstoned === true || stack.status !== "tombstoned")
      .sort(
        (left, right) =>
          compareManagedText(left.createdAt, right.createdAt) ||
          compareManagedText(left.id, right.id),
      );

  const listStackProjectionsByIdentity = (
    identity: ManagedIdentityTriple,
    options?: { readonly includeTombstoned?: boolean },
  ): ReadonlyArray<ManagedStackProjection> =>
    listStackRecords(options)
      .filter(
        (stack) =>
          stack.projectId === identity.projectId &&
          stack.checkoutId === identity.checkoutId &&
          stack.contextId === identity.contextId,
      )
      .map(projectStack);

  return {
    registerCheckoutIdentity: (input) =>
      Effect.try({
        try: () => registerCheckoutIdentity(input),
        catch: failsWith<ManagedCheckoutIdentityRegistrationFailure>(
          DuplicateManagedIdentityError,
          ManagedCheckoutConflictError,
          ManagedInaccessiblePathError,
        ),
      }),
    listIdentityClaims: (projectId) => Effect.sync(() => listIdentityClaims(projectId)),
    applyCheckoutLocation: (input) =>
      Effect.try({
        try: () => applyCheckoutLocation(input),
        catch: failsWith<ManagedIdentityRecoveryError>(
          ManagedCheckoutConflictError,
          ManagedCopiedBranchConflictError,
          ManagedIdentityTransitionOwnershipError,
          ManagedInaccessiblePathError,
        ),
      }),
    refreshContextOwner: (input) =>
      Effect.try({
        try: () => refreshContextOwner(input),
        catch: failsWith<ManagedIdentityRecoveryError>(ManagedCopiedBranchConflictError),
      }),
    migrateContextToBranch: (input) =>
      Effect.try({
        try: () => migrateContextToBranch(input),
        catch: failsWith<MigrateManagedContextToBranchFailure>(
          DuplicateManagedIdentityError,
          ManagedCopiedBranchConflictError,
        ),
      }),
    reserveIdentityTransition: (input) =>
      Effect.try({
        try: () => reserveIdentityTransition(input),
        catch: failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
      }),
    advanceIdentityTransition: (input) =>
      Effect.try({
        try: () => advanceIdentityTransition(input),
        catch: failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
      }),
    finalizeIdentityTransition: (input) =>
      Effect.try({
        try: () => {
          const existing = transitions.get(input.id);
          if (existing === undefined)
            throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
          const next = decideManagedIdentityTransitionFinalize(existing, input);
          transitions.set(next.id, next);
          return copy(next);
        },
        catch: failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
      }),
    prepareStack: (input) =>
      Effect.try({
        try: () => prepareStack(input),
        catch: failsWith<PrepareStackFailure>(
          DuplicateManagedIdentityError,
          ManagedCheckoutConflictError,
          ManagedCopiedBranchConflictError,
          ManagedIdentityTransitionOwnershipError,
          ManagedInaccessiblePathError,
          DuplicateManagedPortKeyError,
          InvalidManagedOwnerPidError,
          InvalidManagedPortError,
          ManagedOperationOwnershipError,
          ManagedPortReservationError,
          ManagedStackNotFoundError,
        ),
      }),
    publishPendingStack: (stackId, operationToken, now) =>
      Effect.try({
        try: () => publishPendingStack(stackId, operationToken, now),
        catch: failsWith<OwnedManagedStackFailure>(
          ManagedOperationOwnershipError,
          ManagedStackNotFoundError,
        ),
      }),
    abortPendingStack: (stackId, operationToken) =>
      Effect.try({
        try: () => abortPendingStack(stackId, operationToken),
        catch: failsWith<OwnedManagedStackFailure>(
          ManagedOperationOwnershipError,
          ManagedStackNotFoundError,
        ),
      }),
    getStack: (stackId) =>
      Effect.sync(() => {
        const stack = stacks.get(stackId);
        return stack === undefined ? undefined : copy(stack);
      }),
    listStacks: (options) => Effect.sync(() => listStackRecords(options).map(copy)),
    getStackProjection: (stackId) =>
      Effect.sync(() => {
        const stack = stacks.get(stackId);
        return stack === undefined ? undefined : copy(projectStack(stack));
      }),
    listStackProjections: (options) =>
      Effect.sync(() =>
        options?.identity === undefined
          ? listStackRecords(options).map((stack) => copy(projectStack(stack)))
          : listStackProjectionsByIdentity(options.identity, options).map(copy),
      ),
    findCheckoutContext: (checkoutId, kind) =>
      Effect.sync(() => {
        const context = [...contexts.values()].find(
          (candidate) => candidate.checkoutId === checkoutId && candidate.kind === kind,
        );
        return context === undefined ? undefined : copy(context);
      }),
    claimOperation: (input) =>
      Effect.try({
        try: () => claimOperation(input),
        catch: failsWith<ClaimManagedOperationFailure>(
          InvalidManagedOwnerPidError,
          ManagedStackNotFoundError,
        ),
      }),
    finishOperation: (stackId, operationToken, outcome, now, error) =>
      Effect.try({
        try: () => finishOperation(stackId, operationToken, outcome, now, error),
        catch: failsWith<ManagedOperationOwnershipError>(ManagedOperationOwnershipError),
      }),
    updateStack: (input) =>
      Effect.try({
        try: () => updateStack(input),
        catch: failsWith<UpdateManagedStackFailure>(
          DuplicateManagedPortKeyError,
          InvalidManagedPortError,
          ManagedOperationOwnershipError,
          ManagedPendingStackUpdateError,
          ManagedPortReservationError,
          ManagedRunningStackPortChangeError,
          ManagedStackNotFoundError,
        ),
      }),
    listActiveOperations: (startedBefore) =>
      Effect.sync(() =>
        [...activeOperationByStack.values()]
          .flatMap((token) => {
            const operation = operations.get(token);
            return operation === undefined ? [] : [operation];
          })
          .filter((operation) => startedBefore === undefined || operation.startedAt < startedBefore)
          // Recovery walks this list, so claims sharing one `startedAt` must not
          // fall back to insertion order: the token breaks the tie in both adapters.
          .sort(
            (left, right) =>
              compareManagedText(left.startedAt, right.startedAt) ||
              compareManagedText(left.token, right.token),
          )
          .map(copy),
      ),
    reconcileOperation: (stackId, operationToken, lifecycle, now) =>
      Effect.try({
        try: () => reconcileOperation(stackId, operationToken, lifecycle, now),
        catch: failsWith<ReconcileManagedOperationFailure>(
          DuplicateManagedPortKeyError,
          InvalidManagedPortError,
          ManagedOperationOwnershipError,
          ManagedPortReservationError,
          ManagedStackNotFoundError,
        ),
      }),
    tombstoneStack: (stackId, operationToken, now) =>
      Effect.try({
        try: () => tombstoneStack(stackId, operationToken, now),
        catch: failsWith<OwnedManagedStackFailure>(
          ManagedOperationOwnershipError,
          ManagedStackNotFoundError,
        ),
      }),
    listCheckoutLocations: () =>
      Effect.sync(() =>
        [...locations.values()]
          .sort((left, right) => compareManagedText(left.canonicalPath, right.canonicalPath))
          .map(copy),
      ),
    pruneIdentityMetadata: (input) =>
      Effect.try({
        try: () => pruneIdentityMetadata(input),
        catch: failsWith<ManagedIdentityRecoveryError>(
          ManagedCheckoutConflictError,
          ManagedCopiedBranchConflictError,
          ManagedIdentityTransitionOwnershipError,
          ManagedInaccessiblePathError,
        ),
      }),
    pruneCheckoutLocations: (locationIds) =>
      Effect.sync(() => {
        const decision = decideManagedIdentityMetadataPrune({
          locations: [...locations.values()],
          locationIds,
          transitions: [...transitions.values()],
        });
        for (const id of decision.prunedRecordIds) locations.delete(id);
        return decision.removed;
      }),
  };
};
