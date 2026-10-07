import {
  Cause,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Match,
  Option,
  Path,
  Predicate,
  Ref,
  Result,
  Scope,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  connectHost,
  hasReason,
  HostProcessError,
  launchHost,
  observeHost,
  ownerClient,
  ownerExitProbe,
  shutdownHost,
  waitForOwnerExit,
  type HostAccess,
  type HostEndpoint,
} from "./HostProcess.ts";
import {
  planSupabaseComposition,
  type PlannedInstance,
  type SupabaseCompositionOptions,
} from "./composition/Supabase.ts";
import { listStackContainers, removeStackContainersCommand } from "./runtime/Container.ts";
import { volumeDataCleanupCommands } from "./storage/DockerDatabaseStorage.ts";
import { deriveStackId, resolveStackIdentity } from "./identity/Identity.ts";
import { failureMessage } from "./internal/failure-message.ts";
import * as State from "./State.ts";
import type { SavedStack, StackCredentials, StackKeysInput } from "./State.ts";
import { StackError, type Definition, type Observation } from "./Rpc.ts";
import { sinceMillis, streamStackLogs as streamPersistedLogs } from "./host/LogStore.ts";
import { gatewayLog } from "./host/GatewayLog.ts";
import type { LogPosition, LogRecord, StackLogRecord } from "./host/LogRecord.ts";
import { reclaimStack } from "./Sweep.ts";
import {
  ServiceCreationInput as ServiceCreationInputSchema,
  type ServiceCreation,
  type ServiceCreationInput as CatalogServiceCreationInput,
} from "./services/Catalog.ts";
import type { SnapshotScope } from "./services/DatabaseSnapshot.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  InitializationCommand,
  PgProveOptions,
  PostgresCommand,
  CommandInvocation,
} from "./Commands.ts";

export { initialization, postgres } from "./Commands.ts";
export { resolveNativePostgresUser } from "./runtime/postgres-user.ts";
export { apiRoute } from "./host/Endpoints.ts";
export { gatewayLog };
export { StackError } from "./Rpc.ts";
export type { ServiceCreation } from "./services/Catalog.ts";
/** A service creation as `services.create` accepts it, before stack credentials fill its inputs. */
export type ServiceCreationInput = CatalogServiceCreationInput;
export type { CompositionConfig } from "./Orchestrator.ts";
export type {
  CreationChange,
  PlannedInstance,
  SupabaseCompositionOptions,
} from "./composition/Supabase.ts";
export { StackIdSchema as StackId } from "./identity/StackId.ts";
export type { SavedStack } from "./State.ts";
export type { StackCredentials, StackKeysInput };
export type { Observation } from "./Rpc.ts";
export type { LogPosition, LogRecord, StackLogRecord };
export type {
  Command,
  InitializationCommand,
  PgProveOptions,
  PostgresCommand,
} from "./Commands.ts";

const stateFor = (root: string) => State.Service.pipe(Effect.provide(State.layer({ root })));

/** Storage locations shared by clients and the detached stack owner. */
export interface StackLocations {
  readonly stateRoot: string;
  readonly cacheRoot: string;
}
/** Registers an isolated stack identity without starting service processes. */
export interface CreateOptions extends StackLocations {
  readonly projectRoot: string;
  readonly name?: string;
  readonly runtime: "native" | "docker" | "podman";
  /**
   * A `session` stack starts its owner at creation and is destroyed when the creating handle's
   * scope closes or its process exits; a `detached` stack (the default) outlives its creator.
   */
  readonly lifetime?: State.StackLifetime;
  /**
   * Starts the owner at creation and lets it register the stack under its lease, so a failed or
   * interrupted launch leaves no registration behind. Session stacks always do this.
   */
  readonly startOwner?: boolean;
}
/** Opens a previously registered stack. */
export interface OpenOptions extends StackLocations {
  readonly id: string;
  readonly startOwner?: boolean;
}

/** No owner serves the stack: nothing holds its lease, or a sweeper is cleaning it up. */
const ownerAbsent = hasReason("not-running", "sweeping");
/** The stack is no longer registered: it was destroyed or swept. */
const stackGone = hasReason("unregistered");

const failure = (operation: string, cause: unknown): StackError =>
  Schema.is(StackError)(cause)
    ? cause
    : new StackError({
        operation,
        message: Schema.is(RpcClientError)(cause)
          ? `Owner response unavailable; the request outcome is uncertain: ${cause.message}`
          : failureMessage(cause),
        ...(ownerAbsent(cause) || stackGone(cause)
          ? { reason: "owner-unavailable" as const }
          : hasReason("release-mismatch")(cause)
            ? { reason: "release-mismatch" as const }
            : hasReason("runtime-unavailable")(cause)
              ? { reason: "runtime-unavailable" as const }
              : {}),
      });

type Kind = ServiceCreation["service"];
type ServiceCreationRestartInput<K extends Kind> =
  | Pick<Extract<ServiceCreationInput, { service: K }>, "config">
  | Extract<ServiceCreationInput, { service: K }>;
