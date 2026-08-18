import { createHash } from "node:crypto";
import {
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schedule,
  Semaphore,
  Scope,
} from "effect";
import { isAbsolute, relative, resolve } from "node:path";
import { PORT_CATALOG, type PortField, type PortSet } from "../PortCatalog.ts";
import {
  reservePortSet,
  type PortAllocationError,
  type PortLease,
  type PortReservationRequest,
} from "../PortAllocator.ts";
import {
  acquireControl,
  CONTROL_PORT_RANGE,
  controlEndpoint,
  ControlTransport,
  probeControl,
  type ControlAcquisition,
  type ControlOwnerStatus,
  type ControlOwnership,
} from "./control.ts";
import {
  discoverEnvironment,
  deriveStackId,
  ensureEnvironment,
  validateEnvironmentRepair,
  type EnvironmentIdentity,
  type RepairReason,
  type RepairRequest,
  type WorkspaceDiscovery,
} from "./environment.ts";
import { GitConfigStore, inspectWorkspace } from "./git.ts";
import {
  canonicalizeManagedWorkspacePathWithFileSystem,
  readOrdinaryWorkspaceIdentityWithFileSystem,
  updateGitCheckoutLocationOwned,
} from "./identity.ts";
import {
  ManagedExactPortOccupiedError,
  InvalidManagedStackNameError,
  InvalidManagedIdentityError,
  ManagedPortAllocationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  type ManagedPortAssignment,
  type ManagedPortDrift,
  type ManagedPortIntentDocument,
  validateManagedStackName,
} from "./model.ts";
import {
  managedPortReservationsConflict,
  planManagedPorts,
  type ManagedPortPlan,
} from "./port-plan.ts";
import { resolvePortIntents } from "./port-intent.ts";
import { makeStackStore, type ManagedStackListing } from "./store.ts";
import type { ManagedStackDocument } from "./document.ts";
import { dockerForceRemove } from "../cleanup.ts";
import { SERVICE_NAMES } from "../ServiceCatalog.ts";
import { dockerContainerName } from "../StackIdentity.ts";

/** A document joined with a transient drift report for read-only callers. */
export interface ManagedStack extends ManagedStackDocument {
  readonly drift?: ReadonlyArray<ManagedPortDrift>;
}

export interface ReadStackRequest {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
}

export interface StartStackRequest {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
  /** The supervisor-owned lifecycle capability for this deterministic stack. */
  readonly ownership: ControlOwnership;
  readonly lifecycle?: ManagedStackDocument["lifecycle"];
  readonly runtime?: ManagedStackDocument["runtime"];
  readonly launch?: ManagedStackDocument["launch"];
}

export interface AllocateManagedPortsRequest {
  readonly stackId: string;
  readonly portDocument: ManagedPortIntentDocument;
  readonly persisted?: ReadonlyArray<ManagedPortAssignment>;
}

export interface ManagedPortAllocation {
  readonly assignments: ReadonlyArray<ManagedPortAssignment>;
  readonly lease: ManagedPortLease;
}

interface ManagedStackStartResultBase {
  readonly stack: ManagedStack;
}

export type ManagedStackStartResult = ManagedStackStartResultBase & {
  /** The lease remains live until the caller's Effect scope closes. */
  readonly lease: ManagedPortLease;
};

export interface ManagedStackLifecycleUpdate {
  readonly stackId: string;
  readonly lifecycle: ManagedStackDocument["lifecycle"];
  /** A running runtime descriptor, or `null` to clear stale runtime state. */
  readonly runtime?: ManagedStackDocument["runtime"] | null;
}

export interface ManagedStackLaunchUpdate {
  readonly stackId: string;
  readonly launch: NonNullable<ManagedStackDocument["launch"]>;
}

export interface ManagedPortLease {
  readonly ports: PortSet;
  readonly reserve: (fields: ReadonlyArray<PortField>) => Effect.Effect<void, PortAllocationError>;
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}

export type ManagedDeleteResult =
  | { readonly outcome: "removed"; readonly stackId: string }
  | { readonly outcome: "already-absent"; readonly stackId: string };

export class ManagedStackControlRequiredError extends Data.TaggedError(
  "ManagedStackControlRequiredError",
)<{
  readonly stackId: string;
}> {
  override get message(): string {
    return `Managed stack ${this.stackId} requires its owned control endpoint`;
  }
}

