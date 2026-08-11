import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import {
  DEFAULT_MANAGED_STACK_NAME,
  ManagedAbandonedOperationError,
  ManagedOperationInProgressError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
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
import { managedStackPaths } from "./paths.ts";
import type { ManagedStackRepository } from "./repository.ts";

export interface ManagedStackServiceOptions {
  readonly repository: ManagedStackRepository;
  readonly stateRoot: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly ownerPid?: number;
  readonly publicationTimeoutMs?: number;
  readonly publicationPollMs?: number;
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
}

export interface ReconcileAbandonedOperationsOptions {
  readonly startedBefore?: string;
  readonly inspectRuntime: (
    stack: ManagedStackRecord,
    operation: ManagedOperationRecord,
  ) => Promise<"running" | "stopped" | "unknown">;
}

export interface ReconcileAbandonedOperationsResult {
  readonly recovered: ReadonlyArray<ManagedStackRecord>;
  readonly retained: ReadonlyArray<ManagedOperationRecord>;
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

export const makeManagedStackService = (
  options: ManagedStackServiceOptions,
): ManagedStackService => {
  const idFactory = options.idFactory ?? randomUUID;
  const clock = options.clock ?? (() => new Date());
  const ownerPid = options.ownerPid ?? process.pid;
  const publicationTimeoutMs = options.publicationTimeoutMs ?? 10_000;
  const publicationPollMs = options.publicationPollMs ?? 10;
  const now = (): string => clock().toISOString();

  const requireOperation = (
    stackId: string,
    kind: ManagedOperationKind,
  ): ManagedOperationRecord => {
    const claimed = options.repository.claimOperation({
      token: idFactory(),
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
    const deadline = Date.now() + publicationTimeoutMs;
    while (Date.now() <= deadline) {
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

  return {
    stateRoot: options.stateRoot,
    repository: options.repository,
    async provisionOrdinaryStack(provisionOptions) {
      const stackName = provisionOptions.stackName ?? DEFAULT_MANAGED_STACK_NAME;
      if (!stackNamePattern.test(stackName)) {
        throw new Error(`Invalid managed stack name: ${stackName}`);
      }
      const canonicalPath = await canonicalizeOrdinaryWorkspacePath(provisionOptions.workspacePath);
      const marker = await ensureOrdinaryWorkspaceIdentity(canonicalPath, idFactory);
      const stackId = idFactory();
      const prepared = options.repository.prepareOrdinaryStack({
        identity: marker.identity,
        canonicalPath,
        locationId: idFactory(),
        stackId,
        stackName,
        paths: managedStackPaths(options.stateRoot, stackId),
        operationToken: idFactory(),
        ownerPid,
        now: now(),
        configuration: provisionOptions.configuration ?? {},
      });

      if (prepared.outcome === "existing") {
        if (prepared.stack.status === "active") {
          return {
            outcome: "reuse",
            selection: selectionForStack(prepared.stack),
            stack: prepared.stack,
            identityMarkerCreated: marker.created,
          };
        }
        if (prepared.operation === undefined) {
          throw new ManagedAbandonedOperationError(prepared.stack.id);
        }
        const published = await awaitPublication(prepared.stack);
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
        await rm(prepared.stack.paths.root, { force: true, recursive: true }).catch(
          () => undefined,
        );
        options.repository.abortPendingStack(prepared.stack.id, prepared.operation.token);
        throw new ManagedStackInitializationError(prepared.stack.id, cause);
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
            stack.projectId === identity.projectId && stack.checkoutId === identity.checkoutId,
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
        options.repository.finishOperation(
          stackId,
          operation.token,
          "failed",
          now(),
          String(error),
        );
        throw error;
      }
    },
    async deleteStack(stackId, deleteOptions) {
      const existing = options.repository.getStack(stackId);
      if (existing === undefined) {
        throw new ManagedStackNotFoundError(stackId);
      }
      if (existing.status === "tombstoned") {
        return { outcome: "no-op", stack: existing };
      }
      const operation = requireOperation(stackId, "delete");
      try {
        if (existing.lifecycle !== "stopped") {
          if (deleteOptions?.stop === undefined) {
            throw new Error(`Managed stack ${stackId} must be safely stopped before deletion`);
          }
          await deleteOptions.stop(existing);
          options.repository.updateStack({
            stackId,
            operationToken: operation.token,
            now: now(),
            lifecycle: "stopped",
            runtimeMetadata: { processIds: {}, containerIds: {} },
          });
        }
        const tombstoned = options.repository.tombstoneStack(stackId, operation.token, now());
        await rm(tombstoned.paths.root, { force: true, recursive: true });
        options.repository.finishOperation(stackId, operation.token, "completed", now());
        return { outcome: "delete", stack: tombstoned };
      } catch (error: unknown) {
        options.repository.finishOperation(
          stackId,
          operation.token,
          "failed",
          now(),
          String(error),
        );
        throw error;
      }
    },
    async reconcileAbandonedOperations(reconcileOptions) {
      const recovered: Array<ManagedStackRecord> = [];
      const retained: Array<ManagedOperationRecord> = [];
      for (const operation of options.repository.listActiveOperations(
        reconcileOptions.startedBefore,
      )) {
        const stack = options.repository.getStack(operation.stackId);
        if (stack === undefined) {
          retained.push(operation);
          continue;
        }
        const actual = await reconcileOptions.inspectRuntime(stack, operation);
        if (actual === "unknown") {
          retained.push(operation);
          continue;
        }
        const lifecycle: ManagedStackLifecycle = actual === "running" ? "running" : "stopped";
        recovered.push(
          options.repository.reconcileOperation(stack.id, operation.token, lifecycle, now()),
        );
      }
      return { recovered, retained };
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