/** An individually identified service controlled through the owner. */
export interface ServiceInstance<K extends Kind = Kind> {
  readonly id: string;
  readonly service: K;
  readonly start: Effect.Effect<void, StackError>;
  readonly ready: Effect.Effect<void, StackError>;
  readonly stop: Effect.Effect<void, StackError>;
  readonly restart: (input?: ServiceCreationRestartInput<K>) => Effect.Effect<void, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  /** Ensures the service artifact or image is available without starting the service. */
  readonly prepare: Effect.Effect<void, StackError>;
  readonly status: Effect.Effect<Observation, StackError>;
  readonly followStatus: Stream.Stream<Observation, StackError>;
  /** Streams the instance's persisted records through its live owner, which it never launches. */
  readonly readLogs: (options?: ReadLogsOptions) => Stream.Stream<LogRecord, StackError>;
  readonly credentials: (options?: {
    readonly from?: "host" | "runtime";
  }) => Effect.Effect<Readonly<Record<string, string>>, StackError>;
}
/** Selects the records {@link ServiceInstance.readLogs} streams. */
export interface ReadLogsOptions {
  /** Starts at this record instead of the oldest retained one; the read fails with `tail`. */
  readonly from?: LogPosition;
  /** An ISO-8601 timestamp; older records are skipped. */
  readonly since?: string;
  /** Starts with only this many of the latest records; the read fails with `from`. */
  readonly tail?: number;
  /** Keeps streaming new records until interrupted; `false` by default. */
  readonly follow?: boolean;
}
/** Snapshot placement; `cache` is the default. */
export interface DatabaseSnapshotOptions {
  /**
   * `cache` shares bounded retention with every stack under the cache root and outlives the
   * instance; `instance` is never evicted and is removed when the database instance is destroyed.
   */
  readonly scope?: SnapshotScope;
}
/** A database instance with stopped-data snapshot operations. */
export interface DatabaseInstance extends ServiceInstance<"database"> {
  readonly saveSnapshot: (
    key: string,
    options?: DatabaseSnapshotOptions,
  ) => Effect.Effect<void, StackError>;
  readonly restoreSnapshot: (
    key: string,
    options?: DatabaseSnapshotOptions,
  ) => Effect.Effect<boolean, StackError>;
  /** Removes database-owned data while preserving the instance registration. */
  readonly resetData: Effect.Effect<void, StackError>;
}
/** Maps creation discriminators to their supported instance operations. */
export type ServiceInstances = {
  [K in Kind]: K extends "database" ? DatabaseInstance : ServiceInstance<K>;
};
type AnyInstance = ServiceInstances[Kind];
/**
 * The outcome of {@link Stack.destroy}. `skipped` means the stack's registration and host data
 * were removed without its container engine, because the engine was unreachable; its containers
 * and any database data in engine volumes remain, and `cleanupCommands` remove them once the
 * engine is running.
 */
export type DestroyResult =
  | { readonly runtimeCleanup: "complete" }
  | {
      readonly runtimeCleanup: "skipped";
      readonly engine: "docker" | "podman";
      readonly cleanupCommands: ReadonlyArray<string>;
    };
/** Options for streaming PostgreSQL command input and output. */
export interface PostgresCommandOptions<E, R> {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly pgProve?: PgProveOptions;
  readonly stdin?: Stream.Stream<Uint8Array, E, R>;
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
}
/** Output handlers for a finite service initialization command. */
export interface InitializationCommandOptions<E, R> {
  readonly stdout?: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
  readonly stderr?: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
}
interface InternalCommandOptions<E, R> {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly pgProve?: PgProveOptions;
  readonly stdin?: Stream.Stream<Uint8Array, E, R>;
  readonly stdout?: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
  readonly stderr?: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
}
/** Runs a finite PostgreSQL or service initialization command. */
export interface CommandRunner {
  <E, R>(
    command: PostgresCommand,
    options: PostgresCommandOptions<E, R>,
  ): Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | StackError, R>;
  <E = never, R = never>(
    command: InitializationCommand,
    options?: InitializationCommandOptions<E, R>,
  ): Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | StackError, R>;
}
/** A client handle; only the creating handle of a session stack owns its services. */
export interface Stack {
  readonly id: string;
  readonly services: {
    readonly create: <Input extends ServiceCreationInput>(
      creation: Input,
    ) => Effect.Effect<ServiceInstances[Input["service"]], StackError>;
    readonly get: (id: string) => Effect.Effect<AnyInstance, StackError>;
    readonly list: Effect.Effect<ReadonlyArray<AnyInstance>, StackError>;
  };
  readonly credentials: {
    readonly get: Effect.Effect<StackCredentials | undefined, StackError>;
  };
  readonly composition: {
    readonly supabase: (
      services: ReadonlyArray<ServiceCreationInput>,
      options?: SupabaseCompositionOptions,
    ) => Effect.Effect<ReadonlyArray<AnyInstance>, StackError>;
    /**
     * Compares the requested creations with every saved instance of the same kinds, ignoring
     * inputs the composition supplies, without changing state or contacting the owner.
     */
    readonly plan: (
      services: ReadonlyArray<ServiceCreationInput>,
    ) => Effect.Effect<ReadonlyArray<PlannedInstance>, StackError>;
    readonly configure: (config: Orchestrator.CompositionConfig) => Effect.Effect<void, StackError>;
    readonly describe: Effect.Effect<Orchestrator.CompositionConfig, StackError>;
    readonly start: Effect.Effect<ReadonlyArray<Observation>, StackError>;
    readonly stop: Effect.Effect<ReadonlyArray<Observation>, StackError>;
    readonly restart: Effect.Effect<ReadonlyArray<Observation>, StackError>;
  };
  /** The shared API listener's access log, read through the live owner like an instance's. */
  readonly gateway: {
    readonly readLogs: (options?: ReadLogsOptions) => Stream.Stream<LogRecord, StackError>;
  };
  readonly stop: Effect.Effect<void, StackError>;
  readonly destroy: Effect.Effect<DestroyResult, StackError>;
  readonly commands: {
    readonly run: CommandRunner;
  };
}

