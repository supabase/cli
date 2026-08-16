import { Context, Effect, Layer, ManagedRuntime, type FileSystem } from "effect";
import { fromCallback, isFinished } from "./callback.ts";
import {
  IncompatibleManagedRegistryError,
  ManagedRuntimeStartError,
  UnsafeManagedStackPathError,
} from "./model.ts";
import type {
  InvalidManagedOwnerPidError,
  ManagedOperationRecord,
  ManagedStackConfiguration,
  ManagedStackProjection,
  ManagedStackRecord,
  ManagedPortIntentDocument,
  ManagedRuntimeMetadata,
} from "./model.ts";
import type { ConfigPortKey } from "../PortCatalog.ts";
import { failsWith } from "./failure.ts";
import { gitConfigStoreLayer } from "./git.ts";
import {
  managedRegistryPath,
  requireExplicitManagedStateRoot,
  resolveManagedStateRoot,
} from "./paths.ts";
import { assertManagedOwnerPid, ManagedStackRepository } from "./repository.ts";
import type {
  AbandonManagedIdentityTransitionResult,
  ManagedStackRepositoryShape,
} from "./repository.ts";
import {
  ManagedStackService,
  type DeleteManagedStackResult,
  type ManagedStackResolution,
  type ManagedStackServiceOptions,
  type ReconcileAbandonedOperationsResult,
  type ManagedCheckoutRecoveryRequest,
  type ManagedIdentityTransitionAbandonRequest,
  type StartedManagedStackResolution,
  type ManagedPruneRequest,
  type ManagedPruneResult,
  type ManagedRuntimePortAllocation,
} from "./service.ts";
import type { ManagedWorkspaceDiscovery } from "./discovery.ts";

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

interface ResolveManagedStackRequestBase {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
  readonly legacyPortConflict?: {
    readonly key: ConfigPortKey;
    readonly port: number;
    readonly ownerId?: string;
  };
  readonly configuration?: Omit<ManagedStackConfiguration, "ports">;
}

interface ResolveManagedStackStatusRequest extends ResolveManagedStackRequestBase {
  readonly operation: "status";
  readonly initialize?: never;
}

interface ResolveManagedStackStartRequest extends ResolveManagedStackRequestBase {
  readonly operation: "start";
  readonly initialize: (
    stack: ManagedStackRecord,
    allocation: ManagedRuntimePortAllocation,
  ) => Promise<ManagedRuntimeMetadata | void>;
  readonly validate?: (stack: ManagedStackRecord) => Promise<void>;
}

export type ResolveManagedStackRequest =
  | ResolveManagedStackStartRequest
  | ResolveManagedStackStatusRequest;

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
  /** A `start` always settles on a stack, which the narrower overload reports. */
  discoverWorkspace(workspacePath: string): Promise<ManagedWorkspaceDiscovery>;
  resolveStack(options: ResolveManagedStackStartRequest): Promise<StartedManagedStackResolution>;
  resolveStack(options: ResolveManagedStackRequest): Promise<ManagedStackResolution>;
  newCheckout(options: ManagedCheckoutRecoveryRequest): Promise<ManagedWorkspaceDiscovery>;
  rebindCheckout(options: ManagedCheckoutRecoveryRequest): Promise<ManagedWorkspaceDiscovery>;
  adoptContext(options: ManagedCheckoutRecoveryRequest): Promise<ManagedWorkspaceDiscovery>;
  abandonIdentityTransition(
    options: ManagedIdentityTransitionAbandonRequest,
  ): Promise<AbandonManagedIdentityTransitionResult>;
  inspectStack(stackId: string): Promise<ManagedStackProjection | undefined>;
  listStacks(options?: {
    readonly includeTombstoned?: boolean;
  }): Promise<ReadonlyArray<ManagedStackProjection>>;
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
  prune(request: ManagedPruneRequest): Promise<ManagedPruneResult>;
  close(): Promise<void>;
}

type InspectedManagedRuntime = "running" | "stopped" | "unknown";

