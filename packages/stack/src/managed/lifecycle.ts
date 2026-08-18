import { Data, Effect, Layer, Schedule } from "effect";
import { NoRunningStackError } from "./model.ts";
import { RemoteStack } from "../RemoteStack.ts";
import { Stack } from "../Stack.ts";
import { dockerForceRemove } from "../cleanup.ts";
import { dockerContainerName } from "../StackIdentity.ts";
import { SERVICE_NAMES } from "../ServiceCatalog.ts";
import { HttpTransportClient, HttpTransportClientError } from "../HttpTransportClient.ts";
import type { ManagedStackDocument, ManagedStackLaunchUpdate } from "./document.ts";
import {
  ManagedStackAttachedError,
  ManagedStackControlRequiredError,
  ManagedStackManager,
  workspaceRepairConflict,
  type ManagedStackManagerError,
  type ManagedStackLaunchUpdateRequest,
} from "./manager.ts";
import { ControlTransportError, controlEndpoint, type ControlEndpoint } from "./control.ts";
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

const runtimeEndpoint = (
  document: ManagedStackDocument,
  input: ManagedLifecycleInput,
): Effect.Effect<ControlEndpoint, NoRunningStackError | ManagedStackControlRequiredError> =>
  Effect.gen(function* () {
    if (
      (document.lifecycle !== "running" && document.lifecycle !== "starting") ||
      (document.lifecycle === "running" && document.runtime?.controlEndpoint === undefined)
    ) {
      return yield* Effect.fail(noRunningStack(input));
    }
    const endpoint = yield* controlEndpoint(document.id).pipe(
      Effect.mapError(() => new ManagedStackControlRequiredError({ stackId: document.id })),
    );
    return endpoint;
  });

class ManagedStopPending extends Data.TaggedError("ManagedStopPending")<{}> {}
class ManagedStopOwnerTerminal extends Data.TaggedError("ManagedStopOwnerTerminal")<{}> {}
class ManagedDeletePending extends Data.TaggedError("ManagedDeletePending")<{}> {}

/** Connect to the deterministic endpoint persisted by the managed supervisor. */
export const connectManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<
  Layer.Layer<Stack>,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.gen(function* () {
    const document = yield* resolveManagedDocument(input);
    const manager = yield* ManagedStackManager;
    const status = yield* manager.probeControl(document.id);
    if (status?.state !== "running" || !status.ready) {
      return yield* Effect.fail(noRunningStack(input));
    }
    const endpoint = yield* runtimeEndpoint(document, input);
    const client = yield* HttpTransportClient;
    return RemoteStack.layer(endpoint).pipe(
      Layer.provide(Layer.succeed(HttpTransportClient, client)),
    );
  });