type Client = Effect.Success<ReturnType<typeof ownerClient>>;

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return causeCode(cause.cause);
  if ("reason" in cause) return causeCode(cause.reason);
  return undefined;
};
/**
 * A refused connection, or a listener that rejects the owner secret, proves the request never
 * reached this stack's owner: the owner is gone or another process holds its port. Resending
 * after re-resolving the owner is safe. Other transport failures leave the connection in place.
 */
const ownerGone = (cause: unknown) =>
  Schema.is(RpcClientError)(cause) &&
  (["ECONNREFUSED", "ConnectionRefused"].includes(causeCode(cause) ?? "") ||
    (cause.reason._tag === "HttpError" &&
      Predicate.hasProperty(cause.reason.cause, "response") &&
      Predicate.hasProperty(cause.reason.cause.response, "status") &&
      cause.reason.cause.response.status === 401));

interface Connection {
  readonly access: HostAccess;
  readonly rpc: Client;
  readonly scope: Scope.Closeable;
  /** Calls and streams currently using this client. */
  active: number;
  /** Replaced by a newer connection; closes once its last user finishes. */
  retired: boolean;
}
/** Finds a directory below `directory` that the current user cannot empty and delete. */
const firstUnremovableDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
    const writable = yield* fs.access(directory, { writable: true }).pipe(Effect.isSuccess);
    if (Option.isNone(entries) || !writable) return directory;
    for (const entry of entries.value) {
      const child = path.join(directory, entry);
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      if (yield* fs.readLink(child).pipe(Effect.isSuccess)) continue;
      const blocked = yield* firstUnremovableDirectory(fs, path, child);
      if (blocked !== undefined) return blocked;
    }
    return undefined;
  });

/**
 * Destroys a stack whose owner cannot start because its container engine is unreachable: under
 * the stack's lease it removes the registration and host data, and returns the commands that
 * remove the containers and engine-volume data left behind.
 */
