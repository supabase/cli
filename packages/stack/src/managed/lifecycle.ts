import { Data, Effect, Layer, Schedule } from "effect";
import { NoRunningStackError } from "./model.ts";
import { RemoteStack } from "../RemoteStack.ts";
import { Stack } from "../Stack.ts";
import { dockerForceRemove } from "../cleanup.ts";
import { dockerContainerName } from "../StackIdentity.ts";
import { SERVICE_NAMES } from "../ServiceCatalog.ts";
import { HttpTransportClient, HttpTransportClientError } from "../HttpTransportClient.ts";
import type { ManagedStackDocument } from "./document.ts";
import {
  ManagedStackAttachedError,
  ManagedStackControlRequiredError,
  ManagedStackManager,
  type ManagedStackManagerError,
  type ManagedStackLaunchUpdate,
} from "./manager.ts";
import { controlEndpoint, type ControlEndpoint } from "./control.ts";
import { ManagedStackNotStoppedError, type ManagedPortIntentDocument } from "./model.ts";

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
    const document = yield* manager.resolveStack({
      operation: "status",
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
    if (document.lifecycle !== "running" || document.runtime?.controlEndpoint === undefined) {
      return yield* Effect.fail(noRunningStack(input));
    }
    const endpoint = yield* controlEndpoint(document.id).pipe(
      Effect.mapError(() => new ManagedStackControlRequiredError({ stackId: document.id })),
    );
    if (endpoint.url !== document.runtime.controlEndpoint) {
      return yield* Effect.fail(new ManagedStackControlRequiredError({ stackId: document.id }));
    }
    return endpoint;
  });

class ManagedStopPending extends Data.TaggedError("ManagedStopPending")<{}> {}
class ManagedDeletePending extends Data.TaggedError("ManagedDeletePending")<{}> {}

/** Connect to the deterministic endpoint persisted by the managed supervisor. */
export const connectManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<
  Layer.Layer<Stack>,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager | HttpTransportClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const document = yield* resolveManagedDocument(input);
      const manager = yield* ManagedStackManager;
      const acquisition = yield* manager.acquireControl(document.id);
      if (acquisition._tag === "Owned") {
        yield* acquisition.close;
        return yield* Effect.fail(noRunningStack(input));
      }
      const endpoint = yield* runtimeEndpoint(document, input);
      const client = yield* HttpTransportClient;
      return RemoteStack.layer(acquisition.endpoint ?? endpoint).pipe(
        Layer.provide(Layer.succeed(HttpTransportClient, client)),
      );
    }),
  );

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
      const document = yield* resolveManagedDocument(input);
      const manager = yield* ManagedStackManager;
      const acquisition = yield* manager.acquireControl(document.id);
      if (acquisition._tag === "Owned") {
        if (
          document.lifecycle === "running" ||
          document.lifecycle === "starting" ||
          document.lifecycle === "failed"
        ) {
          yield* Effect.sync(() => {
            dockerForceRemove(
              SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${document.id}`)),
            );
          });
          yield* manager.recordLifecycle(acquisition, {
            stackId: document.id,
            lifecycle: "stopped",
          });
        }
        yield* acquisition.close;
        return;
      }
      if (document.lifecycle !== "running") {
        return yield* Effect.fail(new ManagedStackAttachedError({ stackId: document.id }));
      }
      const client = yield* HttpTransportClient;
      const layer = RemoteStack.layer(acquisition.endpoint).pipe(
        Layer.provide(Layer.succeed(HttpTransportClient, client)),
      );
      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.stop();
      }).pipe(Effect.provide(layer));
      yield* manager.inspectStack(document.id).pipe(
        Effect.flatMap((current) =>
          current?.lifecycle === "stopped"
            ? Effect.succeed(current)
            : Effect.fail(new ManagedStopPending()),
        ),
        Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
        Effect.mapError(() => new ManagedStackNotStoppedError({ stackId: document.id })),
      );
      const released = yield* manager.acquireControl(document.id).pipe(
        Effect.flatMap((candidate) =>
          candidate._tag === "Owned"
            ? Effect.succeed(candidate)
            : Effect.fail(new ManagedStopPending()),
        ),
        Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))),
        Effect.mapError(() => new ManagedStackNotStoppedError({ stackId: document.id })),
      );
      yield* released.close;
    }),
  );

/** Remove a stopped document while holding its deterministic control owner. */
export const deleteManagedStack = (
  input: ManagedLifecycleInput,
): Effect.Effect<void, NoRunningStackError | ManagedStackManagerError, ManagedStackManager> =>
  Effect.gen(function* () {
    const document = yield* resolveManagedDocument(input);
    const manager = yield* ManagedStackManager;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const acquisition = yield* manager.acquireControl(document.id).pipe(
          Effect.flatMap((candidate) =>
            candidate._tag === "Owned"
              ? Effect.succeed(candidate)
              : Effect.fail(new ManagedDeletePending()),
          ),
          Effect.retry(
            Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
          ),
          Effect.mapError(() => new ManagedStackAttachedError({ stackId: document.id })),
        );
        yield* manager.deleteStack(document.id, acquisition);
      }),
    );
  });

/** Persist launch selections in the managed document, owner-gated. */
export const updateManagedLaunch = (
  input: ManagedLifecycleInput & { readonly launch: NonNullable<ManagedStackDocument["launch"]> },
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
      const update: ManagedStackLaunchUpdate = { stackId: document.id, launch: input.launch };
      return yield* Effect.ensuring(manager.updateLaunch(acquisition, update), acquisition.close);
    }),
  );