export class ManagedStackAttachedError extends Data.TaggedError("ManagedStackAttachedError")<{
  readonly stackId: string;
}> {
  override get message(): string {
    return `Managed stack ${this.stackId} is owned by another process`;
  }
}

export class ManagedWorkspaceRepairConflictError extends Data.TaggedError(
  "ManagedWorkspaceRepairConflictError",
)<{
  readonly stackId?: string;
  readonly repairReason?: RepairReason;
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export const workspaceRepairConflict = (
  repairReason: RepairReason,
): ManagedWorkspaceRepairConflictError =>
  new ManagedWorkspaceRepairConflictError({
    repairReason,
    reason:
      repairReason === "moved"
        ? "Moved checkout requires repair; call repairWorkspace with the discovery repair request"
        : "Duplicate checkout requires an explicit ownership decision; repairWorkspace cannot adopt it",
  });

export type ManagedStackManagerError =
  | ManagedStackControlRequiredError
  | ManagedStackAttachedError
  | ManagedWorkspaceRepairConflictError
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | ManagedExactPortOccupiedError
  | ManagedPortAllocationError
  | PlatformError.PlatformError
  | import("./document.ts").InvalidManagedStackDocumentError
  | import("./model.ts").InvalidManagedIdentityError
  | InvalidManagedStackNameError
  | import("./model.ts").UnsupportedGitWorkspaceError
  | import("./control.ts").InvalidControlOwnershipIdError
  | import("./control.ts").ControlBindError
  | import("./control.ts").ControlTransportError
  | import("./control.ts").ControlProtocolError
  | import("./control.ts").ControlProtocolMismatchError
  | import("./control.ts").ControlAddressConflictError;

export interface ManagedStackManagerShape {
  readonly stateRoot: string;
  readonly discoverWorkspace: (
    path: string,
  ) => Effect.Effect<WorkspaceDiscovery, ManagedStackManagerError>;
  readonly ensureWorkspace: (
    path: string,
  ) => Effect.Effect<WorkspaceDiscovery, ManagedStackManagerError>;
  readonly acquireControl: (
    stackId: string,
  ) => Effect.Effect<ControlAcquisition, ManagedStackManagerError, Scope.Scope>;
  readonly probeControl: (
    stackId: string,
  ) => Effect.Effect<ControlOwnerStatus | undefined, ManagedStackManagerError>;
  readonly readStack: (
    request: ReadStackRequest,
  ) => Effect.Effect<ManagedStack | undefined, ManagedStackManagerError>;
  readonly startStack: (
    request: StartStackRequest,
  ) => Effect.Effect<
    ManagedStackStartResult,
    ManagedStackManagerError,
    import("effect/Scope").Scope
  >;
  readonly inspectStack: (
    stackId: string,
  ) => Effect.Effect<ManagedStack | undefined, ManagedStackManagerError>;
  readonly listStacks: () => Effect.Effect<
    ReadonlyArray<ManagedStackListing>,
    ManagedStackManagerError,
    never
  >;
  readonly allocateManagedPorts: (
    ownership: ControlOwnership,
    request: AllocateManagedPortsRequest,
  ) => Effect.Effect<ManagedPortAllocation, ManagedStackManagerError, import("effect/Scope").Scope>;
  /** Persist one owner-gated lifecycle transition for the supervisor. */
  readonly recordLifecycle: (
    ownership: ControlOwnership,
    update: ManagedStackLifecycleUpdate,
  ) => Effect.Effect<ManagedStack, ManagedStackManagerError>;
  /** Persist launch selections under the stack's control ownership. */
  readonly updateLaunch: (
    ownership: ControlOwnership,
    update: ManagedStackLaunchUpdate,
  ) => Effect.Effect<ManagedStack, ManagedStackManagerError>;
  readonly repairWorkspace: (
    request: RepairRequest,
  ) => Effect.Effect<WorkspaceDiscovery, ManagedStackManagerError>;
  readonly deleteStack: (
    stackId: string,
    ownership: ControlOwnership,
  ) => Effect.Effect<ManagedDeleteResult, ManagedStackManagerError>;
}

type ManagerRequirements = FileSystem.FileSystem | Path.Path | GitConfigStore | ControlTransport;

export class ManagedStackManager extends Context.Service<
  ManagedStackManager,
  ManagedStackManagerShape
>()("stack/managed/ManagedStackManager") {}

const now = (): string => new Date().toISOString();

const lengthPrefixed = (value: string): Uint8Array => {
  const bytes = new TextEncoder().encode(value);
  const result = new Uint8Array(4 + bytes.byteLength);
  new DataView(result.buffer).setUint32(0, bytes.byteLength);
  result.set(bytes, 4);
  return result;
};

/** Deterministic ownership id reserved for one moved-checkout repair. */
export const deriveRepairOwnershipId = (identity: EnvironmentIdentity): string => {
  const input = new Uint8Array([
    ...lengthPrefixed("supabase-stack-repair"),
    ...lengthPrefixed(identity.workspaceId),
    ...lengthPrefixed(identity.checkoutId),
  ]);
  return createHash("sha256").update(input).digest("hex");
};

const isOwned = (acquisition: ControlAcquisition): acquisition is ControlOwnership =>
  acquisition._tag === "Owned";

const isHealthyDocument = (
  listing: ManagedStackListing,
): listing is Extract<ManagedStackListing, { readonly status: "healthy" }> =>
  listing.status === "healthy";

const workspaceDocument = (discovery: WorkspaceDiscovery): ManagedStackDocument["workspace"] =>
  discovery.workspace;

const stackDrift = (
  document: ManagedStackDocument,
  portDocument: ManagedPortIntentDocument,
): ReadonlyArray<ManagedPortDrift> => {
  const current = new Map(document.ports.map((assignment) => [assignment.key, assignment]));
  return resolvePortIntents(portDocument).flatMap((request) => {
    const actual = current.get(request.key);
    if (actual === undefined) {
      const missing: ManagedPortDrift = {
        key: request.key,
        actualIntent: "automatic",
        configuredIntent: request.intent,
        ...(request.intent === "exact" ? { configuredPort: request.port } : {}),
      };
      return [missing];
    }
    const configuredPort = request.intent === "exact" ? request.port : actual.port;
    if (actual.intent === request.intent && actual.port === configuredPort) return [];
    const mismatch: ManagedPortDrift = {
      key: request.key,
      actualIntent: actual.intent,
      actualPort: actual.port,
      configuredIntent: request.intent,
      ...(request.intent === "exact" ? { configuredPort: request.port } : {}),
    };
    return [mismatch];
  });
};

const portRequests = (plan: ManagedPortPlan): ReadonlyArray<PortReservationRequest> =>
  [...plan.durable]
    .sort((left, right) => Number(right.intent === "exact") - Number(left.intent === "exact"))
    .map(({ field, selection }) => ({ field, selection }))
    .concat(plan.runtimeOnly);

const managedAssignments = (
  plan: ManagedPortPlan,
  ports: PortSet,
): Effect.Effect<ReadonlyArray<ManagedPortAssignment>, ManagedPortAllocationError> =>
  Effect.gen(function* () {
    const durable = yield* Effect.forEach(plan.durable, (entry) => {
      const port = entry.selection.kind === "exact" ? entry.selection.port : ports[entry.field];
      return port === undefined
        ? Effect.fail(
            new ManagedPortAllocationError({ fields: [entry.field], cause: "missing lease port" }),
          )
        : Effect.succeed({
            key: entry.key,
            port,
            intent: entry.intent,
          } satisfies ManagedPortAssignment);
    });
    return [...durable, ...plan.inactiveAssignments].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
  });

const requireOwnedForStack = (
  ownership: ControlOwnership,
  stackId: string,
): Effect.Effect<void, ManagedStackControlRequiredError> =>
  ownership.ownershipId === stackId
    ? Effect.void
    : Effect.fail(new ManagedStackControlRequiredError({ stackId }));

const conflictError = (
  stackId: string,
  assignment: ManagedPortAssignment,
  owner: ManagedStackDocument,
): ManagedExactPortOccupiedError =>
  new ManagedExactPortOccupiedError({
    key: assignment.key,
    port: assignment.port,
    stackId,
    ownerStackId: owner.id,
    ownerStackName: owner.identity.name,
    ownerKey: owner.ports.find((candidate) => candidate.port === assignment.port)?.key,
  });

const makeManager = (
  stateRoot: string,
): Effect.Effect<ManagedStackManagerShape, never, ManagerRequirements> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const gitConfig = yield* GitConfigStore;
    const controlTransport = yield* ControlTransport;
    const provideDependencies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(GitConfigStore, gitConfig),
        Effect.provideService(ControlTransport, controlTransport),
      );
    const store = yield* makeStackStore(stateRoot);
    const lifecycleLock = Semaphore.makeUnsafe(1);

    const validateOrdinaryWorkspaceIdentity = (
      discovery: WorkspaceDiscovery,
    ): Effect.Effect<void, ManagedStackManagerError> =>
      Effect.gen(function* () {
        if (discovery.workspace.kind !== "folder") return;
        const listings = yield* store.list();
        const matching = listings
          .filter(isHealthyDocument)
          .map((listing) => listing.document)
          .filter(
            (document) =>
              document.identity.workspaceId === discovery.identity.workspaceId &&
              document.identity.checkoutId === discovery.identity.checkoutId &&
              document.identity.contextId === discovery.identity.contextId &&
              document.identity.localProjectKey === discovery.identity.localProjectKey,
          );
        for (const document of matching) {
          const persistedPath = document.workspace.path;
          const persistedInfo = yield* fileSystem
            .stat(persistedPath)
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
              ),
            );
          if (persistedInfo === undefined || persistedInfo.type !== "Directory") continue;
          const canonicalPersistedPath = yield* provideDependencies(
            canonicalizeManagedWorkspacePathWithFileSystem(persistedPath),
          );
          if (canonicalPersistedPath === discovery.workspace.path) continue;
          const persistedInspection = yield* provideDependencies(
            inspectWorkspace(canonicalPersistedPath),
          );
          if (persistedInspection.kind !== "ordinary-folder") continue;
          const marker = yield* provideDependencies(
            readOrdinaryWorkspaceIdentityWithFileSystem(canonicalPersistedPath),
          );
          if (
            marker !== undefined &&
            marker.workspaceId === discovery.identity.workspaceId &&
            marker.checkoutId === discovery.identity.checkoutId &&
            marker.contextId === discovery.identity.contextId
          ) {
            return yield* Effect.fail(
              new InvalidManagedIdentityError({
                message:
                  "This ordinary workspace identity is already in use at another folder. Delete the current copied folder's .supabase/identity.json so a new identity can be generated.",
              }),
            );
          }
        }
      });

    const allocateManagedPorts = (
      ownership: ControlOwnership,
      request: AllocateManagedPortsRequest,
    ): Effect.Effect<
      ManagedPortAllocation,
      ManagedStackManagerError,
      import("effect/Scope").Scope
    > =>
      Effect.gen(function* () {
        yield* requireOwnedForStack(ownership, request.stackId);
        const persisted = request.persisted ?? [];
        const partialLeases: Array<PortLease> = [];
        const attempt = Effect.gen(function* () {
          const listings = yield* store.list();
          const plan = planManagedPorts({
            activeFields: request.portDocument.activeFields,
            disabledFields: request.portDocument.disabledFields,
            intents: resolvePortIntents(request.portDocument),
            persisted,
          });
          const requests = portRequests(plan);
          const exactRequests = requests.filter((item) => item.selection.kind === "exact");
          const automaticRequests = requests.filter((item) => item.selection.kind === "automatic");
          const invalidPersistedAutomatic = plan.durable.find(
            (entry) =>
              entry.intent === "automatic" &&
              entry.selection.kind === "exact" &&
              entry.selection.port >= CONTROL_PORT_RANGE.min &&
              entry.selection.port <= CONTROL_PORT_RANGE.max,
          );
          const invalidInactiveAutomatic = plan.inactiveAssignments.find(
            (assignment) =>
              assignment.intent === "automatic" &&
              assignment.port >= CONTROL_PORT_RANGE.min &&
              assignment.port <= CONTROL_PORT_RANGE.max,
          );
          const invalidPersistedPort =
            invalidPersistedAutomatic?.selection.kind === "exact"
              ? invalidPersistedAutomatic.selection.port
              : invalidInactiveAutomatic?.port;
          const invalidPersistedField =
            invalidPersistedAutomatic?.field ??
            Object.values(PORT_CATALOG).find(
              (entry) => entry.configKey === invalidInactiveAutomatic?.key,
            )?.field;
          if (invalidPersistedField !== undefined && invalidPersistedPort !== undefined) {
            return yield* Effect.fail(
              new ManagedPortAllocationError({
                fields: [invalidPersistedField],
                cause: `Persisted automatic port ${invalidPersistedPort} is reserved for managed control endpoints`,
              }),
            );
          }
          const strictReserved = new Set<number>();
          const exactReserved = new Set<number>([(yield* controlEndpoint(request.stackId)).port]);
          const owners = new Map<
            number,
            ReadonlyArray<{
              readonly document: ManagedStackDocument;
              readonly assignment: ManagedPortAssignment;
            }>
          >();
          for (const listing of listings.filter(isHealthyDocument)) {
            exactReserved.add((yield* controlEndpoint(listing.document.id)).port);
            if (listing.document.id === request.stackId) continue;
            for (const assignment of listing.document.ports) {
              const liveExact =
                assignment.intent === "exact" &&
                (listing.document.lifecycle === "running" ||
                  listing.document.lifecycle === "starting");
              owners.set(assignment.port, [
                ...(owners.get(assignment.port) ?? []),
                { document: listing.document, assignment },
              ]);
              if (assignment.intent === "automatic" || liveExact) {
                strictReserved.add(assignment.port);
              }
            }
          }
          for (const assignment of plan.inactiveAssignments) {
            strictReserved.add(assignment.port);
          }
          const requestedAssignments = exactRequests.flatMap((item) => {
            const entry = plan.durable.find((candidate) => candidate.field === item.field);
            if (entry?.selection.kind !== "exact") return [];
            return [
              {
                key: entry.key,
                port: entry.selection.port,
                intent: entry.intent,
              } satisfies ManagedPortAssignment,
            ];
          });
          for (const assignment of requestedAssignments) {
            const owner = (owners.get(assignment.port) ?? []).find((candidate) => {
              const lifecycle =
                candidate.document.lifecycle === "deleting"
                  ? "running"
                  : candidate.document.lifecycle;
              return managedPortReservationsConflict(request.stackId, assignment, {
                stackId: candidate.document.id,
                stackName: candidate.document.identity.name,
                lifecycle,
                assignment: candidate.assignment,
              });
            });
            if (owner !== undefined) {
              return yield* Effect.fail(conflictError(request.stackId, assignment, owner.document));
            }
            const inactiveOwner = plan.inactiveAssignments.find(
              (candidate) => candidate.port === assignment.port,
            );
            if (inactiveOwner !== undefined && assignment.intent === "exact") {
              return yield* Effect.fail(
                new ManagedExactPortOccupiedError({
                  key: assignment.key,
                  port: assignment.port,
                  stackId: request.stackId,
                  ownerStackId: request.stackId,
                  ownerKey: inactiveOwner.key,
                }),
              );
            }
          }
          const exactLease =
            exactRequests.length === 0
              ? undefined
              : yield* reservePortSet(exactRequests, { reserved: exactReserved }).pipe(
                  Effect.mapError((cause) => {
                    const entry =
                      cause.field === undefined
                        ? undefined
                        : plan.durable.find((candidate) => candidate.field === cause.field);
                    const key =
                      entry?.intent === "exact" ? PORT_CATALOG[entry.field].configKey : undefined;
                    return key !== undefined && cause.port !== undefined
                      ? new ManagedExactPortOccupiedError({
                          key,
                          port: cause.port,
                          stackId: request.stackId,
                        })
                      : new ManagedPortAllocationError({
                          fields: exactRequests.map((item) => item.field),
                          cause,
                        });
                  }),
                );
          if (exactLease !== undefined) partialLeases.push(exactLease);
          const automaticReserved = new Set<number>();
          for (let port = CONTROL_PORT_RANGE.min; port <= CONTROL_PORT_RANGE.max; port += 1) {
            automaticReserved.add(port);
          }
          for (const port of strictReserved) automaticReserved.add(port);
          for (const [port] of owners) {
            automaticReserved.add(port);
          }
          if (exactLease !== undefined) {
            for (const port of Object.values(exactLease.ports)) {
              if (port !== undefined) automaticReserved.add(port);
            }
          }
          const automaticLease =
            automaticRequests.length === 0
              ? undefined
              : yield* reservePortSet(automaticRequests, { reserved: automaticReserved }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedPortAllocationError({
                        fields: automaticRequests.map((item) => item.field),
                        cause,
                      }),
                  ),
                );
          if (automaticLease !== undefined) partialLeases.push(automaticLease);
          const ports: PortSet = {
            ...exactLease?.ports,
            ...automaticLease?.ports,
          };
          const assignments = yield* managedAssignments(plan, ports);
          const lease: ManagedPortLease = {
            ports,
            reserve: (fields) =>
              Effect.all(
                [
                  exactLease?.reserve(
                    fields.filter((field) => exactLease.ports[field] !== undefined),
                  ) ?? Effect.void,
                  automaticLease?.reserve(
                    fields.filter((field) => automaticLease.ports[field] !== undefined),
                  ) ?? Effect.void,
                ],
                { discard: true },
              ),
            release: (fields) =>
              Effect.all(
                [
                  exactLease?.release(fields) ?? Effect.void,
                  automaticLease?.release(fields) ?? Effect.void,
                ],
                { discard: true },
              ),
            releaseAll: Effect.all(
              [exactLease?.releaseAll ?? Effect.void, automaticLease?.releaseAll ?? Effect.void],
              { discard: true },
            ),
          };
          return { assignments, lease };
        });
        const guardedAttempt = Effect.exit(attempt).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.all(
                  partialLeases.map((lease) => lease.releaseAll),
                  { discard: true },
                ).pipe(Effect.andThen(Effect.failCause(exit.cause))),
          ),
        );
        const allocation = yield* guardedAttempt.pipe(
          Effect.retry({
            schedule: Schedule.spaced("5 millis").pipe(Schedule.upTo({ times: 2 })),
            while: (error) => error._tag === "ManagedPortAllocationError",
          }),
        );
        yield* Effect.addFinalizer(() => allocation.lease.releaseAll);
        return allocation;
      });

    const readStack = (
      request: ReadStackRequest,
    ): Effect.Effect<ManagedStack | undefined, ManagedStackManagerError> =>
      Effect.gen(function* () {
        const stackName = yield* validateManagedStackName(request.stackName ?? "default");
        const discovery = yield* provideDependencies(discoverEnvironment(request.workspacePath));
        yield* validateOrdinaryWorkspaceIdentity(discovery);
        if (discovery.state === "needsRepair") {
          return yield* Effect.fail(workspaceRepairConflict(discovery.reason));
        }
        const stackId = deriveStackId(discovery.identity, stackName);
        const existing = yield* store.read(stackId);
        if (existing === undefined) return undefined;
        yield* validateOrdinaryWorkspaceIdentity(discovery);
        const drift = stackDrift(existing, request.portDocument);
        return drift.length === 0 ? existing : { ...existing, drift };
      });

    const startStack = (
      request: StartStackRequest,
    ): Effect.Effect<
      ManagedStackStartResult,
      ManagedStackManagerError,
      import("effect/Scope").Scope
    > =>
      Effect.gen(function* () {
        const stackName = yield* validateManagedStackName(request.stackName ?? "default");
        const discovery = yield* provideDependencies(ensureEnvironment(request.workspacePath));
        yield* validateOrdinaryWorkspaceIdentity(discovery);
        if (discovery.state === "needsRepair") {
          return yield* Effect.fail(workspaceRepairConflict(discovery.reason));
        }
        const stackId = deriveStackId(discovery.identity, stackName);
        const repairId = deriveRepairOwnershipId(discovery.identity);
        const repairAcquisition = yield* provideDependencies(
          acquireControl({ stackId: repairId }).pipe(
            Effect.flatMap((acquisition) =>
              isOwned(acquisition)
                ? Effect.succeed(acquisition)
                : Effect.fail(
                    new ManagedWorkspaceRepairConflictError({
                      stackId: repairId,
                      reason: "Workspace repair is already owned",
                    }),
                  ),
            ),
            Effect.retry({
              schedule: Schedule.spaced("20 millis").pipe(Schedule.upTo({ times: 250 })),
              while: (error) => error instanceof ManagedWorkspaceRepairConflictError,
            }),
          ),
        );
        return yield* Effect.gen(function* () {
          const refreshed = yield* provideDependencies(ensureEnvironment(request.workspacePath));
          yield* validateOrdinaryWorkspaceIdentity(refreshed);
          if (refreshed.state === "needsRepair") {
            return yield* Effect.fail(workspaceRepairConflict(refreshed.reason));
          }
          const refreshedStackId = deriveStackId(refreshed.identity, stackName);
          if (refreshedStackId !== stackId) {
            return yield* Effect.fail(
              new ManagedWorkspaceRepairConflictError({
                reason: "Workspace identity changed while resolving the stack",
              }),
            );
          }
          yield* requireOwnedForStack(request.ownership, refreshedStackId);
          const existing = yield* store.read(refreshedStackId);
          if (existing?.lifecycle === "deleting") {
            yield* store.remove(refreshedStackId);
          }
          let current = existing?.lifecycle === "deleting" ? undefined : existing;
          if (
            current !== undefined &&
            (current.lifecycle === "running" || current.lifecycle === "starting")
          ) {
            current = { ...current, lifecycle: "failed", updatedAt: now() };
            yield* store.write(current);
          }
          const allocation = yield* allocateManagedPorts(request.ownership, {
            stackId: refreshedStackId,
            portDocument: request.portDocument,
            persisted: current?.ports,
          });
          const timestamp = now();
          const document: ManagedStackDocument = {
            format: "supabase-stack",
            formatVersion: 1,
            id: refreshedStackId,
            identity: { ...refreshed.identity, name: stackName },
            workspace: workspaceDocument(refreshed),
            ports: allocation.assignments,
            lifecycle: request.lifecycle ?? "stopped",
            ...(request.runtime && { runtime: request.runtime }),
            ...((request.launch ?? current?.launch) && {
              launch: request.launch ?? current?.launch,
            }),
            createdAt: current?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          yield* store.write(document);
          return { stack: document, lease: allocation.lease } satisfies ManagedStackStartResult;
        }).pipe(Effect.ensuring(repairAcquisition.close));
      });

    const inspectStack = (
      stackId: string,
    ): Effect.Effect<ManagedStack | undefined, ManagedStackManagerError> => store.read(stackId);

    const listStacks = (): Effect.Effect<
      ReadonlyArray<ManagedStackListing>,
      ManagedStackManagerError
    > => store.list();

    const recordLifecycle = (
      ownership: ControlOwnership,
      update: ManagedStackLifecycleUpdate,
    ): Effect.Effect<ManagedStack, ManagedStackManagerError> =>
      lifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* requireOwnedForStack(ownership, update.stackId);
          const current = yield* store.read(update.stackId);
          if (current === undefined) {
            return yield* Effect.fail(new ManagedStackNotFoundError({ stackId: update.stackId }));
          }
          const ownerState =
            update.lifecycle === "running"
              ? "running"
              : update.lifecycle === "starting"
                ? "starting"
                : update.lifecycle === "deleting"
                  ? "deleting"
                  : update.lifecycle === "failed"
                    ? "failed"
                    : "stopping";
          yield* ownership.setState(ownerState, update.lifecycle === "running");
          let next: ManagedStackDocument = {
            ...current,
            lifecycle: update.lifecycle,
            updatedAt: now(),
          };
          if (
            update.runtime !== undefined ||
            update.lifecycle === "stopped" ||
            update.lifecycle === "failed"
          ) {
            const { runtime: _runtime, ...withoutRuntime } = next;
            next = withoutRuntime;
          }
          if (update.runtime !== undefined && update.runtime !== null) {
            next = { ...next, runtime: update.runtime };
          }
          yield* store.write(next);
          return next;
        }),
      );

    const updateLaunch = (
      ownership: ControlOwnership,
      update: ManagedStackLaunchUpdate,
    ): Effect.Effect<ManagedStack, ManagedStackManagerError> =>
      lifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* requireOwnedForStack(ownership, update.stackId);
          const current = yield* store.read(update.stackId);
          if (current === undefined) {
            return yield* Effect.fail(new ManagedStackNotFoundError({ stackId: update.stackId }));
          }
          const next: ManagedStackDocument = {
            ...current,
            launch: update.launch,
            updatedAt: now(),
          };
          yield* store.write(next);
          return next;
        }),
      );

    const repairWorkspace = (
      request: RepairRequest,
    ): Effect.Effect<WorkspaceDiscovery, ManagedStackManagerError> =>
      Effect.scoped(
        Effect.gen(function* () {
          if (request.reason === "duplicate") {
            return yield* Effect.fail(workspaceRepairConflict("duplicate"));
          }
          const repairId = deriveRepairOwnershipId(request.identity);
          const repairAcquisition = yield* provideDependencies(
            acquireControl({ stackId: repairId }),
          );
          if (!isOwned(repairAcquisition)) {
            return yield* Effect.fail(
              new ManagedWorkspaceRepairConflictError({
                reason: "Workspace repair is already owned",
              }),
            );
          }
          yield* provideDependencies(validateEnvironmentRepair(request));
          const listings = yield* store.list();
          const affected = listings
            .filter(isHealthyDocument)
            .map((listing) => listing.document)
            .filter(
              (document) =>
                document.identity.workspaceId === request.identity.workspaceId &&
                document.identity.checkoutId === request.identity.checkoutId,
            )
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
          const stackOwners: Array<ControlOwnership> = [];
          for (const document of affected) {
            const acquisition = yield* provideDependencies(
              acquireControl({ stackId: document.id }),
            );
            if (!isOwned(acquisition)) {
              return yield* Effect.fail(
                new ManagedWorkspaceRepairConflictError({
                  stackId: document.id,
                  reason: `Managed stack ${document.id} is attached to a live owner`,
                }),
              );
            }
            stackOwners.push(acquisition);
          }
          const revalidated = yield* provideDependencies(validateEnvironmentRepair(request));
          const inspection = yield* provideDependencies(inspectWorkspace(revalidated.path));
          if (inspection.kind !== "git-checkout") {
            return yield* Effect.fail(
              new ManagedWorkspaceRepairConflictError({
                reason: "Repair target is not a Git checkout",
              }),
            );
          }
          const updatedAt = now();
          const checkoutRoot = revalidated.path;
          const updates = affected.map((document) => {
            const projectPath =
              document.identity.localProjectKey === "."
                ? checkoutRoot
                : resolve(checkoutRoot, ...document.identity.localProjectKey.split("/"));
            return { document, projectPath, escaped: relative(checkoutRoot, projectPath) };
          });
          for (const { document, escaped } of updates) {
            if (isAbsolute(escaped) || escaped === ".." || escaped.startsWith("../")) {
              return yield* Effect.fail(
                new ManagedWorkspaceRepairConflictError({
                  stackId: document.id,
                  reason: `Managed stack ${document.id} has an invalid local project key`,
                }),
              );
            }
          }
          for (const { document, projectPath } of updates) {
            const stale = document.lifecycle === "running" || document.lifecycle === "starting";
            const { runtime: _runtime, ...withoutRuntime } = document;
            yield* store.write({
              ...withoutRuntime,
              ...(stale ? { lifecycle: "failed" as const } : {}),
              workspace: { ...document.workspace, path: projectPath },
              updatedAt,
            });
          }
          yield* updateGitCheckoutLocationOwned(
            inspection.gitDirectory,
            revalidated.expectedPath,
            revalidated.path,
            repairAcquisition,
          );
          return yield* provideDependencies(discoverEnvironment(revalidated.path));
        }),
      );

    const deleteStack = (
      stackId: string,
      ownedBy: ControlOwnership,
    ): Effect.Effect<ManagedDeleteResult, ManagedStackManagerError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const acquisition = ownedBy;
          yield* requireOwnedForStack(acquisition, stackId);
          const current = yield* store.read(stackId).pipe(
            Effect.catchTag("InvalidManagedStackDocumentError", () =>
              store.remove(stackId).pipe(Effect.as({ outcome: "removed" as const, stackId })),
            ),
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(undefined)
                : store.remove(stackId).pipe(Effect.as({ outcome: "removed" as const, stackId })),
            ),
          );
          if (current === undefined) return { outcome: "already-absent", stackId };
          if ("outcome" in current) return current;
          yield* acquisition.setState("deleting", false);
          yield* dockerForceRemove(
            SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
          );
          const { runtime: _runtime, ...withoutRuntime } = current;
          const deleting = { ...withoutRuntime, lifecycle: "deleting" as const, updatedAt: now() };
          yield* store.write(deleting);
          yield* store.remove(stackId);
          return { outcome: "removed", stackId };
        }),
      );

    return {
      stateRoot: store.stateRoot,
      discoverWorkspace: (path) =>
        Effect.gen(function* () {
          const discovery = yield* provideDependencies(discoverEnvironment(path));
          yield* validateOrdinaryWorkspaceIdentity(discovery);
          return discovery;
        }),
      ensureWorkspace: (path) =>
        Effect.gen(function* () {
          const discovery = yield* provideDependencies(ensureEnvironment(path));
          yield* validateOrdinaryWorkspaceIdentity(discovery);
          return discovery;
        }),
      acquireControl: (stackId) => provideDependencies(acquireControl({ stackId })),
      probeControl: (stackId) => provideDependencies(probeControl(stackId)),
      readStack,
      startStack,
      inspectStack,
      listStacks,
      allocateManagedPorts,
      recordLifecycle,
      updateLaunch,
      repairWorkspace,
      deleteStack,
    } satisfies ManagedStackManagerShape;
  });

/** Internal manager layer. Platform layers provide filesystem, Git, and control transport. */
export const managedStackManagerLayer = (options: {
  readonly stateRoot: string;
}): Layer.Layer<ManagedStackManager, never, ManagerRequirements> =>
  Layer.effect(ManagedStackManager, makeManager(options.stateRoot));

export const makeManagedStackManager = (
  stateRoot: string,
): Effect.Effect<ManagedStackManagerShape, never, ManagerRequirements> => makeManager(stateRoot);
