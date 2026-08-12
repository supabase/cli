import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_MANAGED_STACK_NAME,
  InvalidManagedStackNameError,
  ManagedAbandonedOperationError,
  ManagedOperationInProgressError,
  ManagedOperationOwnershipError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  ManagedStackPublicationTimeoutError,
  type ManagedCheckoutLocation,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedStackConfiguration,
  type ManagedStackLifecycle,
  type ManagedStackRecord,
  type ManagedStackSelection,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import {
  canonicalizeOrdinaryWorkspacePath,
  ensureOrdinaryWorkspaceIdentity,
  readOrdinaryWorkspaceIdentity,
} from "./identity.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { assertManagedStackRoot, managedStackPaths } from "./paths.ts";
import type { ManagedStackRepository } from "./repository.ts";

export interface ManagedStackServiceOptions {
  readonly repository: ManagedStackRepository;
  readonly stateRoot: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly ownerPid?: number;
  readonly publicationTimeoutMs?: number;
  readonly publicationPollMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface ProvisionOrdinaryStackOptions {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly configuration?: ManagedStackConfiguration;
  readonly initialize?: (stack: ManagedStackRecord) => Promise<void>;
  readonly validate?: (stack: ManagedStackRecord) => Promise<void>;
}

export interface ProvisionOrdinaryStackResult {
  readonly outcome: "create" | "reuse";
  readonly selection: ManagedStackSelection;
  readonly stack: ManagedStackRecord;
  readonly identityMarkerCreated: boolean;
}

export interface InspectOrdinaryWorkspaceResult {
  readonly registered: boolean;
  readonly identity?: OrdinaryWorkspaceIdentity;
  readonly stacks: ReadonlyArray<ManagedStackRecord>;
}

export interface DeleteManagedStackResult {
  readonly outcome: "delete" | "no-op";
  readonly stack: ManagedStackRecord;
  readonly dataReclamation:
    | { readonly outcome: "removed" }
    | { readonly outcome: "retained"; readonly error: unknown };
}

interface ReconcileAbandonedOperationsBaseOptions {
  readonly inspectRuntime: (
    stack: ManagedStackRecord,
    operation: ManagedOperationRecord,
  ) => Promise<"running" | "stopped" | "unknown">;
}

export type ReconcileAbandonedOperationsOptions = ReconcileAbandonedOperationsBaseOptions &
  (
    | {
        readonly startedBefore?: string;
        readonly force?: never;
      }
    | {
        readonly startedBefore?: never;
        readonly force: {
          readonly stackId: string;
          readonly operationToken: string;
        };
      }
  );

export interface RetainedManagedOperation {
  readonly operation: ManagedOperationRecord;
  readonly reason:
    | "owner-alive"
    | "owner-liveness-unknown"
    | "runtime-inspection-failed"
    | "runtime-unknown";
  readonly error?: unknown;
}

export interface ManagedOperationRecoveryFailure {
  readonly operation: ManagedOperationRecord;
  readonly phase: "reconciliation" | "state-reclamation";
  readonly operationReleased: boolean;
  readonly error: unknown;
}

export interface ReconcileAbandonedOperationsResult {
  readonly recovered: ReadonlyArray<ManagedStackRecord>;
  readonly abortedStackIds: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<RetainedManagedOperation>;
  readonly skippedOperationIds: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<ManagedOperationRecoveryFailure>;
}

export interface ManagedStackService {
  readonly stateRoot: string;
  readonly repository: ManagedStackRepository;
  provisionOrdinaryStack(
    options: ProvisionOrdinaryStackOptions,
  ): Promise<ProvisionOrdinaryStackResult>;
  inspectOrdinaryWorkspace(workspacePath: string): Promise<InspectOrdinaryWorkspaceResult>;
  inspectStack(stackId: string): ManagedStackRecord | undefined;
  listStacks(options?: { readonly includeTombstoned?: boolean }): ReadonlyArray<ManagedStackRecord>;
  updateStack(
    stackId: string,
    configuration: ManagedStackConfiguration,
  ): Promise<ManagedStackRecord>;
  deleteStack(
    stackId: string,
    options?: { readonly stop?: (stack: ManagedStackRecord) => Promise<void> },
  ): Promise<DeleteManagedStackResult>;
  reconcileAbandonedOperations(
    options: ReconcileAbandonedOperationsOptions,
  ): Promise<ReconcileAbandonedOperationsResult>;
  pruneCheckoutLocations(
    shouldPrune: (location: ManagedCheckoutLocation) => boolean | Promise<boolean>,
  ): Promise<number>;
  close(): void;
}

const selectionForStack = (stack: ManagedStackRecord): ManagedStackSelection => ({
  projectId: stack.projectId,
  checkoutId: stack.checkoutId,
  contextId: stack.contextId,
  stackId: stack.id,
  stackName: stack.name,
});

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const stackNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
};

