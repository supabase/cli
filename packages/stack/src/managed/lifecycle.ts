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
import {
  makeSupervisorControlApplication,
  makeSupervisorControlMiddleware,
} from "../SupervisorControlServer.ts";
import { SupervisorLifecycle } from "../SupervisorLifecycle.ts";
import {
  DaemonUpgradeRequired,
  StackBuildError,
  StackRpcProtocolError,
  StackRpcTransportError,
} from "../errors.ts";
import {
  ManagedStackNotStoppedError,
  type ManagedPortIntentDocument,
  validateManagedStackName,
} from "./model.ts";
import { deriveStackId } from "./environment.ts";
import type { BuildIdentityValue } from "../BuildIdentity.ts";

/** Inputs shared by all managed lifecycle operations. */
export interface ManagedLifecycleInput {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly cwd?: string;
  readonly portDocument?: ManagedPortIntentDocument;
  readonly buildIdentity?: BuildIdentityValue;
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
      return yield* Effect.fail(workspaceRepairConflict(discovery.reason));
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
    return document === undefined ? yield* Effect.fail(noRunningStack(input)) : document;
  });

class ManagedStopPending extends Data.TaggedError("ManagedStopPending")<{}> {}
class ManagedDeletePending extends Data.TaggedError("ManagedDeletePending")<{}> {}

/** Connect to the control endpoint the managed supervisor actually bound. */
export const connectManagedStack = (
  input: ManagedLifecycleInput & { readonly buildIdentity: BuildIdentityValue },
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
      return yield* Effect.fail(noRunningStack(input));
    }
    const manager = yield* ManagedStackManager;
    const probe = yield* manager.probeControl(document.id);
    if (probe === undefined || probe.status.state !== "running" || !probe.status.ready) {
      return yield* Effect.fail(noRunningStack(input));
    }
    const client = yield* HttpTransportClient;
    return RemoteStack.layer(probe.endpoint, {
      buildIdentity: input.buildIdentity,
      owner: {
        ownershipId: probe.status.ownershipId,
        ownerSessionId: probe.status.ownerSessionId,
        controlProtocolVersion: probe.status.controlProtocolVersion,
        daemonCliVersion: probe.status.daemonCliVersion,
        daemonBuildId: probe.status.daemonBuildId,
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
        return yield* Effect.fail(
          new ManagedWorkspaceRepairConflictError({
            reason: "Workspace identity changed before stop",
          }),
        );
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
       * public identity-scoped stop must follow and fence that replacement
       * rather than returning with a running document.
       */
      const stopCurrentOwner = Effect.gen(function* () {
        const current = yield* manager.inspectStack(stackId);
        if (current === undefined) return;
        const acquisition = yield* manager.acquireControl(stackId);
        const currentStackId = yield* stackIdForInput(manager, input);
        if (currentStackId !== stackId) {
          return yield* Effect.fail(
            new ManagedWorkspaceRepairConflictError({
              reason: "Workspace identity changed while stopping",
            }),
          );
        }
        if (isControlOwnership(acquisition)) {
          yield* cleanupOwned(acquisition);
          return;
        }
        yield* acquisition.requestStop;
        return yield* Effect.fail(new ManagedStopPending());
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
        const lifecycle = yield* SupervisorLifecycle.make({
          ownershipId: stackId,
          ownerSessionId: crypto.randomUUID(),
          daemonCliVersion: "managed",
          daemonBuildId: "managed",
        });
        const application = {
          app: yield* makeSupervisorControlApplication(lifecycle),
          middleware: makeSupervisorControlMiddleware(lifecycle),
        };
        const acquisition = yield* acquireControl({
          stackId,
          initialStatus: yield* lifecycle.currentStatus,
          application,
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
        const revalidatedStackId = yield* stackIdForInput(manager, input);
        if (revalidatedStackId !== stackId) {
          return yield* Effect.fail(
            new ManagedWorkspaceRepairConflictError({
              reason: "Workspace identity changed before delete",
            }),
          );
        }
        yield* lifecycle.setClose(acquisition.close);
        yield* lifecycle.beginDeleting;
        const result = yield* manager
          .deleteStack(stackId, acquisition)
          .pipe(Effect.ensuring(lifecycle.requestShutdown("dispose").pipe(Effect.ignore)));
        if (result.outcome === "already-absent") return yield* Effect.fail(noRunningStack(input));
      }),
    );
  });

/** Persist launch selections in the managed document, owner-gated. */
export const updateManagedLaunch = (
  input: ManagedLifecycleInput & {
    readonly launch: ManagedStackLaunchUpdate;
    readonly buildIdentity: BuildIdentityValue;
  },
): Effect.Effect<
  ManagedStackDocument,
  | NoRunningStackError
  | ManagedStackManagerError
  | HttpTransportClientError
  | DaemonUpgradeRequired
  | StackBuildError
  | StackRpcProtocolError
  | StackRpcTransportError,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const document = yield* resolveManagedDocument(input);
      const manager = yield* ManagedStackManager;
      const acquisition = yield* manager.acquireControl(document.id);
      if (!isControlOwnership(acquisition)) {
        if (document.lifecycle !== "running" || document.runtime?.controlEndpoint === undefined) {
          return yield* Effect.fail(new ManagedStackAttachedError({ stackId: document.id }));
        }
        const status = yield* acquisition.ownerStatus;
        yield* updateRemoteLaunch(
          acquisition.endpoint,
          {
            buildIdentity: input.buildIdentity,
            owner: {
              ownershipId: status.ownershipId,
              ownerSessionId: status.ownerSessionId,
              controlProtocolVersion: status.controlProtocolVersion,
              daemonCliVersion: status.daemonCliVersion,
              daemonBuildId: status.daemonBuildId,
            },
          },
          document.id,
          input.launch,
        );
        const next = yield* manager.inspectStack(document.id);
        if (next === undefined) return yield* Effect.fail(noRunningStack(input));
        return next;
      }
      const update: ManagedStackLaunchUpdateRequest = {
        stackId: document.id,
        launch: input.launch,
      };
      return yield* Effect.ensuring(manager.updateLaunch(acquisition, update), acquisition.close);
    }),
  );
