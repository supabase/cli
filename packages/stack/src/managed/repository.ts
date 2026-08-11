import {
  DuplicateManagedIdentityError,
  ManagedOperationOwnershipError,
  ManagedPortReservationError,
  ManagedStackNotFoundError,
  type ManagedCheckoutLocation,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedPortAssignment,
  type ManagedRuntimeMetadata,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackPaths,
  type ManagedStackRecord,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";

export interface PrepareOrdinaryStackInput {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly canonicalPath: string;
  readonly locationId: string;
  readonly stackId: string;
  readonly stackName: string;
  readonly paths: ManagedStackPaths;
  readonly operationToken: string;
  readonly ownerPid?: number;
  readonly now: string;
  readonly configuration: ManagedStackConfiguration;
}

export type PrepareOrdinaryStackResult =
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

export interface ManagedStackRepository {
  readonly kind: "in-memory" | "sqlite";
  prepareOrdinaryStack(input: PrepareOrdinaryStackInput): PrepareOrdinaryStackResult;
  publishPendingStack(stackId: string, operationToken: string, now: string): ManagedStackRecord;
  abortPendingStack(stackId: string, operationToken: string): void;
  getStack(stackId: string): ManagedStackRecord | undefined;
  getStackByIdentity(
    checkoutId: string,
    contextId: string,
    stackName: string,
  ): ManagedStackRecord | undefined;
  listStacks(options?: { readonly includeTombstoned?: boolean }): ReadonlyArray<ManagedStackRecord>;
  claimOperation(input: ClaimManagedOperationInput): ClaimManagedOperationResult;
  finishOperation(
    stackId: string,
    operationToken: string,
    outcome: "completed" | "failed",
    now: string,
    error?: string,
  ): void;
  updateStack(input: UpdateManagedStackInput): ManagedStackRecord;
  listActiveOperations(startedBefore?: string): ReadonlyArray<ManagedOperationRecord>;
  reconcileOperation(
    stackId: string,
    operationToken: string,
    lifecycle: ManagedStackLifecycle,
    now: string,
  ): ManagedStackRecord;
  tombstoneStack(stackId: string, operationToken: string, now: string): ManagedStackRecord;
  listCheckoutLocations(): ReadonlyArray<ManagedCheckoutLocation>;
  pruneCheckoutLocations(locationIds: ReadonlyArray<string>): number;
  close(): void;
}

interface InMemoryCheckout {
  readonly id: string;
  readonly projectId: string;
}

interface InMemoryContext {
  readonly id: string;
  readonly checkoutId: string;
}

const stackIdentityKey = (checkoutId: string, contextId: string, stackName: string): string =>
  `${checkoutId}\u0000${contextId}\u0000${stackName}`;

const copy = <A>(value: A): A => structuredClone(value);

const applyConfiguration = (
  stack: ManagedStackRecord,
  configuration: ManagedStackConfiguration,
  now: string,
): ManagedStackRecord => ({
  ...stack,
  lifecycle: configuration.lifecycle ?? stack.lifecycle,
  runtimeRequest: configuration.runtimeRequest ?? stack.runtimeRequest,
  runtime: configuration.runtime ?? stack.runtime,
  ports: configuration.ports ?? stack.ports,
  serviceVersions: configuration.serviceVersions ?? stack.serviceVersions,
  runtimeMetadata: configuration.runtimeMetadata ?? stack.runtimeMetadata,
  configFingerprint: configuration.configFingerprint ?? stack.configFingerprint,
  credentialsReference: configuration.credentialsReference ?? stack.credentialsReference,
  updatedAt: now,
});

const emptyRuntimeMetadata = (): ManagedRuntimeMetadata => ({
  processIds: {},
  containerIds: {},
});

export const createInMemoryManagedStackRepository = (): ManagedStackRepository => {
  const projects = new Set<string>();
  const checkouts = new Map<string, InMemoryCheckout>();
  const contexts = new Map<string, InMemoryContext>();
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
      throw new ManagedStackNotFoundError(stackId);
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
      throw new ManagedOperationOwnershipError(stackId);
    }
    return operation;
  };

  const reservePorts = (
    stackId: string,
    current: ReadonlyArray<ManagedPortAssignment>,
    next: ReadonlyArray<ManagedPortAssignment>,
  ): void => {
    for (const assignment of next) {
      const owner = portOwners.get(assignment.port);
      if (owner !== undefined && owner !== stackId) {
        throw new ManagedPortReservationError(assignment.port, owner);
      }
    }
    for (const assignment of current) {
      if (portOwners.get(assignment.port) === stackId) {
        portOwners.delete(assignment.port);
      }
    }
    for (const assignment of next) {
      portOwners.set(assignment.port, stackId);
    }
  };

  const claimOperation = (input: ClaimManagedOperationInput): ClaimManagedOperationResult => {
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

  return {
    kind: "in-memory",
    prepareOrdinaryStack(input) {
      return atomic(() => {
        projects.add(input.identity.projectId);
        const checkout = checkouts.get(input.identity.checkoutId);
        if (checkout !== undefined && checkout.projectId !== input.identity.projectId) {
          throw new DuplicateManagedIdentityError(
            input.identity.checkoutId,
            checkout.projectId,
            input.identity.projectId,
          );
        }
        checkouts.set(input.identity.checkoutId, {
          id: input.identity.checkoutId,
          projectId: input.identity.projectId,
        });

        const context = contexts.get(input.identity.contextId);
        if (context !== undefined && context.checkoutId !== input.identity.checkoutId) {
          throw new DuplicateManagedIdentityError(
            input.identity.checkoutId,
            context.checkoutId,
            input.identity.contextId,
          );
        }
        contexts.set(input.identity.contextId, {
          id: input.identity.contextId,
          checkoutId: input.identity.checkoutId,
        });

        const existingLocation = [...locations.values()].find(
          (location) => location.checkoutId === input.identity.checkoutId,
        );
        if (
          existingLocation !== undefined &&
          existingLocation.canonicalPath !== input.canonicalPath
        ) {
          throw new DuplicateManagedIdentityError(
            input.identity.checkoutId,
            existingLocation.canonicalPath,
            input.canonicalPath,
          );
        }
        const pathOwner = [...locations.values()].find(
          (location) => location.canonicalPath === input.canonicalPath,
        );
        if (pathOwner !== undefined && pathOwner.checkoutId !== input.identity.checkoutId) {
          throw new DuplicateManagedIdentityError(
            input.identity.checkoutId,
            pathOwner.canonicalPath,
            input.canonicalPath,
          );
        }
        locations.set(existingLocation?.id ?? input.locationId, {
          id: existingLocation?.id ?? input.locationId,
          checkoutId: input.identity.checkoutId,
          canonicalPath: input.canonicalPath,
          lastSeenAt: input.now,
        });

        const identityKey = stackIdentityKey(
          input.identity.checkoutId,
          input.identity.contextId,
          input.stackName,
        );
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
          contextId: input.identity.contextId,
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
        reservePorts(stack.id, [], stack.ports);
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
          throw new ManagedOperationOwnershipError(stack.id);
        }
        return { outcome: "create", stack: copy(stack), operation: claimed.operation };
      });
    },
    publishPendingStack(stackId, operationToken, now) {
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
    },
    abortPendingStack(stackId, operationToken) {
      requireOwnedOperation(stackId, operationToken);
      const stack = requireStack(stackId);
      if (stack.status !== "pending") {
        throw new ManagedOperationOwnershipError(stackId);
      }
      reservePorts(stack.id, stack.ports, []);
      stacks.delete(stackId);
      stackIdentities.delete(stackIdentityKey(stack.checkoutId, stack.contextId, stack.name));
      operations.delete(operationToken);
      activeOperationByStack.delete(stackId);
    },
    getStack(stackId) {
      const stack = stacks.get(stackId);
      return stack === undefined ? undefined : copy(stack);
    },
    getStackByIdentity(checkoutId, contextId, stackName) {
      const stackId = stackIdentities.get(stackIdentityKey(checkoutId, contextId, stackName));
      if (stackId === undefined) {
        return undefined;
      }
      const stack = stacks.get(stackId);
      return stack === undefined ? undefined : copy(stack);
    },
    listStacks(options) {
      return [...stacks.values()]
        .filter((stack) => options?.includeTombstoned === true || stack.status !== "tombstoned")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(copy);
    },
    claimOperation,
    finishOperation(stackId, operationToken, outcome, now, error) {
      const operation = requireOwnedOperation(stackId, operationToken);
      operations.set(operationToken, {
        ...operation,
        status: outcome,
        finishedAt: now,
        error,
      });
      activeOperationByStack.delete(stackId);
    },
    updateStack(input) {
      requireOwnedOperation(input.stackId, input.operationToken);
      const current = requireStack(input.stackId);
      const next = applyConfiguration(current, input, input.now);
      reservePorts(current.id, current.ports, next.ports);
      stacks.set(current.id, next);
      return copy(next);
    },
    listActiveOperations(startedBefore) {
      return [...activeOperationByStack.values()]
        .flatMap((token) => {
          const operation = operations.get(token);
          return operation === undefined ? [] : [operation];
        })
        .filter((operation) => startedBefore === undefined || operation.startedAt < startedBefore)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map(copy);
    },
    reconcileOperation(stackId, operationToken, lifecycle, now) {
      const operation = requireOwnedOperation(stackId, operationToken);
      const current = requireStack(stackId);
      const next: ManagedStackRecord = { ...current, lifecycle, updatedAt: now };
      stacks.set(stackId, next);
      operations.set(operationToken, {
        ...operation,
        status: "failed",
        finishedAt: now,
        error: `Recovered after runtime reconciliation (${lifecycle})`,
      });
      activeOperationByStack.delete(stackId);
      return copy(next);
    },
    tombstoneStack(stackId, operationToken, now) {
      requireOwnedOperation(stackId, operationToken);
      const current = requireStack(stackId);
      reservePorts(current.id, current.ports, []);
      const next: ManagedStackRecord = {
        ...current,
        status: "tombstoned",
        lifecycle: "stopped",
        ports: [],
        runtimeMetadata: emptyRuntimeMetadata(),
        updatedAt: now,
        tombstonedAt: now,
      };
      stacks.set(stackId, next);
      stackIdentities.delete(stackIdentityKey(current.checkoutId, current.contextId, current.name));
      return copy(next);
    },
    listCheckoutLocations() {
      return [...locations.values()]
        .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath))
        .map(copy);
    },
    pruneCheckoutLocations(locationIds) {
      let removed = 0;
      for (const id of new Set(locationIds)) {
        if (locations.delete(id)) {
          removed += 1;
        }
      }
      return removed;
    },
    close() {},
  };
};
