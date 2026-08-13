import { Effect } from "effect";
import {
  DuplicateManagedIdentityError,
  DuplicateManagedPortKeyError,
  InvalidManagedOwnerPidError,
  InvalidManagedPortError,
  ManagedOperationOwnershipError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  type ManagedCheckoutKind,
  type ManagedCheckoutLocation,
  type ManagedContextRecord,
  type ManagedOperationRecord,
  type ManagedRuntimeMetadata,
  type ManagedStackConfiguration,
  type ManagedStackProjection,
  type ManagedStackRecord,
} from "./model.ts";
import { failsWith } from "./failure.ts";
import {
  assertManagedOwnerPid,
  assertManagedStackUpdatable,
  compareManagedText,
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

  /** The in-memory counterpart of the SQLite adapter's `registerContext`. */
  const registerContext = (input: PrepareStackInput): string => {
    const requested = input.identity.contextId;
    if (input.context.kind !== "branch") {
      const owned = [...contexts.values()].find(
        (candidate) =>
          candidate.checkoutId === input.identity.checkoutId &&
          candidate.kind === input.context.kind,
      );
      if (owned !== undefined) {
        return owned.id;
      }
    }
    const existing = contexts.get(requested);
    if (existing !== undefined) {
      const existingClaim = existing.checkoutId ?? existing.projectId;
      const requestedClaim =
        input.context.kind === "branch" ? input.identity.projectId : input.identity.checkoutId;
      if (existing.kind !== input.context.kind || existingClaim !== requestedClaim) {
        throw new DuplicateManagedIdentityError({
          identityId: requested,
          existingClaim,
          requestedClaim,
        });
      }
      if (input.context.kind === "branch" && existing.locator !== input.context.locator) {
        contexts.set(requested, { ...existing, locator: input.context.locator });
      }
      return requested;
    }
    contexts.set(requested, {
      id: requested,
      projectId: input.identity.projectId,
      checkoutId: input.context.kind === "branch" ? undefined : input.identity.checkoutId,
      kind: input.context.kind,
      locator: input.context.kind === "branch" ? input.context.locator : undefined,
      createdAt: input.now,
    });
    return requested;
  };

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

      const existingLocation = [...locations.values()].find(
        (location) => location.checkoutId === input.identity.checkoutId,
      );
      if (
        existingLocation !== undefined &&
        existingLocation.canonicalPath !== input.checkoutRootPath
      ) {
        throw new DuplicateManagedIdentityError({
          identityId: input.identity.checkoutId,
          existingClaim: existingLocation.canonicalPath,
          requestedClaim: input.checkoutRootPath,
        });
      }
      const pathOwner = [...locations.values()].find(
        (location) => location.canonicalPath === input.checkoutRootPath,
      );
      if (pathOwner !== undefined && pathOwner.checkoutId !== input.identity.checkoutId) {
        throw new DuplicateManagedIdentityError({
          identityId: input.checkoutRootPath,
          existingClaim: pathOwner.checkoutId,
          requestedClaim: input.identity.checkoutId,
        });
      }
      locations.set(existingLocation?.id ?? input.locationId, {
        id: existingLocation?.id ?? input.locationId,
        checkoutId: input.identity.checkoutId,
        canonicalPath: input.checkoutRootPath,
        lastSeenAt: input.now,
      });

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
        (location) => location.checkoutId === stack.checkoutId,
      )?.canonicalPath,
      contextKind: context.kind,
      contextLocator: context.locator,
    };
  };

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

  return {
    prepareStack: (input) =>
      Effect.try({
        try: () => prepareStack(input),
        catch: failsWith<PrepareStackFailure>(
          DuplicateManagedIdentityError,
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
      Effect.sync(() => listStackRecords(options).map((stack) => copy(projectStack(stack)))),
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
    pruneCheckoutLocations: (locationIds) =>
      Effect.sync(() => {
        let removed = 0;
        for (const id of new Set(locationIds)) {
          if (locations.delete(id)) {
            removed += 1;
          }
        }
        return removed;
      }),
  };
};
