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
 * Every method is Promise-returning, reads included: the registry lives in a
 * file this process may have to wait for, so a handle that answered reads
 * synchronously would only be hiding that I/O from its caller. The handle is an
 * `AsyncDisposable`, so a block that acquires one with `await using` closes it
 * on every path out.
 */
export interface ManagedStackServiceHandle extends AsyncDisposable {
  readonly stateRoot: string;
  readonly repository: ManagedStackRepositoryShape;
  provisionOrdinaryStack(
    options: ProvisionOrdinaryStackRequest,
  ): Promise<ProvisionOrdinaryStackResult>;
  inspectOrdinaryWorkspace(workspacePath: string): Promise<InspectOrdinaryWorkspaceResult>;
  inspectStack(stackId: string): Promise<ManagedStackRecord | undefined>;
  listStacks(options?: {
    readonly includeTombstoned?: boolean;
  }): Promise<ReadonlyArray<ManagedStackRecord>>;
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

const managedStackServiceHandle = async <ER>(
  layer: Layer.Layer<ManagedStackRepository | ManagedStackService, ER>,
): Promise<ManagedStackServiceHandle> => {
  const runtime = ManagedRuntime.make(layer);
  // Acquiring the service is the I/O it always was: the registry file is opened
  // and its schema read, and a cold start may wait out another process' WAL
  // conversion. Awaiting it here keeps that failure at the acquisition — a
  // registry this process cannot open rejects rather than surfacing at whichever
  // later call happens to touch it first — without blocking the event loop.
  const context = await runtime.context();
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
    inspectStack: (stackId) => runtime.runPromise(service.inspectStack(stackId)),
    listStacks: (options) => runtime.runPromise(service.listStacks(options)),
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
    [Symbol.asyncDispose]: () => runtime.dispose(),
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
 * from the call that made the mistake. Acquisition is asynchronous throughout, so
 * that — like every other way this can fail — arrives as a rejection rather than
 * as a throw the caller has to guard separately.
 */
export const makeManagedStackServiceWith = async (
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
  options: MakeManagedStackServiceOptions,
): Promise<ManagedStackServiceHandle> => {
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
export const createManagedStackServiceWith = async (
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
  openRepository: (
    registryPath: string,
  ) => Layer.Layer<ManagedStackRepository, UnsupportedManagedRegistryVersionError>,
  options: CreateManagedStackServiceOptions,
): Promise<ManagedStackServiceHandle> => {
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