const destroyWithoutEngine = Effect.fn("Stack.destroyWithoutEngine")(function* (
  state: State.Interface,
  saved: SavedStack,
  locations: StackLocations,
  engine: "docker" | "podman",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const id = saved.id;
  const dataRoot = path.join(locations.stateRoot, id, "data");
  return yield* Effect.scoped(
    Effect.gen(function* () {
      if (!(yield* state.lease(id)))
        return yield* failure(
          "destroy",
          "An owner for this stack started during destroy; run destroy again",
        );
      yield* Effect.addFinalizer(() => state.retractHolder(id).pipe(Effect.ignore));
      yield* state.publishHolder(id, {
        role: "sweeper",
        pid: process.pid,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      const current = yield* state.read(id);
      // Container-written host data, such as database files below Docker 26, can belong to the
      // container user; only the engine can delete it, so refuse before deleting anything.
      const blocked =
        current !== undefined && (yield* fs.exists(dataRoot))
          ? yield* firstUnremovableDirectory(fs, path, dataRoot)
          : undefined;
      if (blocked !== undefined) {
        const engineName = engine === "docker" ? "Docker" : "Podman";
        return yield* failure(
          "destroy",
          `Stack data at ${blocked} can only be removed by ${engineName}; start ${engineName} and run destroy again`,
        );
      }
      // Containers are labelled with the resolved data root the owner ran with.
      const root = yield* fs.realPath(dataRoot).pipe(Effect.orElseSucceed(() => dataRoot));
      const cleanupCommands = [
        removeStackContainersCommand({ engine, stackId: id, root }),
        ...(yield* volumeDataCleanupCommands({ engine, root, fs, path })),
      ];
      if (current !== undefined) {
        yield* fs.remove(dataRoot, { recursive: true, force: true });
        yield* state.withLock(state.remove(id));
      }
      return { runtimeCleanup: "skipped", engine, cleanupCommands } as const;
    }),
  ).pipe(Effect.mapError((cause) => failure("destroy", cause)));
});

/** `launch` starts an owner when none is live; `attach` requires a live one. */
type Reach = "launch" | "attach";

const makeHandle = Effect.fn("Stack.makeHandle")(function* (
  state: State.Interface,
  saved: SavedStack,
  locations: StackLocations,
  seed: { readonly access?: HostAccess; readonly creator?: boolean } = {},
) {
  // Calls and streams release what they borrow in their own scope, not in the handle's.
  const services = Context.omit(Scope.Scope)(
    yield* Effect.context<
      HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope
    >(),
  );
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const handleScope = yield* Scope.Scope;
  const session = saved.lifetime === "session";
  const launchOptions = { ...locations, stackId: saved.id, lifeline: session };
  const cached = yield* Ref.make<Connection | undefined>(undefined);
  const gate = yield* Semaphore.make(1);
  const connectTo = (access: HostAccess) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(handleScope, "sequential");
      const rpc = yield* ownerClient(access).pipe(Scope.provide(scope));
      const connection: Connection = { access, rpc, scope, active: 0, retired: false };
      return connection;
    });
  const resolve = (reach: Reach) =>
    // A session stack's owner is spawned only by its creator, which holds the lifeline.
    reach === "launch" && (!session || seed.creator === true)
      ? launchHost(state, launchOptions)
      : connectHost(state, saved.id).pipe(
          Effect.mapError((cause) =>
            session && ownerAbsent(cause) && reach === "launch"
              ? new HostProcessError({
                  operation: "connect",
                  message: `Session stack ${saved.id} has no live owner; it ends when its creator exits`,
                  reason: "not-running",
                })
              : cause,
          ),
        );
  const closeIfIdle = (connection: Connection) =>
    Effect.suspend(() =>
      connection.retired && connection.active === 0
        ? Scope.close(connection.scope, Exit.void)
        : Effect.void,
    );
  /** Stops lending a connection; calls and streams already using it run to completion. */
  const retire = (current: Connection) =>
    Ref.set(cached, undefined).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          current.retired = true;
          return closeIfIdle(current);
        }),
      ),
    );
  /** Whether the lease is held by the owner this connection reached, not a successor or sweeper. */
  const stillOwned = ({ access }: Connection) =>
    Effect.gen(function* () {
      if (!(yield* state.leased(saved.id))) return false;
      const holder = yield* state.readHolder(saved.id);
      return (
        holder?.role === "owner" &&
        holder.pid === access.endpoint.pid &&
        holder.port === access.endpoint.port &&
        holder.secret === access.secret
      );
    });
  const connection = (reach: Reach) =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(cached);
      if (existing !== undefined) {
        // Another process can bind a departed owner's port, so reuse needs that owner's lease.
        if (yield* stillOwned(existing)) return existing;
        yield* retire(existing);
      }
      // A spawned session owner's lifeline belongs to the handle, not to this call.
      const access = yield* resolve(reach).pipe(Effect.provideService(Scope.Scope, handleScope));
      return yield* connectTo(access).pipe(
        Effect.tap((connected) => Ref.set(cached, connected)),
        Effect.uninterruptible,
      );
    });
  /**
   * Uses the cached connection for the enclosing scope, resolving the owner when there is none.
   * Waiting for the gate or the owner stays interruptible.
   */
  const borrow = (reach: Reach) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      return yield* gate.withPermits(1)(
        connection(reach).pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              current.active++;
            }).pipe(
              Effect.andThen(
                Scope.addFinalizer(
                  scope,
                  Effect.suspend(() => {
                    current.active--;
                    return closeIfIdle(current);
                  }),
                ),
              ),
              Effect.uninterruptible,
            ),
          ),
        ),
      );
    });
  /** Drops the cached connection; calls and streams already using it run to completion. */
  const invalidate = (connection?: Connection) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(cached);
        if (current === undefined || (connection !== undefined && current !== connection)) return;
        yield* retire(current);
      }),
    );
  const dropIfGone = (connection: Connection) => (cause: unknown) =>
    ownerGone(cause) ? invalidate(connection) : Effect.void;
  if (seed.access !== undefined) yield* Ref.set(cached, yield* connectTo(seed.access));
  const invoke = <A, E, R>(run: (rpc: Client) => Effect.Effect<A, E, R>, reach: Reach) =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* borrow(reach);
        return yield* run(current.rpc).pipe(Effect.tapError(dropIfGone(current)));
      }),
    ).pipe(Effect.retry({ times: 1, while: ownerGone }), Effect.provideContext(services));
  const call = <A, E, R>(
    operation: string,
    run: (rpc: Client) => Effect.Effect<A, E, R>,
    reach: Reach = "launch",
  ) => invoke(run, reach).pipe(Effect.mapError((cause) => failure(operation, cause)));
  /** Without a live owner, or with a destroyed stack, nothing runs, so the request is already satisfied. */
  const whileRunning = <A, E, R>(
    operation: string,
    run: (rpc: Client) => Effect.Effect<A, E, R>,
    idle: A,
  ) =>
    invoke(run, "attach").pipe(
      Effect.catchIf(
        (cause) => ownerAbsent(cause) || stackGone(cause),
        () => Effect.succeed(idle),
      ),
      Effect.mapError((cause) => failure(operation, cause)),
    );
  const stream = <A, E>(operation: string, run: (rpc: Client) => Stream.Stream<A, E>) =>
    Stream.unwrap(
      borrow("attach").pipe(
        Effect.map((current) => run(current.rpc).pipe(Stream.tapError(dropIfGone(current)))),
        Effect.provideContext(services),
      ),
    ).pipe(Stream.mapError((cause) => failure(operation, cause)));
  const shutdown = Effect.fn("Stack.shutdown")(function* (destroy: boolean) {
    const operation = destroy ? "destroy" : "shutdown";
    yield* invalidate();
    const engine = saved.runtime === "native" ? undefined : saved.runtime;
    // Shutdown uses the release-stable endpoint, so it reaches owners of any release.
    const { endpoint, refusal, engineUnavailable } = yield* Effect.scoped(
      Effect.gen(function* () {
        const idle = { endpoint: undefined, refusal: Exit.void, engineUnavailable: false };
        const live = yield* connectHost(state, saved.id, { anyRelease: true }).pipe(
          Effect.map(Option.some),
          Effect.catchIf(ownerAbsent, () =>
            destroy
              ? launchHost(state, launchOptions).pipe(Effect.map(Option.some))
              : Effect.succeed(Option.none<HostAccess>()),
          ),
          Effect.catchIf(stackGone, () => Effect.succeed(Option.none<HostAccess>())),
          // The owner's startup sweep reports an unreachable engine before any owner serves.
          Effect.catchIf(
            (cause) => engine !== undefined && hasReason("runtime-unavailable")(cause),
            () => Effect.succeed("engine-unavailable" as const),
          ),
        );
        if (live === "engine-unavailable") return { ...idle, engineUnavailable: true };
        if (Option.isNone(live)) return idle;
        const access = live.value;
        const endpoint = access.endpoint;
        const refusal = yield* shutdownHost(access, destroy).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (rejected) =>
                Effect.fail(
                  new StackError({
                    operation: "shutdown",
                    message: rejected.message,
                    ...(rejected.outcomes === undefined ? {} : { outcomes: rejected.outcomes }),
                  }),
                ),
            }),
          ),
          Effect.exit,
        );
        return { endpoint, refusal, engineUnavailable: false };
      }),
    ).pipe(
      Effect.provideContext(services),
      Effect.mapError((cause) => failure(operation, cause)),
    );
    if (engineUnavailable && engine !== undefined)
      return yield* destroyWithoutEngine(state, saved, locations, engine).pipe(
        Effect.provideContext(services),
      );
    if (endpoint === undefined) return { runtimeCleanup: "complete" } as const;
    if (Exit.isFailure(refusal)) {
      const shutdownFailure = Option.match(Cause.findErrorOption(refusal.cause), {
        onNone: () => failure(operation, Cause.pretty(refusal.cause)),
        onSome: (cause) => failure(operation, cause),
      });
      if (!destroy) return yield* shutdownFailure;
      const exitResult = yield* waitForOwnerExit(endpoint.pid, ownerExitProbe(fs)).pipe(
        Effect.mapError((cause) => failure("shutdown-exit", cause)),
        Effect.exit,
      );
      if (Exit.isFailure(exitResult)) {
        const exitFailure = Option.match(Cause.findErrorOption(exitResult.cause), {
          onNone: () => failure("shutdown-exit", Cause.pretty(exitResult.cause)),
          onSome: (cause) => failure("shutdown-exit", cause),
        });
        const exitStatus = exitFailure.message.includes("still running")
          ? "Owner is still running after failed destroy"
          : "Owner exit was not confirmed after failed destroy";
        return yield* new StackError({
          ...shutdownFailure,
          message: `${shutdownFailure.message}; ${exitStatus}; exit probe: ${exitFailure.message}`,
        });
      }
      return yield* shutdownFailure;
    }
    yield* waitForOwnerExit(endpoint.pid, ownerExitProbe(fs)).pipe(
      Effect.mapError((cause) => failure("shutdown-exit", cause)),
    );
    return { runtimeCleanup: "complete" } as const;
  });

  const snapshotScope = (options: DatabaseSnapshotOptions | undefined) =>
    options?.scope === undefined ? {} : { scope: options.scope };
  const readLogs =
    (id: string) =>
    (options?: ReadLogsOptions): Stream.Stream<LogRecord, StackError> =>
      stream("readLogs", (rpc) =>
        rpc.readLogs({
          id,
          follow: options?.follow ?? false,
          ...(options?.from === undefined ? {} : { from: options.from }),
          ...(options?.since === undefined ? {} : { since: options.since }),
          ...(options?.tail === undefined ? {} : { tail: options.tail }),
        }),
      );
  const common = <K extends Kind>(id: string, service: K): ServiceInstance<K> => ({
    id,
    service,
    start: call("start", (rpc) => rpc.startService({ id })),
    ready: call("ready", (rpc) => rpc.readyService({ id }), "attach"),
    stop: whileRunning("stop", (rpc) => rpc.stopService({ id }), undefined),
    restart: (input) =>
      input === undefined
        ? call("restart", (rpc) => rpc.restartService({ id }))
        : Schema.decodeUnknownEffect(ServiceCreationInputSchema)(
            "service" in input ? input : { service, config: input.config },
          ).pipe(
            Effect.mapError((cause) => failure("restart", cause)),
            Effect.flatMap((creation) =>
              call("restart", (rpc) => rpc.restartService({ id, config: creation })),
            ),
          ),
    destroy: call("destroy", (rpc) => rpc.destroyService({ id })),
    prepare: call("prepare", (rpc) => rpc.prepareService({ id })),
    status: call("status", (rpc) => rpc.status({ id }), "attach"),
    followStatus: stream("followStatus", (rpc) => rpc.followStatus({ id })),
    readLogs: readLogs(id),
    credentials: (options) =>
      call("credentials", (rpc) => rpc.credentials({ id, from: options?.from ?? "host" })),
  });
  function instance<Input extends ServiceCreation>(definition: {
    id: string;
    creation: Input;
  }): ServiceInstances[Input["service"]];
  function instance(definition: Definition): AnyInstance {
    const { id, creation } = definition;
    switch (creation.service) {
      case "database":
        return {
          ...common(id, "database"),
          saveSnapshot: (key, options) =>
            call("saveSnapshot", (rpc) => rpc.saveSnapshot({ id, key, ...snapshotScope(options) })),
          restoreSnapshot: (key, options) =>
            call("restoreSnapshot", (rpc) =>
              rpc.restoreSnapshot({ id, key, ...snapshotScope(options) }),
            ),
          resetData: call("resetData", (rpc) => rpc.resetData({ id })),
        };
      case "rest":
        return common(id, "rest");
      case "auth":
        return common(id, "auth");
      case "realtime":
        return common(id, "realtime");
      case "storage":
        return common(id, "storage");
      case "imgproxy":
        return common(id, "imgproxy");
      case "functions":
        return common(id, "functions");
      case "studio":
        return common(id, "studio");
      case "pgmeta":
        return common(id, "pgmeta");
      case "mail":
        return common(id, "mail");
      case "analytics":
        return common(id, "analytics");
      case "pooler":
        return common(id, "pooler");
    }
  }
  function create<Input extends ServiceCreationInput>(
    creation: Input,
  ): Effect.Effect<ServiceInstances[Input["service"]], StackError>;
  function create(creation: ServiceCreationInput): Effect.Effect<AnyInstance, StackError> {
    return call("createService", (rpc) => rpc.createService(creation)).pipe(Effect.map(instance));
  }
  const runInvocation = Effect.fn("Stack.runCommand")(function* <E, R>(
    command: CommandInvocation,
    stdin: Stream.Stream<Uint8Array, E, R> | undefined,
    stdout: (bytes: Uint8Array) => Effect.Effect<void, E, R>,
    stderr: (bytes: Uint8Array) => Effect.Effect<void, E, R>,
  ) {
    // A request that never reached this stack's owner is resent once, as `invoke` does.
    let resend = false;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        resend = false;
        let started = false;
        const current = yield* borrow("launch").pipe(
          Effect.provideContext(services),
          Effect.mapError((cause) => failure("command", cause)),
        );
        const { rpc } = current;
        const attachmentId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => failure("command", cause)),
        );
        const scope = yield* Scope.Scope;
        const inputFailure = yield* Deferred.make<never, E | StackError>();
        const result = yield* Ref.make<{ jobId: string; exitCode: number } | undefined>(undefined);
        const sender = yield* Ref.make<Fiber.Fiber<void, E | StackError> | undefined>(undefined);
        const encodedCommand =
          command.type === "postgres" && command.pgProve !== undefined
            ? {
                ...command,
                pgProve: {
                  ...command.pgProve,
                  mounts: command.pgProve.mounts.map(({ source, target }) => ({ source, target })),
                },
              }
            : command;
        yield* rpc.runCommand({ attachmentId, command: encodedCommand }).pipe(
          Stream.tapError((cause) =>
            ownerGone(cause) && !started
              ? invalidate(current).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      resend = true;
                    }),
                  ),
                )
              : Effect.void,
          ),
          Stream.tap(() =>
            Effect.sync(() => {
              started = true;
            }),
          ),
          Stream.mapError((cause) => failure("command", cause)),
          Stream.runForEach((event): Effect.Effect<void, E | StackError, R> =>
            Match.valueTags(event, {
              Attached: () =>
                stdin === undefined
                  ? Effect.void
                  : stdin.pipe(
                      Stream.runForEach((bytes) =>
                        Effect.forEach(
                          Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, index) =>
                            bytes.subarray(index * 65536, (index + 1) * 65536),
                          ),
                          (chunk) =>
                            rpc
                              .commandInput({ attachmentId, bytes: chunk })
                              .pipe(Effect.mapError((cause) => failure("stdin", cause))),
                          { discard: true },
                        ),
                      ),
                      Effect.andThen(
                        rpc
                          .commandInput({ attachmentId, bytes: null })
                          .pipe(Effect.mapError((cause) => failure("stdin", cause))),
                      ),
                      Effect.catchIf(
                        (cause) =>
                          Schema.is(StackError)(cause) &&
                          cause.operation === "command-input-closed",
                        () => Effect.void,
                      ),
                      Effect.tapCause((cause) => Deferred.failCause(inputFailure, cause)),
                      Effect.forkIn(scope),
                      Effect.flatMap((fiber) => Ref.set(sender, fiber)),
                    ),
              Stdout: (output) => stdout(output.bytes),
              Stderr: (output) => stderr(output.bytes),
              Completed: (completed) =>
                Ref.set(result, { jobId: completed.jobId, exitCode: completed.exitCode }),
            }),
          ),
          Effect.raceFirst(Deferred.await(inputFailure)),
        );
        const input = yield* Ref.get(sender);
        if (input !== undefined) yield* Fiber.interrupt(input);
        const completed = yield* Ref.get(result);
        if (completed === undefined)
          return yield* failure("command", "Command attachment ended without an exit result");
        return completed;
      }),
    ).pipe(Effect.retry({ times: 1, while: () => resend }));
  });
  function run<E, R>(
    command: PostgresCommand,
    options: PostgresCommandOptions<E, R>,
  ): Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | StackError, R>;
  function run<E = never, R = never>(
    command: InitializationCommand,
    options?: InitializationCommandOptions<E, R>,
  ): Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | StackError, R>;
  function run<E, R>(
    command: PostgresCommand | InitializationCommand,
    options?: InternalCommandOptions<E, R>,
  ) {
    if ("type" in command)
      return runInvocation(
        command,
        undefined,
        options?.stdout ?? (() => Effect.void),
        options?.stderr ?? (() => Effect.void),
      );
    return runInvocation(
      {
        type: "postgres",
        command,
        args: options?.args ?? [],
        env: options?.env ?? {},
        ...(options?.pgProve === undefined ? {} : { pgProve: options.pgProve }),
        stdin: options?.stdin !== undefined,
      },
      options?.stdin,
      options?.stdout ?? (() => Effect.void),
      options?.stderr ?? (() => Effect.void),
    );
  }
  const savedDefinition = Effect.gen(function* () {
    const current = yield* state.read(saved.id);
    if (current === undefined) return yield* failure("definition", "Stack does not exist");
    return current;
  }).pipe(Effect.mapError((cause) => failure("definition", cause)));
  const definitions = savedDefinition.pipe(Effect.map((current) => current.instances));
  return {
    id: saved.id,
    services: {
      create,
      get: (id: string) =>
        definitions.pipe(
          Effect.flatMap((entries) => {
            const definition = entries.find((entry) => entry.id === id);
            return definition === undefined
              ? Effect.fail(failure("service", `Unknown service ${id}`))
              : Effect.succeed(instance(definition));
          }),
        ),
      list: definitions.pipe(Effect.map((entries) => entries.map(instance))),
    },
    credentials: {
      get: state.read(saved.id).pipe(
        Effect.map((current) => current?.credentials),
        Effect.mapError((cause) => failure("credentials", cause)),
      ),
    },
    composition: {
      supabase: (
        services: ReadonlyArray<ServiceCreationInput>,
        options?: SupabaseCompositionOptions,
      ) =>
        call("supabaseComposition", (rpc) =>
          rpc.supabaseComposition({
            services,
            ...(options?.reuseIds === undefined ? {} : { reuseIds: options.reuseIds }),
            ...(options?.keys === undefined ? {} : { keys: options.keys }),
            ...(options?.eager === undefined ? {} : { eager: options.eager }),
          }),
        ).pipe(Effect.map((definitions) => definitions.map(instance))),
      plan: (services: ReadonlyArray<ServiceCreationInput>) =>
        Effect.forEach(services, (service) =>
          Schema.decodeEffect(ServiceCreationInputSchema)(service),
        ).pipe(
          Effect.mapError((cause) => failure("plan", cause)),
          Effect.flatMap((requested) =>
            savedDefinition.pipe(
              Effect.map((current) => planSupabaseComposition(current, requested)),
            ),
          ),
        ),
      configure: (config: Orchestrator.CompositionConfig) =>
        call("configureComposition", (rpc) => rpc.configureComposition(config)),
      describe: savedDefinition.pipe(Effect.map((current) => current.composition)),
      start: call("startComposition", (rpc) => rpc.startComposition()),
      stop: whileRunning("stopComposition", (rpc) => rpc.stopComposition(), []),
      restart: call("restartComposition", (rpc) => rpc.restartComposition()),
    },
    gateway: { readLogs: readLogs(gatewayLog.instanceId) },
    stop: shutdown(false).pipe(Effect.asVoid),
    destroy: shutdown(true),
    commands: { run },
  } satisfies Stack;
});