export const makeManagedStackService = (
  options: ManagedStackServiceOptions,
): ManagedStackService => {
  // Anchored once, at the boundary: a relative root injected here would be
  // reinterpreted against the process' cwd at every later use.
  const stateRoot = resolve(options.stateRoot);
  const idFactory = options.idFactory ?? randomUUID;
  const clock = options.clock ?? (() => new Date());
  const ownerPid = options.ownerPid ?? process.pid;
  const publicationTimeoutMs = options.publicationTimeoutMs ?? 10_000;
  const publicationPollMs = options.publicationPollMs ?? 10;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const now = (): string => clock().toISOString();

  const removeStackState = async (stack: ManagedStackRecord): Promise<void> => {
    const root = assertManagedStackRoot(stateRoot, stack.id, stack.paths.root);
    await rm(root, { force: true, recursive: true });
  };

  const reclaimStackState = async (
    stack: ManagedStackRecord,
  ): Promise<DeleteManagedStackResult["dataReclamation"]> => {
    try {
      await removeStackState(stack);
      return { outcome: "removed" };
    } catch (error: unknown) {
      return { outcome: "retained", error };
    }
  };

  const finishOperationBestEffort = (
    stackId: string,
    operationToken: string,
    error: unknown,
  ): boolean => {
    try {
      options.repository.finishOperation(stackId, operationToken, "failed", now(), String(error));
      return true;
    } catch {
      // Preserve the operation's original failure when ownership changed concurrently.
      return false;
    }
  };

  const failRecoveryBestEffort = (
    stack: ManagedStackRecord | undefined,
    operation: ManagedOperationRecord,
    error: unknown,
  ): boolean => {
    if (stack === undefined || stack.status === "pending") {
      return false;
    }
    try {
      options.repository.updateStack({
        stackId: operation.stackId,
        operationToken: operation.token,
        lifecycle: "failed",
        now: now(),
      });
    } catch {
      // Releasing the abandoned claim is still useful if the failed lifecycle cannot be recorded.
    }
    return finishOperationBestEffort(operation.stackId, operation.token, error);
  };

  const requireOperation = (
    stackId: string,
    kind: ManagedOperationKind,
  ): ManagedOperationRecord => {
    const claimed = options.repository.claimOperation({
      token: createManagedUuid(idFactory, "operation token"),
      stackId,
      kind,
      ownerPid,
      now: now(),
    });
    if (!claimed.acquired) {
      throw new ManagedOperationInProgressError(stackId, claimed.operation);
    }
    return claimed.operation;
  };

  const awaitPublication = async (pending: ManagedStackRecord): Promise<ManagedStackRecord> => {
    const deadline = performance.now() + publicationTimeoutMs;
    while (performance.now() <= deadline) {
      const current = options.repository.getStack(pending.id);
      if (current === undefined) {
        throw new ManagedAbandonedOperationError(pending.id);
      }
      if (current.status === "active") {
        return current;
      }
      if (current.status === "tombstoned") {
        throw new ManagedStackNotFoundError(current.id);
      }
      await wait(publicationPollMs);
    }
    throw new ManagedStackPublicationTimeoutError(pending.id);
  };

  const updateStackRecord = async (
    stackId: string,
    configuration: ManagedStackConfiguration,
  ): Promise<ManagedStackRecord> => {
    const operation = requireOperation(stackId, "update");
    try {
      const stack = options.repository.updateStack({
        stackId,
        operationToken: operation.token,
        now: now(),
        ...configuration,
      });
      options.repository.finishOperation(stackId, operation.token, "completed", now());
      return stack;
    } catch (error: unknown) {
      finishOperationBestEffort(stackId, operation.token, error);
      throw error;
    }
  };

  /**
   * Reused stacks adopt the caller's requested configuration regardless of
   * whether the record was already published or was awaited while another
   * caller published it, so the outcome never depends on that timing.
   */
  const applyRequestedConfiguration = async (
    stack: ManagedStackRecord,
    configuration: ManagedStackConfiguration | undefined,
  ): Promise<ManagedStackRecord> =>
    configuration === undefined || Object.keys(configuration).length === 0
      ? stack
      : updateStackRecord(stack.id, configuration);

  return {
    stateRoot,
    repository: options.repository,
    async provisionOrdinaryStack(provisionOptions) {
      const stackName = provisionOptions.stackName ?? DEFAULT_MANAGED_STACK_NAME;
      if (!stackNamePattern.test(stackName)) {
        throw new InvalidManagedStackNameError(stackName);
      }
      const canonicalPath = await canonicalizeOrdinaryWorkspacePath(provisionOptions.workspacePath);
      const marker = await ensureOrdinaryWorkspaceIdentity(canonicalPath, idFactory);
      const stackId = createManagedUuid(idFactory, "stackId");
      const prepared = options.repository.prepareOrdinaryStack({
        identity: marker.identity,
        canonicalPath,
        locationId: createManagedUuid(idFactory, "checkout location id"),
        stackId,
        stackName,
        paths: managedStackPaths(stateRoot, stackId),
        operationToken: createManagedUuid(idFactory, "operation token"),
        ownerPid,
        now: now(),
        configuration: provisionOptions.configuration ?? {},
      });

      if (prepared.outcome === "existing") {
        if (prepared.stack.status === "active") {
          if (prepared.operation !== undefined) {
            throw new ManagedOperationInProgressError(prepared.stack.id, prepared.operation);
          }
          const stack = await applyRequestedConfiguration(
            prepared.stack,
            provisionOptions.configuration,
          );
          return {
            outcome: "reuse",
            selection: selectionForStack(stack),
            stack,
            identityMarkerCreated: marker.created,
          };
        }
        if (prepared.operation === undefined) {
          throw new ManagedAbandonedOperationError(prepared.stack.id);
        }
        if (
          prepared.operation.ownerPid === undefined ||
          !(await isProcessAlive(prepared.operation.ownerPid))
        ) {
          throw new ManagedAbandonedOperationError(prepared.stack.id);
        }
        const published = await applyRequestedConfiguration(
          await awaitPublication(prepared.stack),
          provisionOptions.configuration,
        );
        return {
          outcome: "reuse",
          selection: selectionForStack(published),
          stack: published,
          identityMarkerCreated: marker.created,
        };
      }

      try {
        await mkdir(prepared.stack.paths.data, { recursive: true });
        await mkdir(prepared.stack.paths.logs, { recursive: true });
        await mkdir(prepared.stack.paths.runtime, { recursive: true });
        await provisionOptions.initialize?.(prepared.stack);
        await provisionOptions.validate?.(prepared.stack);
        const published = options.repository.publishPendingStack(
          prepared.stack.id,
          prepared.operation.token,
          now(),
        );
        return {
          outcome: "create",
          selection: selectionForStack(published),
          stack: published,
          identityMarkerCreated: marker.created,
        };
      } catch (cause: unknown) {
        const cleanupErrors: Array<unknown> = [];
        let aborted = false;
        try {
          options.repository.abortPendingStack(prepared.stack.id, prepared.operation.token);
          aborted = true;
        } catch (error: unknown) {
          cleanupErrors.push(error);
        }
        if (aborted) {
          try {
            await removeStackState(prepared.stack);
          } catch (error: unknown) {
            cleanupErrors.push(error);
          }
        }
        throw new ManagedStackInitializationError(prepared.stack.id, cause, cleanupErrors);
      }
    },
    async inspectOrdinaryWorkspace(workspacePath) {
      const canonicalPath = await canonicalizeOrdinaryWorkspacePath(workspacePath);
      const identity = await readOrdinaryWorkspaceIdentity(canonicalPath);
      if (identity === undefined) {
        return { registered: false, stacks: [] };
      }
      const stacks = options.repository
        .listStacks()
        .filter(
          (stack) =>
            stack.projectId === identity.projectId &&
            stack.checkoutId === identity.checkoutId &&
            stack.contextId === identity.contextId,
        );
      return { registered: stacks.length > 0, identity, stacks };
    },
    inspectStack(stackId) {
      return options.repository.getStack(stackId);
    },
    listStacks(listOptions) {
      return options.repository.listStacks(listOptions);
    },
    async updateStack(stackId, configuration) {
      return updateStackRecord(stackId, configuration);
    },
    async deleteStack(stackId, deleteOptions) {
      const existing = options.repository.getStack(stackId);
      if (existing === undefined) {
        throw new ManagedStackNotFoundError(stackId);
      }
      if (existing.status === "tombstoned") {
        return {
          outcome: "no-op",
          stack: existing,
          dataReclamation: await reclaimStackState(existing),
        };
      }
      const operation = requireOperation(stackId, "delete");
      try {
        const current = options.repository.getStack(stackId);
        if (current === undefined) {
          throw new ManagedStackNotFoundError(stackId);
        }
        if (current.status === "tombstoned") {
          const dataReclamation = await reclaimStackState(current);
          options.repository.finishOperation(stackId, operation.token, "completed", now());
          return { outcome: "no-op", stack: current, dataReclamation };
        }
        if (current.lifecycle !== "stopped") {
          if (deleteOptions?.stop === undefined) {
            throw new ManagedStackNotStoppedError(stackId);
          }
          await deleteOptions.stop(current);
          options.repository.updateStack({
            stackId,
            operationToken: operation.token,
            now: now(),
            lifecycle: "stopped",
            runtimeMetadata: { processIds: {}, containerIds: {} },
          });
        }
        const tombstoned = options.repository.tombstoneStack(stackId, operation.token, now());
        const dataReclamation = await reclaimStackState(tombstoned);
        options.repository.finishOperation(stackId, operation.token, "completed", now());
        return { outcome: "delete", stack: tombstoned, dataReclamation };
      } catch (error: unknown) {
        finishOperationBestEffort(stackId, operation.token, error);
        throw error;
      }
    },
    async reconcileAbandonedOperations(reconcileOptions) {
      const recovered: Array<ManagedStackRecord> = [];
      const abortedStackIds: Array<string> = [];
      const retained: Array<RetainedManagedOperation> = [];
      const skippedOperationIds: Array<string> = [];
      const failures: Array<ManagedOperationRecoveryFailure> = [];
      const forcedOperation = reconcileOptions.force;
      if (forcedOperation !== undefined) {
        assertManagedUuid(forcedOperation.stackId, "forced recovery stackId");
        assertManagedUuid(forcedOperation.operationToken, "forced recovery operation token");
      }
      const operations = options.repository
        .listActiveOperations(
          forcedOperation === undefined ? reconcileOptions.startedBefore : undefined,
        )
        .filter(
          (operation) =>
            forcedOperation === undefined ||
            (operation.stackId === forcedOperation.stackId &&
              operation.token === forcedOperation.operationToken),
        );
      for (const operation of operations) {
        if (forcedOperation === undefined && operation.ownerPid !== undefined) {
          try {
            if (await isProcessAlive(operation.ownerPid)) {
              retained.push({ operation, reason: "owner-alive" });
              continue;
            }
          } catch (error: unknown) {
            retained.push({ operation, reason: "owner-liveness-unknown", error });
            continue;
          }
        }
        let stack: ManagedStackRecord | undefined;
        try {
          stack = options.repository.getStack(operation.stackId);
          if (stack === undefined) {
            skippedOperationIds.push(operation.token);
            continue;
          }
          let actual: "running" | "stopped" | "unknown";
          try {
            actual = await reconcileOptions.inspectRuntime(stack, operation);
          } catch (error: unknown) {
            retained.push({ operation, reason: "runtime-inspection-failed", error });
            continue;
          }
          if (actual === "unknown") {
            retained.push({ operation, reason: "runtime-unknown" });
            continue;
          }
          const lifecycle: ManagedStackLifecycle = actual === "running" ? "running" : "stopped";
          const reconciled = options.repository.reconcileOperation(
            stack.id,
            operation.token,
            lifecycle,
            now(),
          );
          if (reconciled === undefined) {
            abortedStackIds.push(stack.id);
            try {
              await removeStackState(stack);
            } catch (error: unknown) {
              failures.push({
                operation,
                phase: "state-reclamation",
                operationReleased: true,
                error,
              });
            }
          } else {
            recovered.push(reconciled);
          }
        } catch (error: unknown) {
          if (
            error instanceof ManagedOperationOwnershipError ||
            error instanceof ManagedStackNotFoundError
          ) {
            skippedOperationIds.push(operation.token);
            continue;
          }
          failures.push({
            operation,
            phase: "reconciliation",
            operationReleased: failRecoveryBestEffort(stack, operation, error),
            error,
          });
        }
      }
      return { recovered, abortedStackIds, retained, skippedOperationIds, failures };
    },
    async pruneCheckoutLocations(shouldPrune) {
      const stale: Array<string> = [];
      for (const location of options.repository.listCheckoutLocations()) {
        if (await shouldPrune(location)) {
          stale.push(location.id);
        }
      }
      return options.repository.pruneCheckoutLocations(stale);
    },
    close() {
      options.repository.close();
    },
  };
};
