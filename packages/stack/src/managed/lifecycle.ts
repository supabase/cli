import { Data, Effect, Layer, Schedule } from "effect";
import { NoRunningStackError } from "./model.ts";
import { RemoteStack, updateRemoteLaunch } from "../RemoteStack.ts";
import { Stack } from "../Stack.ts";
import { dockerForceRemove } from "../cleanup.ts";
import { dockerContainerName } from "../StackIdentity.ts";
import { SERVICE_NAMES } from "../ServiceCatalog.ts";
import { HttpTransportClient, HttpTransportClientError } from "../HttpTransportClient.ts";
import type { ManagedStackDocument, ManagedStackLaunchUpdate } from "./document.ts";
import {
  ManagedStackAttachedError,
  ManagedStackManager,
  ManagedWorkspaceRepairConflictError,
  workspaceRepairConflict,
  type ManagedStackManagerError,
  type ManagedStackLaunchUpdateRequest,
} from "./manager.ts";
import { acquireControl, ControlTransport, isControlOwnership } from "./control.ts";
import { isControlSupervisorStatus } from "../DaemonProtocol.ts";
import {
  DaemonUpgradeRequired,
  StackBuildError,
  StackRpcProtocolError,
  StackRpcTransportError,
  StackUnavailableError,
} from "../errors.ts";
import {
  ManagedStackNotStoppedError,
  type ManagedPortIntentDocument,
  validateManagedStackName,
} from "./model.ts";
import { deriveStackId } from "./environment.ts";

/** Inputs shared by all managed lifecycle operations. */
export interface ManagedLifecycleInput {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly cwd?: string;
  readonly portDocument?: ManagedPortIntentDocument;
  readonly cliVersion?: string;
}

const emptyPortDocument = (): ManagedPortIntentDocument => ({
  activeFields: [],
  document: {},
});

const noRunningStack = (input: ManagedLifecycleInput): NoRunningStackError =>
  new NoRunningStackError({ cwd: input.cwd ?? input.workspacePath });

const stackIdForInput = (
  manager: import("./manager.ts").ManagedStackManagerShape,
  input: ManagedLifecycleInput,
): Effect.Effect<string, ManagedStackManagerError> =>
  Effect.gen(function* () {
    const stackName = yield* validateManagedStackName(input.stackName ?? "default");
    const discovery = yield* manager.discoverWorkspace(input.workspacePath);
    if (discovery.state === "needsRepair") {
      return yield* workspaceRepairConflict(discovery.reason);
    }
    return deriveStackId(discovery.identity, stackName);
  });

/** Resolve one document through the managed manager and Git workspace identity. */
export const resolveManagedDocument = (
  input: ManagedLifecycleInput,
): Effect.Effect<
  ManagedStackDocument,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager
> =>
  Effect.gen(function* () {
    const manager = yield* ManagedStackManager;
    const document = yield* manager.readStack({
      workspacePath: input.workspacePath,
      ...(input.stackName === undefined ? {} : { stackName: input.stackName }),
      portDocument: input.portDocument ?? emptyPortDocument(),
    });
    return document === undefined ? yield* noRunningStack(input) : document;
  });

class ManagedStopPending extends Data.TaggedError("ManagedStopPending")<{}> {}
class ManagedDeletePending extends Data.TaggedError("ManagedDeletePending")<{}> {}

/** Connect to the control endpoint the managed supervisor actually bound. */
export const connectManagedStack = (
  input: ManagedLifecycleInput & { readonly cliVersion: string },
): Effect.Effect<
  Layer.Layer<Stack, DaemonUpgradeRequired | StackRpcProtocolError | StackRpcTransportError>,
  NoRunningStackError | ManagedStackManagerError | DaemonUpgradeRequired,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.gen(function* () {
    const document = yield* resolveManagedDocument(input);
    if (
      (document.lifecycle !== "running" && document.lifecycle !== "starting") ||
      (document.lifecycle === "running" && document.runtime?.controlEndpoint === undefined)
    ) {
      return yield* noRunningStack(input);
    }
    const manager = yield* ManagedStackManager;
    const probe = yield* manager.probeControl(document.id);
    if (probe === undefined) {
      return yield* noRunningStack(input);
    }
    if (!isControlSupervisorStatus(probe.status)) {
      return yield* new ManagedStackAttachedError({ stackId: document.id });
    }
    if (probe.status.daemonCliVersion !== input.cliVersion) {
      return yield* new DaemonUpgradeRequired({
        stackId: document.id,
        oldCliVersion: probe.status.daemonCliVersion,
        newCliVersion: input.cliVersion,
        state: probe.status.state,
        ready: probe.status.ready,
      });
    }
    if (probe.status.state !== "running" || !probe.status.ready) {
      return yield* noRunningStack(input);
    }
    const client = yield* HttpTransportClient;
    return RemoteStack.layer(probe.endpoint, {
      cliVersion: input.cliVersion,
      owner: {
        ownershipId: probe.status.ownershipId,
        ownerSessionId: probe.status.ownerSessionId,
        controlProtocolVersion: probe.status.controlProtocolVersion,
        daemonCliVersion: probe.status.daemonCliVersion,
      },
    }).pipe(Layer.provide(Layer.succeed(HttpTransportClient, client)));
  });