/**
 * Registers a stack; a matching existing identity must be opened explicitly. The handle's
 * connections, and a session stack itself, last until the enclosing scope closes.
 */
export const create = Effect.fn("Stack.create")(
  function* (options: CreateOptions) {
    const state = yield* stateFor(options.stateRoot);
    const identity = yield* resolveStackIdentity(options);
    const id = yield* deriveStackId(identity);
    const saved: SavedStack = {
      id,
      identity,
      lifetime: options.lifetime ?? "detached",
      runtime: options.runtime,
      instances: [],
      composition: { members: [], dependencies: [] },
      ports: [],
    };
    const locations = { stateRoot: options.stateRoot, cacheRoot: options.cacheRoot };
    const existing = yield* state.read(id);
    // A session stack whose owner is gone is disposable, so its identity is free again.
    if (existing?.lifetime === "session" && !(yield* state.leased(id)))
      yield* reclaimStack({
        state,
        stateRoot: options.stateRoot,
        cacheRoot: options.cacheRoot,
        id,
      });
    const session = saved.lifetime === "session";
    if (session || options.startOwner === true) {
      if ((yield* state.read(id)) !== undefined)
        return yield* failure("create", "Stack already exists; use open");
      // The owner registers the stack under its lease and removes it if its startup fails, so no
      // sweep sees a session stack unowned and a failed launch leaves no registration behind.
      const access = yield* launchHost(state, {
        ...locations,
        stackId: id,
        register: saved,
        lifeline: session,
      });
      return yield* makeHandle(state, saved, locations, { access, creator: true });
    }
    yield* state.withLock(
      Effect.gen(function* () {
        if ((yield* state.read(id)) !== undefined)
          return yield* failure("create", "Stack already exists; use open");
        yield* state.save(saved);
      }),
    );
    return yield* makeHandle(state, saved, locations);
  },
  Effect.mapError((cause) => failure("create", cause)),
);