/** Ask the owner to stop; the supervisor clears runtime state before exiting. */
export const stopManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<
  void,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* ManagedStackManager;
      const document = yield* resolveManagedDocument(input);
      const stackId = document.id;
      const containerRuntime =
        document.launch?.mode === "docker" ? (document.launch.containerRuntime ?? "docker") : null;
      const acquisition = yield* manager.acquireControl(stackId);
      if (acquisition._tag === "Owned") {
        if (
          document.lifecycle === "running" ||
          document.lifecycle === "starting" ||
          document.lifecycle === "failed"
        ) {
          if (containerRuntime !== null) {
            yield* dockerForceRemove(
              containerRuntime,
              SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
            );
          }
          yield* manager.recordLifecycle(acquisition, { stackId, lifecycle: "stopped" });
        }
        yield* acquisition.close;
        return;
      }
      if (document.lifecycle !== "running" && document.lifecycle !== "starting") {
        return yield* Effect.fail(new ManagedStackAttachedError({ stackId }));
      }
      const client = yield* HttpTransportClient;
      const cleanupOwned = (owned: import("./control.ts").ControlOwnership) =>
        Effect.ensuring(
          Effect.gen(function* () {
            if (containerRuntime !== null) {
              yield* dockerForceRemove(
                containerRuntime,
                SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
              );
            }
            yield* manager.recordLifecycle(owned, { stackId, lifecycle: "stopped" });
          }),
          owned.close,
        );
      let stopRequested = false;
      const awaitOwnerReady: Effect.Effect<
        "ready",
        | ManagedStopPending
        | ManagedStopOwnerTerminal
        | ControlTransportError
        | import("./control.ts").ControlProtocolError
        | import("./control.ts").ControlProtocolMismatchError
        | import("./control.ts").ControlAddressConflictError
      > = acquisition.ownerStatus.pipe(
        Effect.flatMap(
          (
            status,
          ): Effect.Effect<
            "ready",
            | ManagedStopPending
            | ManagedStopOwnerTerminal
            | ControlTransportError
            | import("./control.ts").ControlProtocolError
            | import("./control.ts").ControlProtocolMismatchError
            | import("./control.ts").ControlAddressConflictError
          > => {
            if (status.state === "running" && status.ready) return Effect.succeed<"ready">("ready");
            if (status.state === "starting") {
              return Effect.gen(function* () {
                if (!stopRequested) {
                  stopRequested = true;
                  yield* acquisition.requestStop;
                }
                return yield* Effect.fail(new ManagedStopPending());
              });
            }
            if (status.state === "stopping") {
              return Effect.fail(new ManagedStopPending());
            }
            return Effect.fail(new ManagedStopOwnerTerminal());
          },
        ),
        Effect.retry({
          schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
          while: (error) => error instanceof ManagedStopPending,
        }),
      );
      const ready = yield* awaitOwnerReady.pipe(
        Effect.catchTag("ManagedStopOwnerTerminal", () =>
          Effect.fail(new ManagedStackAttachedError({ stackId })),
        ),
        Effect.catch((error) =>
          error instanceof ControlTransportError && error.reason === "unreachable"
            ? Effect.succeed<"dead">("dead")
            : Effect.fail(error),
        ),
        Effect.mapError(() => new ManagedStackNotStoppedError({ stackId })),
      );
      if (ready === "dead") {
        const released = yield* manager.acquireControl(stackId).pipe(
          Effect.flatMap((candidate) =>
            candidate._tag === "Owned"
              ? Effect.succeed(candidate)
              : Effect.fail(new ManagedStopPending()),
          ),
          Effect.retry(
            Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
          ),
          Effect.mapError(() => new ManagedStackNotStoppedError({ stackId })),
        );
        yield* cleanupOwned(released);
        return;
      }
      const layer = RemoteStack.layer(acquisition.endpoint).pipe(
        Layer.provide(Layer.succeed(HttpTransportClient, client)),
      );
      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.stop();
      }).pipe(Effect.provide(layer));
      yield* manager.inspectStack(stackId).pipe(
        Effect.flatMap((current) =>
          current?.lifecycle === "stopped"
            ? Effect.succeed(current)
            : Effect.fail(new ManagedStopPending()),
        ),
        Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
        Effect.mapError(() => new ManagedStackNotStoppedError({ stackId })),
      );
      const released = yield* manager.acquireControl(stackId).pipe(
        Effect.flatMap((candidate) =>
          candidate._tag === "Owned"
            ? Effect.succeed(candidate)
            : Effect.fail(new ManagedStopPending()),
        ),
        Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
        Effect.mapError(() => new ManagedStackNotStoppedError({ stackId })),
      );
      yield* released.close;
    }),
  );

/** Remove a stopped document while holding its deterministic control owner. */
export const deleteManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<void, NoRunningStackError | ManagedStackManagerError, ManagedStackManager> =>
  Effect.gen(function* () {
    const manager = yield* ManagedStackManager;
    const stackId = yield* stackIdForInput(manager, input);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const acquisition = yield* manager.acquireControl(stackId).pipe(
          Effect.flatMap((candidate) =>
            candidate._tag === "Owned"
              ? Effect.succeed(candidate)
              : Effect.fail(new ManagedDeletePending()),
          ),
          Effect.retry(
            Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
          ),
          Effect.mapError(() => new ManagedStackAttachedError({ stackId })),
        );
        const result = yield* manager.deleteStack(stackId, acquisition);
        if (result.outcome === "already-absent") return yield* Effect.fail(noRunningStack(input));
      }),
    );
  });

/** Persist launch selections in the managed document, owner-gated. */
export const updateManagedLaunch = (
  input: ManagedLifecycleInput & { readonly launch: ManagedStackLaunchUpdate },
): Effect.Effect<
  ManagedStackDocument,
  NoRunningStackError | ManagedStackManagerError | HttpTransportClientError,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const document = yield* resolveManagedDocument(input);
      const manager = yield* ManagedStackManager;
      const acquisition = yield* manager.acquireControl(document.id);
      if (acquisition._tag !== "Owned") {
        if (document.lifecycle !== "running" || document.runtime?.controlEndpoint === undefined) {
          return yield* Effect.fail(new ManagedStackAttachedError({ stackId: document.id }));
        }
        const client = yield* HttpTransportClient;
        const response = yield* client.request(acquisition.endpoint, "/managed/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.launch),
        });
        if (!response.ok) {
          return yield* Effect.fail(new ManagedStackNotStoppedError({ stackId: document.id }));
        }
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