const isInspectedRuntime = (
  answer: InspectedManagedRuntime | PromiseLike<InspectedManagedRuntime>,
): answer is InspectedManagedRuntime => typeof answer === "string";

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

  /**
   * Whether this handle has been closed, tracked here rather than read back out
   * of the rejection a closed run produces: a disposed `ManagedRuntime` answers
   * by dying with a bare string, and deciding from that string's contents would
   * misreport a caller's own callback rejecting with a string that happens to
   * mention disposal.
   */
  let closed = false;
  const dispose = (): Promise<void> => {
    closed = true;
    return runtime.dispose();
  };

  /**
   * Every method's run, so a call that arrives after `close` is reported as one:
   * the runtime's bare string reaches the caller as a rejection with no name,
   * message, or stack. While the handle is open, every failure is the failure
   * itself and passes through untouched.
   */
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const callWasClosed = closed;
    return runtime.runPromise(effect).catch((error: unknown) => {
      throw callWasClosed
        ? new Error(`The managed stack service handle is closed (${String(error)})`)
        : error;
    });
  };

  /**
   * A function declaration rather than a property initializer, so the handle's
   * two `resolveStack` signatures are implemented by one body without a cast: the
   * narrow `start` overload is the one a caller wants, and the implementation
   * answers the general shape both share.
   */
  function resolveStack(
    options: ResolveManagedStackRequest & { readonly operation: "start" },
  ): Promise<StartedManagedStackResolution>;
  function resolveStack(options: ResolveManagedStackRequest): Promise<ManagedStackResolution>;
  function resolveStack(options: ResolveManagedStackRequest): Promise<ManagedStackResolution> {
    const common = {
      workspacePath: options.workspacePath,
      operation: options.operation,
      stackName: options.stackName,
      portDocument: options.portDocument,
      legacyPortConflict: options.legacyPortConflict,
      configuration: options.configuration,
    };
    if (options.operation === "status") {
      return run(service.resolveStack({ ...common, operation: "status" }));
    }
    const initialize = options.initialize;
    return run(
      service.resolveStack({
        ...common,
        operation: "start",
        initialize: (stack, allocation) =>
          fromCallback(
            async () => {
              const metadata = await initialize(stack, allocation);
              return metadata ?? { processIds: {}, containerIds: {} };
            },
            (value): value is ManagedRuntimeMetadata =>
              typeof value === "object" &&
              value !== null &&
              "processIds" in value &&
              "containerIds" in value,
          ).pipe(Effect.mapError((error) => new ManagedRuntimeStartError({ cause: error }))),
        validate:
          options.validate === undefined
            ? undefined
            : (stack) => fromCallback(() => options.validate?.(stack), isFinished),
      }),
    );
  }

  return {
    stateRoot: service.stateRoot,
    repository,
    discoverWorkspace: (workspacePath) => run(service.discoverWorkspace(workspacePath)),
    resolveStack,
    newCheckout: (options) => run(service.newCheckout(options)),
    rebindCheckout: (options) => run(service.rebindCheckout(options)),
    adoptContext: (options) => run(service.adoptContext(options)),
    abandonIdentityTransition: (options) => run(service.abandonIdentityTransition(options)),
    inspectStack: (stackId) => run(service.inspectStack(stackId)),
    listStacks: (options) => run(service.listStacks(options)),
    updateStack: (stackId, configuration) => run(service.updateStack(stackId, configuration)),
    deleteStack: (stackId, options) => {
      const stop = options?.stop;
      return run(
        service.deleteStack(stackId, {
          stop:
            stop === undefined ? undefined : (stack) => fromCallback(() => stop(stack), isFinished),
        }),
      );
    },
    reconcileAbandonedOperations: (options) => {
      const inspectRuntime = (stack: ManagedStackRecord, operation: ManagedOperationRecord) =>
        fromCallback(() => options.inspectRuntime(stack, operation), isInspectedRuntime);
      return run(
        service.reconcileAbandonedOperations(
          options.force === undefined
            ? { inspectRuntime, startedBefore: options.startedBefore }
            : { inspectRuntime, force: options.force },
        ),
      );
    },
    prune: (request) => run(service.prune(request)),
    close: dispose,
    [Symbol.asyncDispose]: dispose,
  };
};

/**
 * What building a managed stack layer can refuse.
 *
 * The state-root and owner-pid errors are option bugs the layer refuses to start
 * with.
 */
export type ManagedStackLayerFailure =
  | IncompatibleManagedRegistryError
  | InvalidManagedOwnerPidError
  | UnsafeManagedStackPathError;

const serviceLayer = (
  options: ManagedStackServiceOptions,
  repositoryLayer: Layer.Layer<ManagedStackRepository, IncompatibleManagedRegistryError>,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
): Layer.Layer<ManagedStackRepository | ManagedStackService, ManagedStackLayerFailure> =>
  ManagedStackService.make(options).pipe(
    // Merged rather than only provided: the facade hands the very repository the
    // service uses back to its caller, so an embedder can read the registry
    // without opening a second handle on it.
    Layer.provideMerge(repositoryLayer),
    // The git config store is an implementation detail of how the service resolves
    // identity, not something a consumer composes: it is provided here so the
    // service a caller holds needs nothing but this one layer.
    Layer.provide(Layer.mergeAll(fileSystemLayer, gitConfigStoreLayer)),
  );

/**
 * The whole managed assembly as one layer: the policy service, the registry
 * adapter it decides over, and the platform filesystem it reclaims stack state
 * through, with the state root resolved by the one resolver that owns that
 * policy.
 *
 * This is what an Effect consumer provides, and it is what the Promise facade
 * runs behind its handle, so the two assemblies cannot drift apart. A caller that
 * brought its own repository gets that repository instead of an opened registry
 * file.
 */
export const managedStackLayerWith = (
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem>,
  openRepository: (
    registryPath: string,
  ) => Layer.Layer<ManagedStackRepository, IncompatibleManagedRegistryError>,
  options: CreateManagedStackServiceOptions,
): Layer.Layer<ManagedStackRepository | ManagedStackService, ManagedStackLayerFailure> =>
  Layer.unwrap(
    Effect.map(
      // Resolved while the layer is built rather than while it is described, so
      // an unusable root refuses the build instead of throwing at whichever
      // expression happened to assemble the layer.
      Effect.try({
        try: () => resolveManagedStateRoot(options),
        catch: failsWith<UnsafeManagedStackPathError>(UnsafeManagedStackPathError),
      }),
      (stateRoot) => {
        const repository = options.repository;
        return serviceLayer(
          { ...options, stateRoot },
          repository === undefined
            ? openRepository(managedRegistryPath(stateRoot))
            : Layer.succeed(ManagedStackRepository, repository),
          fileSystemLayer,
        );
      },
    ),
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
  ) => Layer.Layer<ManagedStackRepository, IncompatibleManagedRegistryError>,
  options: CreateManagedStackServiceOptions,
): Promise<ManagedStackServiceHandle> => {
  // Validated here as well as in the layer, so a caller that supplied an
  // unusable root or pid learns about it from the call that made the mistake.
  const stateRoot = resolveManagedStateRoot(options);
  assertManagedOwnerPid(options.ownerPid);
  return managedStackServiceHandle(
    managedStackLayerWith(fileSystemLayer, openRepository, { ...options, stateRoot }),
  );
};