/** Opens saved definitions and optionally starts the detached owner without starting services. */
export const open = Effect.fn("Stack.open")(
  function* (options: OpenOptions) {
    const state = yield* stateFor(options.stateRoot);
    const saved = yield* state.read(options.id);
    if (saved === undefined) return yield* failure("open", "Stack does not exist");
    const locations = { stateRoot: options.stateRoot, cacheRoot: options.cacheRoot };
    const access = !options.startOwner
      ? undefined
      : saved.lifetime === "session"
        ? yield* connectHost(state, saved.id)
        : yield* launchHost(state, { ...locations, stackId: saved.id });
    return yield* makeHandle(state, saved, locations, { access });
  },
  Effect.mapError((cause) => failure("open", cause)),
);

/**
 * Lists readable saved stacks with their live owners; `onInvalidState` observes skipped entries.
 * `idPrefix` limits both, and the owner probes, to stacks whose id starts with it.
 */
export const discover = Effect.fn("Stack.discover")(
  function* (
    options: Pick<StackLocations, "stateRoot"> & {
      readonly idPrefix?: string;
      readonly onInvalidState?: (id: string, error: State.StateError) => Effect.Effect<void>;
    },
  ) {
    const selected = (id: string) =>
      options.idPrefix === undefined || id.startsWith(options.idPrefix);
    const onInvalidState = options.onInvalidState;
    const state = yield* State.Service.pipe(
      Effect.provide(
        State.layer({
          root: options.stateRoot,
          onInvalidState:
            onInvalidState === undefined
              ? undefined
              : (id, error) => (selected(id) ? onInvalidState(id, error) : Effect.void),
        }),
      ),
    );
    const saved = (yield* state.list).filter(({ id }) => selected(id));
    return yield* Effect.forEach(
      saved,
      (definition) =>
        observeHost(state, definition).pipe(Effect.map((host) => ({ definition, host }))),
      { concurrency: 8 },
    );
  },
  Effect.mapError((cause) => failure("discover", cause)),
);

