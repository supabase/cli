import { createHash } from "node:crypto";
import {
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  PlatformError,
  Schedule,
  Scope,
} from "effect";
import type { PortField, PortSet } from "../PortCatalog.ts";
import {
  reservePortSet,
  type PortAllocationError,
  type PortLease,
  type PortReservationRequest,
} from "../PortAllocator.ts";
import {
  acquireControl,
  controlEndpoint,
  ControlTransport,
  type ControlAcquisition,
  type ControlOwnership,
} from "./control.ts";
import {
  discoverEnvironment,
  deriveStackId,
  ensureEnvironment,
  validateEnvironmentRepair,
  type EnvironmentIdentity,
  type RepairRequest,
  type WorkspaceDiscovery,
} from "./environment.ts";
import { GitConfigStore, inspectWorkspace } from "./git.ts";
import { updateGitCheckoutLocationOwned } from "./identity.ts";
import {
  ManagedExactPortOccupiedError,
  ManagedPortAllocationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  type ManagedPortAssignment,
  type ManagedPortDrift,
  type ManagedPortIntentDocument,
} from "./model.ts";
import {
  managedPortReservationsConflict,
  planManagedPorts,
  type ManagedPortPlan,
} from "./port-plan.ts";
import { resolvePortIntents } from "./port-intent.ts";
import { makeStackStore, type ManagedStackListing } from "./store.ts";
import type { ManagedStackDocument } from "./document.ts";

/** A document joined with a transient drift report for read-only callers. */
export interface ManagedStack extends ManagedStackDocument {
  readonly drift?: ReadonlyArray<ManagedPortDrift>;
}

export interface ResolveStackStatusRequest {
  readonly operation: "status";
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
}

export interface ResolveStackStartRequest {
  readonly operation: "start";
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
  /** The supervisor-owned lifecycle capability for this deterministic stack. */
  readonly ownership: ControlOwnership;
  readonly lifecycle?: ManagedStackDocument["lifecycle"];
  readonly runtime?: ManagedStackDocument["runtime"];
  readonly launch?: ManagedStackDocument["launch"];
}

export type ResolveStackRequest = ResolveStackStatusRequest | ResolveStackStartRequest;

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

