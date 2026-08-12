import { Context, Effect, Layer, ManagedRuntime, type FileSystem } from "effect";
import type {
  ManagedCheckoutLocation,
  ManagedOperationRecord,
  ManagedStackConfiguration,
  ManagedStackRecord,
  UnsupportedManagedRegistryVersionError,
} from "./model.ts";
import {
  managedRegistryPath,
  requireExplicitManagedStateRoot,
  resolveManagedStateRoot,
} from "./paths.ts";
import { assertManagedOwnerPid, ManagedStackRepository } from "./repository.ts";
import type { ManagedStackRepositoryShape } from "./repository.ts";
import {
  ManagedStackService,
  type DeleteManagedStackResult,
  type InspectOrdinaryWorkspaceResult,
  type ManagedStackServiceOptions,
  type ProvisionOrdinaryStackResult,
  type ReconcileAbandonedOperationsResult,
} from "./service.ts";

export interface MakeManagedStackServiceOptions extends ManagedStackServiceOptions {
  readonly repository: ManagedStackRepositoryShape;
}

export interface CreateManagedStackServiceOptions {
  readonly stateRoot?: string;
  readonly repository?: ManagedStackRepositoryShape;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly ownerPid?: number;
  readonly publicationTimeoutMs?: number;
  readonly publicationPollMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface ProvisionOrdinaryStackRequest {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly configuration?: ManagedStackConfiguration;
  readonly initialize?: (stack: ManagedStackRecord) => Promise<void>;
  readonly validate?: (stack: ManagedStackRecord) => Promise<void>;
}

export type ReconcileAbandonedOperationsRequest = {
  readonly inspectRuntime: (
    stack: ManagedStackRecord,
    operation: ManagedOperationRecord,
  ) => Promise<"running" | "stopped" | "unknown">;
} & (
  | { readonly startedBefore?: string; readonly force?: never }
  | {
      readonly startedBefore?: never;
      readonly force: { readonly stackId: string; readonly operationToken: string };
    }
);

/**
 * The managed registry as a Promise API.
 *
 * `inspectStack` and `listStacks` stay synchronous accessors: the registry is a
 * synchronous handle, and callers use them inline while deciding what to do next.
 */
export interface ManagedStackServiceHandle {
  readonly stateRoot: string;
  readonly repository: ManagedStackRepositoryShape;
  provisionOrdinaryStack(
    options: ProvisionOrdinaryStackRequest,
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
    options: ReconcileAbandonedOperationsRequest,
  ): Promise<ReconcileAbandonedOperationsResult>;
  pruneCheckoutLocations(
    shouldPrune: (location: ManagedCheckoutLocation) => boolean | Promise<boolean>,
  ): Promise<number>;
  close(): Promise<void>;
}

/**
 * A caller-supplied callback may answer synchronously, asynchronously, or by
 * throwing either way. Whatever it does becomes this effect's outcome unchanged,
 * so the service's own handling of a failed callback is the same as it was when
 * the service awaited promises directly.
 */
const fromCallback = <A>(run: () => A | Promise<A>): Effect.Effect<A, unknown> =>
  Effect.flatMap(Effect.try({ try: run, catch: (error: unknown) => error }), (answer) =>
    answer instanceof Promise
      ? Effect.tryPromise({ try: () => answer, catch: (error: unknown) => error })
      : Effect.succeed(answer),
  );

const managedStackServiceHandle = <ER>(
  layer: Layer.Layer<ManagedStackRepository | ManagedStackService, ER>,
): ManagedStackServiceHandle => {
  const runtime = ManagedRuntime.make(layer);
  // Built eagerly and synchronously: the registry is a synchronous handle, the
  // facade exposes synchronous reads over it, and a registry this process cannot
  // open must fail while the service is being created rather than at whichever
  // call happens to touch it first.
  const context = Effect.runSync(runtime.contextEffect);
  const service = Context.get(context, ManagedStackService);
  const repository = Context.get(context, ManagedStackRepository);

  return {
    stateRoot: service.stateRoot,
    repository,
    provisionOrdinaryStack: (options) => {
      const initialize = options.initialize;
      const validate = options.validate;
      return runtime.runPromise(
        service.provisionOrdinaryStack({
          workspacePath: options.workspacePath,
          stackName: options.stackName,
          configuration: options.configuration,
          initialize:
            initialize === undefined ? undefined : (stack) => fromCallback(() => initialize(stack)),
          validate:
            validate === undefined ? undefined : (stack) => fromCallback(() => validate(stack)),
        }),
      );
    },
    inspectOrdinaryWorkspace: (workspacePath) =>
      runtime.runPromise(service.inspectOrdinaryWorkspace(workspacePath)),
    inspectStack: (stackId) => runtime.runSync(service.inspectStack(stackId)),
    listStacks: (options) => runtime.runSync(service.listStacks(options)),
    updateStack: (stackId, configuration) =>
      runtime.runPromise(service.updateStack(stackId, configuration)),
    deleteStack: (stackId, options) => {
      const stop = options?.stop;
      return runtime.runPromise(
        service.deleteStack(stackId, {
          stop: stop === undefined ? undefined : (stack) => fromCallback(() => stop(stack)),
        }),
      );
    },
    reconcileAbandonedOperations: (options) => {
      const inspectRuntime = (stack: ManagedStackRecord, operation: ManagedOperationRecord) =>
        fromCallback(() => options.inspectRuntime(stack, operation));
      return runtime.runPromise(
        service.reconcileAbandonedOperations(
          options.force === undefined
            ? { inspectRuntime, startedBefore: options.startedBefore }
            : { inspectRuntime, force: options.force },
        ),
      );
    },
    pruneCheckoutLocations: (shouldPrune) =>
      runtime.runPromise(
        service.pruneCheckoutLocations((location) => fromCallback(() => shouldPrune(location))),
      ),
    close: () => runtime.dispose(),
  };
};

const serviceLayer = (
  options: ManagedStackServiceOptions,
  repositoryLayer: Layer.Layer<ManagedStackRepository, UnsupportedManagedRegistryVersionError>,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
): Layer.Layer<
  ManagedStackRepository | ManagedStackService,
  UnsupportedManagedRegistryVersionError
> =>
  ManagedStackService.make(options).pipe(
    // Merged rather than only provided: the facade hands the very repository the
    // service uses back to its caller, so an embedder can read the registry
    // without opening a second handle on it.
    Layer.provideMerge(repositoryLayer),
    Layer.provide(fileSystemLayer),
    Layer.orDie,
  );

/**
 * A managed stack service over a repository the caller already has.
 *
 * The state root and owner pid are validated here, before any layer is built, so
 * a caller that supplied neither a usable root nor a usable pid learns about it
 * from the call that made the mistake.
 */
export const makeManagedStackServiceWith = (
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
  options: MakeManagedStackServiceOptions,
): ManagedStackServiceHandle => {
  const stateRoot = requireExplicitManagedStateRoot(options.stateRoot);
  assertManagedOwnerPid(options.ownerPid);
  return managedStackServiceHandle(
    serviceLayer(
      { ...options, stateRoot },
      Layer.succeed(ManagedStackRepository, options.repository),
      fileSystemLayer,
    ),
  );
};

/**
 * The whole body of every runtime entrypoint's `createManagedStackService`,
 * parameterized only by how a registry file is opened. Keeping it here — rather
 * than duplicating it per entrypoint — makes option drift between the Bun and
 * Node entries structurally impossible, and lets the Bun test suite cover the
 * plumbing that the Node entry (which imports `node:sqlite`) shares.
 */
export const createManagedStackServiceWith = (
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
  openRepository: (
    registryPath: string,
  ) => Layer.Layer<ManagedStackRepository, UnsupportedManagedRegistryVersionError>,
  options: CreateManagedStackServiceOptions,
): ManagedStackServiceHandle => {
  const stateRoot = resolveManagedStateRoot(options);
  assertManagedOwnerPid(options.ownerPid);
  const repository = options.repository;
  return managedStackServiceHandle(
    serviceLayer(
      { ...options, stateRoot },
      repository === undefined
        ? openRepository(managedRegistryPath(stateRoot))
        : Layer.succeed(ManagedStackRepository, repository),
      fileSystemLayer,
    ),
  );
};