/** Ask the owner to stop; the supervisor clears runtime state before exiting. */
export const stopManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<
  void,
  NoRunningStackError | ManagedStackManagerError | import("../errors.ts").StopTimeout,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* ManagedStackManager;
      const document = yield* resolveManagedDocument(input);
      const stackId = document.id;
      const revalidatedStackId = yield* stackIdForInput(manager, input);
      if (revalidatedStackId !== stackId) {
        return yield* new ManagedWorkspaceRepairConflictError({
          reason: "Workspace identity changed before stop",
        });
      }
      const cleanupOwned = (owned: import("./control.ts").ControlOwnership) =>
        Effect.ensuring(
          Effect.gen(function* () {
            const current = yield* manager.inspectStack(stackId);
            const containerRuntime =
              current?.launch.mode === "docker" ? current.launch.containerRuntime : null;
            if (containerRuntime !== null) {
              yield* dockerForceRemove(
                containerRuntime,
                SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
              );
            }
            if (
              current !== undefined &&
              current.lifecycle !== "deleting" &&
              (current.lifecycle !== "stopped" || current.stopIntent !== "explicit")
            ) {
              yield* manager.recordLifecycle(owned, {
                stackId,
                lifecycle: "stopped",
                stopIntent: "explicit",
              });
            }
          }),
          owned.close,
        );

      /**
       * Stop the exact session currently observed, then probe again. A new
       * supervisor can bind immediately after the old session disappears; a
       * public identity-scoped stop must follow and fence that successor
       * rather than returning with a running document.
       */
      const stopCurrentOwner = Effect.gen(function* () {
        const current = yield* manager.inspectStack(stackId);
        if (current === undefined) return;
        const acquisition = yield* manager.acquireControl(stackId, "stop");
        const currentStackId = yield* stackIdForInput(manager, input);
        if (currentStackId !== stackId) {
          return yield* new ManagedWorkspaceRepairConflictError({
            reason: "Workspace identity changed while stopping",
          });
        }
        if (isControlOwnership(acquisition)) {
          yield* cleanupOwned(acquisition);
          return;
        }
        yield* acquisition.requestStop.pipe(
          Effect.catchTag("ControlMaintenanceBusyError", () =>
            Effect.fail(new ManagedStackAttachedError({ stackId })),
          ),
        );
        return yield* new ManagedStopPending();
      }).pipe(
        Effect.retry({
          schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
          while: (error) => error instanceof ManagedStopPending,
        }),
        Effect.catchTag("ManagedStopPending", () =>
          Effect.fail(new ManagedStackNotStoppedError({ stackId })),
        ),
      );
      yield* stopCurrentOwner;
    }),
  );

/** Remove a stopped document while holding its deterministic control owner. */
export const deleteManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<
  void,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager | ControlTransport
> =>
  Effect.gen(function* () {
    const manager = yield* ManagedStackManager;
    const stackId = yield* stackIdForInput(manager, input);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const acquisition = yield* acquireControl({
          stackId,
          maintenanceOperation: "delete",
        }).pipe(
          Effect.flatMap((candidate) =>
            isControlOwnership(candidate)
              ? Effect.succeed(candidate)
              : Effect.fail(new ManagedDeletePending()),
          ),
          Effect.retry(
            Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
          ),
          Effect.mapError(() => new ManagedStackAttachedError({ stackId })),
        );
        const result = yield* Effect.gen(function* () {
          const revalidatedStackId = yield* stackIdForInput(manager, input);
          if (revalidatedStackId !== stackId) {
            return yield* new ManagedWorkspaceRepairConflictError({
              reason: "Workspace identity changed before delete",
            });
          }
          return yield* manager.deleteStack(stackId, acquisition);
        }).pipe(Effect.ensuring(acquisition.close));
        if (result.outcome === "already-absent") return yield* noRunningStack(input);
      }),
    );
  });

/** Persist launch selections in the managed document, owner-gated. */
export const updateManagedLaunch = (
  input: ManagedLifecycleInput & {
    readonly launch: ManagedStackLaunchUpdate;
    readonly cliVersion: string;
  },
): Effect.Effect<
  ManagedStackDocument,
  | NoRunningStackError
  | ManagedStackManagerError
  | HttpTransportClientError
  | DaemonUpgradeRequired
  | StackBuildError
  | StackUnavailableError
  | StackRpcProtocolError
  | StackRpcTransportError,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const document = yield* resolveManagedDocument(input);
      const manager = yield* ManagedStackManager;
      const acquisition = yield* manager.acquireControl(document.id, "update");
      if (!isControlOwnership(acquisition)) {
        if (document.lifecycle !== "running" || document.runtime?.controlEndpoint === undefined) {
          return yield* new ManagedStackAttachedError({ stackId: document.id });
        }
        const status = yield* acquisition.ownerStatus;
        if (!isControlSupervisorStatus(status)) {
          return yield* new ManagedStackAttachedError({ stackId: document.id });
        }
        yield* updateRemoteLaunch(
          acquisition.endpoint,
          {
            cliVersion: input.cliVersion,
            owner: {
              ownershipId: status.ownershipId,
              ownerSessionId: status.ownerSessionId,
              controlProtocolVersion: status.controlProtocolVersion,
              daemonCliVersion: status.daemonCliVersion,
            },
          },
          document.id,
          input.launch,
        );
        const next = yield* manager.inspectStack(document.id);
        if (next === undefined) return yield* noRunningStack(input);
        return next;
      }
      const update: ManagedStackLaunchUpdateRequest = {
        stackId: document.id,
        launch: input.launch,
      };
      return yield* Effect.ensuring(manager.updateLaunch(acquisition, update), acquisition.close);
    }),
  );