/** A Promise-facade allocation whose port bindings remain live until disposal. */
export interface ManagedStackAllocationHandle extends AsyncDisposable {
  readonly stack: ManagedStack;
  readonly ports: PortSet;
  readonly release: (fields: ReadonlyArray<PortField>) => Promise<void>;
  readonly releaseAll: () => Promise<void>;
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
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export type ManagedStackManagerError =
  | ManagedStackControlRequiredError
  | ManagedStackAttachedError
  | ManagedWorkspaceRepairConflictError
  | ManagedStackNotFoundError
  | ManagedStackNotStoppedError
  | ManagedRunningStackPortChangeError
  | ManagedExactPortOccupiedError
  | ManagedPortAllocationError
  | PlatformError.PlatformError
  | import("./document.ts").InvalidManagedStackDocumentError
  | import("./model.ts").InvalidManagedIdentityError
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
  readonly resolveStack: {
    (
      request: ResolveStackStatusRequest,
    ): Effect.Effect<ManagedStack | undefined, ManagedStackManagerError>;
    (
      request: ResolveStackStartRequest,
    ): Effect.Effect<
      ManagedStackStartResult,
      ManagedStackManagerError,
      import("effect/Scope").Scope
    >;
  };
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
    ...lengthPrefixed(identity.projectId),
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
      return [
        {
          key: request.key,
          actualIntent: "automatic",
          actualPort: -1,
          configuredIntent: request.intent,
          ...(request.intent === "exact" ? { configuredPort: request.port } : {}),
        } satisfies ManagedPortDrift,
      ];
    }
    const configuredPort = request.intent === "exact" ? request.port : actual.port;
    return actual.intent === request.intent && actual.port === configuredPort
      ? []
      : [
          {
            key: request.key,
            actualIntent: actual.intent,
            actualPort: actual.port,
            configuredIntent: request.intent,
            ...(request.intent === "exact" ? { configuredPort: request.port } : {}),
          } satisfies ManagedPortDrift,
        ];
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
  Effect.gen(function* () {
    const endpoint = yield* controlEndpoint(stackId).pipe(
      Effect.mapError(() => new ManagedStackControlRequiredError({ stackId })),
    );
    if (ownership.ownershipId !== stackId || ownership.endpoint.url !== endpoint.url) {
      return yield* Effect.fail(new ManagedStackControlRequiredError({ stackId }));
    }
  });

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
          const strictReserved = new Set<number>();
          const owners = new Map<
            number,
            ReadonlyArray<{
              readonly document: ManagedStackDocument;
              readonly assignment: ManagedPortAssignment;
            }>
          >();
          for (const listing of listings.filter(isHealthyDocument)) {
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
              : yield* reservePortSet(exactRequests, { reserved: strictReserved }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedPortAllocationError({
                        fields: exactRequests.map((item) => item.field),
                        cause,
                      }),
                  ),
                );
          if (exactLease !== undefined) partialLeases.push(exactLease);
          const automaticReserved = new Set(strictReserved);
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
                  exactLease?.reserve(fields) ?? Effect.void,
                  automaticLease?.reserve(fields) ?? Effect.void,
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

    function resolveStack(
      request: ResolveStackStatusRequest,
    ): Effect.Effect<ManagedStack | undefined, ManagedStackManagerError>;
    function resolveStack(
      request: ResolveStackStartRequest,
    ): Effect.Effect<
      ManagedStackStartResult,
      ManagedStackManagerError,
      import("effect/Scope").Scope
    >;
    function resolveStack(
      request: ResolveStackRequest,
    ): Effect.Effect<
      ManagedStack | undefined | ManagedStackStartResult,
      ManagedStackManagerError,
      import("effect/Scope").Scope
    > {
      return Effect.gen(function* () {
        const discovery = yield* provideDependencies(
          request.operation === "start"
            ? ensureEnvironment(request.workspacePath)
            : discoverEnvironment(request.workspacePath),
        );
        if (discovery.state === "needsRepair") {
          return yield* Effect.fail(
            new ManagedWorkspaceRepairConflictError({ reason: "Workspace repair is required" }),
          );
        }
        const stackName = request.stackName ?? "default";
        if (request.operation === "status") {
          const stackId = deriveStackId(discovery.identity, stackName);
          const existing = yield* store.read(stackId);
          if (existing === undefined) return undefined;
          const drift = stackDrift(existing, request.portDocument);
          return drift.length === 0 ? existing : { ...existing, drift };
        }
        const stackId = deriveStackId(discovery.identity, stackName);
        const repairAcquisition = yield* provideDependencies(
          acquireControl({ stackId: deriveRepairOwnershipId(discovery.identity) }),
        );
        if (!isOwned(repairAcquisition)) {
          return yield* Effect.fail(
            new ManagedWorkspaceRepairConflictError({
              stackId: deriveRepairOwnershipId(discovery.identity),
              reason: "Workspace repair is already owned",
            }),
          );
        }
        return yield* Effect.gen(function* () {
          const refreshed = yield* provideDependencies(ensureEnvironment(request.workspacePath));
          if (refreshed.state === "needsRepair") {
            return yield* Effect.fail(
              new ManagedWorkspaceRepairConflictError({ reason: "Workspace repair is required" }),
            );
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
    }

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
      });

    const updateLaunch = (
      ownership: ControlOwnership,
      update: ManagedStackLaunchUpdate,
    ): Effect.Effect<ManagedStack, ManagedStackManagerError> =>
      Effect.gen(function* () {
        yield* requireOwnedForStack(ownership, update.stackId);
        const current = yield* store.read(update.stackId);
        if (current === undefined) {
          return yield* Effect.fail(new ManagedStackNotFoundError({ stackId: update.stackId }));
        }
        const next: ManagedStackDocument = { ...current, launch: update.launch, updatedAt: now() };
        yield* store.write(next);
        return next;
      });

    const repairWorkspace = (
      request: RepairRequest,
    ): Effect.Effect<WorkspaceDiscovery, ManagedStackManagerError> =>
      Effect.scoped(
        Effect.gen(function* () {
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
                document.identity.projectId === request.identity.projectId &&
                document.identity.checkoutId === request.identity.checkoutId,
            )
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
          const stackOwners: Array<ControlOwnership> = [];
          for (const document of affected) {
            if (document.lifecycle !== "stopped" && document.lifecycle !== "failed") {
              return yield* Effect.fail(
                new ManagedWorkspaceRepairConflictError({
                  stackId: document.id,
                  reason: `Managed stack ${document.id} is live and cannot be repaired`,
                }),
              );
            }
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
          for (const document of affected) {
            yield* store.write({
              ...document,
              workspace: { ...document.workspace, path: revalidated.path },
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
          if (!isOwned(acquisition)) {
            return yield* Effect.fail(new ManagedStackAttachedError({ stackId }));
          }
          const current = yield* store.read(stackId);
          if (current === undefined) return { outcome: "already-absent", stackId };
          if (current.lifecycle === "running" || current.lifecycle === "starting") {
            return yield* Effect.fail(new ManagedStackNotStoppedError({ stackId }));
          }
          const deleting = { ...current, lifecycle: "deleting" as const, updatedAt: now() };
          yield* store.write(deleting);
          yield* store.remove(stackId);
          return { outcome: "removed", stackId };
        }),
      );

    return {
      stateRoot: store.stateRoot,
      discoverWorkspace: (path) => provideDependencies(discoverEnvironment(path)),
      ensureWorkspace: (path) => provideDependencies(ensureEnvironment(path)),
      acquireControl: (stackId) => provideDependencies(acquireControl({ stackId })),
      resolveStack,
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

/** Minimal Promise facade over the same Effect manager service. */
export interface ManagedStackManagerHandle extends AsyncDisposable {
  readonly stateRoot: string;
  readonly discoverWorkspace: (path: string) => Promise<WorkspaceDiscovery>;
  readonly ensureWorkspace: (path: string) => Promise<WorkspaceDiscovery>;
  readonly resolveStack: {
    (request: ResolveStackStatusRequest): Promise<ManagedStack | undefined>;
    (request: ResolveStackStartRequest): Promise<ManagedStackAllocationHandle>;
  };
  readonly inspectStack: (stackId: string) => Promise<ManagedStack | undefined>;
  readonly listStacks: () => Promise<ReadonlyArray<ManagedStackListing>>;
  readonly recordLifecycle: (
    ownership: ControlOwnership,
    update: ManagedStackLifecycleUpdate,
  ) => Promise<ManagedStack>;
  readonly updateLaunch: (
    ownership: ControlOwnership,
    update: ManagedStackLaunchUpdate,
  ) => Promise<ManagedStack>;
  readonly repairWorkspace: (request: RepairRequest) => Promise<WorkspaceDiscovery>;
  readonly deleteStack: (stackId: string) => Promise<ManagedDeleteResult>;
}

export const createManagedStackManager = async (
  layer: Layer.Layer<ManagedStackManager, never, never>,
): Promise<ManagedStackManagerHandle> => {
  const runtime = ManagedRuntime.make(layer);
  const context = await runtime.context();
  const manager = Context.get(context, ManagedStackManager);
  const close = (): Promise<void> => runtime.dispose();
  async function resolveStack(
    request: ResolveStackStatusRequest,
  ): Promise<ManagedStack | undefined>;
  async function resolveStack(
    request: ResolveStackStartRequest,
  ): Promise<ManagedStackAllocationHandle>;
  async function resolveStack(
    request: ResolveStackRequest,
  ): Promise<ManagedStack | undefined | ManagedStackAllocationHandle> {
    if (request.operation === "status") {
      return runtime.runPromise(manager.resolveStack(request));
    }
    const scope = await runtime.runPromise(Scope.make());
    try {
      const result = await runtime.runPromise(
        manager.resolveStack(request).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      let released: Promise<void> | undefined;
      const closeAllocation = (): Promise<void> => {
        released ??= runtime.runPromise(Scope.close(scope, Exit.void));
        return released;
      };
      return {
        stack: result.stack,
        ports: result.lease.ports,
        release: (fields) => runtime.runPromise(result.lease.release(fields)),
        releaseAll: closeAllocation,
        [Symbol.asyncDispose]: closeAllocation,
      };
    } catch (error) {
      await runtime.runPromise(Scope.close(scope, Exit.die(error)));
      throw error;
    }
  }
  return {
    stateRoot: manager.stateRoot,
    discoverWorkspace: (path) => runtime.runPromise(manager.discoverWorkspace(path)),
    ensureWorkspace: (path) => runtime.runPromise(manager.ensureWorkspace(path)),
    resolveStack,
    inspectStack: (stackId) => runtime.runPromise(manager.inspectStack(stackId)),
    listStacks: () => runtime.runPromise(manager.listStacks()),
    recordLifecycle: (ownership, update) =>
      runtime.runPromise(manager.recordLifecycle(ownership, update)),
    updateLaunch: (ownership, update) =>
      runtime.runPromise(manager.updateLaunch(ownership, update)),
    repairWorkspace: (request) => runtime.runPromise(manager.repairWorkspace(request)),
    deleteStack: (stackId) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const acquisition = yield* manager.acquireControl(stackId);
            if (!isOwned(acquisition)) {
              return yield* Effect.fail(new ManagedStackAttachedError({ stackId }));
            }
            return yield* manager.deleteStack(stackId, acquisition);
          }),
        ),
      ),
    [Symbol.asyncDispose]: close,
  };
};