/** Selects a saved stack by id, or by the identity a project root and stack name derive. */
export type FindOptions = Pick<StackLocations, "stateRoot"> &
  ({ readonly id: string } | { readonly projectRoot: string; readonly name?: string });

/** A saved stack with the endpoint of the live owner holding its lease, if any. */
export interface FoundStack {
  readonly definition: SavedStack;
  readonly host: HostEndpoint | undefined;
}

/** Reads the one saved stack a selection names; unreadable state fails instead of being skipped. */
export const find = Effect.fn("Stack.find")(
  function* (options: FindOptions) {
    const state = yield* stateFor(options.stateRoot);
    const id =
      "id" in options ? options.id : yield* deriveStackId(yield* resolveStackIdentity(options));
    const definition = yield* state.read(id);
    if (definition === undefined) return Option.none<FoundStack>();
    return Option.some({ definition, host: yield* observeHost(state, definition) });
  },
  Effect.mapError((cause) => failure("find", cause)),
);

/** Selects a stack that is no longer registered while containers labelled with its data root remain. */
export const findDeleted = Effect.fn("Stack.findDeleted")(
  function* (options: StackLocations & { readonly id: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | Crypto.Crypto
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >();
    // A registry that cannot be opened or read is left to `find`, which reports it.
    const registry = yield* Effect.gen(function* () {
      const state = yield* stateFor(options.stateRoot);
      const saved = yield* state.read(options.id);
      return { state, saved, stateRoot: yield* fs.realPath(options.stateRoot) };
    }).pipe(Effect.option);
    if (Option.isNone(registry) || registry.value.saved !== undefined)
      return Option.none<DeletedStack>();
    const { state, stateRoot } = registry.value;
    const root = path.join(stateRoot, options.id, "data");
    const probes = yield* Effect.forEach(
      ["docker", "podman"] as const,
      (engine) =>
        listStackContainers(engine).pipe(
          Effect.map((containers) =>
            containers.some(
              (container) => container.stackId === options.id && container.root === root,
            ),
          ),
          Effect.catchIf(
            (error) => error.reason === "engine-unavailable",
            () => Effect.succeed(false),
          ),
          Effect.result,
          Effect.map((listed) => ({ engine, listed })),
        ),
      { concurrency: "unbounded" },
    );
    const matched = probes.filter(({ listed }) => Result.isSuccess(listed) && listed.success);
    const [unlisted] = probes.flatMap(({ engine, listed }) =>
      Result.isFailure(listed)
        ? [
            `Unable to list ${engine === "docker" ? "Docker" : "Podman"} containers while looking for stack ${options.id}'s leftovers: ${listed.failure.message}`,
          ]
        : [],
    );
    if (matched.length === 0) {
      if (unlisted === undefined) return Option.none<DeletedStack>();
      return yield* failure("find", unlisted);
    }
    const destroy = Effect.gen(function* () {
      for (const { engine } of matched) {
        const refusal = Match.value(yield* reclaimStack({ ...options, state, engine })).pipe(
          Match.when("reclaimed", () => undefined),
          Match.when("held", () => "Another process holds this stack's lease; run destroy again"),
          Match.when("registered", () => `Stack ${options.id} was registered again during destroy`),
          Match.exhaustive,
        );
        if (refusal !== undefined) return yield* failure("destroy", refusal);
      }
      if (unlisted !== undefined)
        return yield* failure(
          "destroy",
          `Removed the ${matched.map(({ engine }) => (engine === "docker" ? "Docker" : "Podman")).join(" and ")} containers stack ${options.id} left behind. ${unlisted}`,
        );
      return { runtimeCleanup: "complete" } as const;
    }).pipe(
      Effect.mapError((cause) => failure("destroy", cause)),
      Effect.provideContext(services),
    );
    return Option.some<DeletedStack>({ id: options.id, destroy });
  },
  Effect.mapError((cause) => failure("find", cause)),
);

export type DeletedStack = Pick<Stack, "id" | "destroy">;

/** Selects the persisted logs of a stack; its owner does not need to run. */
export interface StreamStackLogsOptions extends Pick<StackLocations, "stateRoot"> {
  readonly stackId: string;
  /** Instance ids to read; every instance with persisted logs by default. */
  readonly instances?: ReadonlyArray<string>;
  /** An ISO-8601 timestamp; older records are skipped. */
  readonly since?: string;
}

/** Streams a stack's persisted records one instance after another, each in file order. */
export const streamStackLogs = (
  options: StreamStackLogsOptions,
): Stream.Stream<StackLogRecord, StackError, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* State.stackLogsRoot(path, options.stateRoot, options.stackId);
      return streamPersistedLogs({
        root,
        ...(options.instances === undefined ? {} : { instances: options.instances }),
        ...(options.since === undefined ? {} : { since: yield* sinceMillis(options.since) }),
      });
    }),
  ).pipe(Stream.mapError((cause) => failure("streamStackLogs", cause)));
