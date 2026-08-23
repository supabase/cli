// oxlint-disable effecttsgo/multiple-catch-tag -- Separate transport/protocol defect mappings preserve their distinct typed boundaries.
import { Context, Effect, Stream } from "effect";
import {
  StackBuildError,
  type StackRpcProtocolError,
  type StackRpcTransportError,
  type StackUnavailableError,
} from "./errors.ts";
import { inheritReadyOptions } from "./StackConfig.ts";
import { StackRpc } from "./StackRpc.ts";
import type { Stack } from "./Stack.ts";
import type { StackLaunchUpdateRpc } from "./StackRpc.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";

type StackService = Stack["Service"];

const local = <A, E>(
  lifecycle: SupervisorLifecycle["Service"],
  operation: (
    stack: StackService,
  ) => Effect.Effect<A, E | StackRpcTransportError | StackRpcProtocolError>,
): Effect.Effect<A, E | StackUnavailableError> =>
  lifecycle.runtimeStack.pipe(
    Effect.flatMap(operation),
    Effect.catchTag("StackRpcTransportError", (error) => Effect.die(error)),
    Effect.catchTag("StackRpcProtocolError", (error) => Effect.die(error)),
  );

const localStream = <A, E>(
  lifecycle: SupervisorLifecycle["Service"],
  operation: (
    stack: StackService,
  ) => Effect.Effect<
    Stream.Stream<A, E | StackRpcTransportError | StackRpcProtocolError>,
    E | StackRpcTransportError | StackRpcProtocolError
  >,
): Stream.Stream<A, E | StackUnavailableError> =>
  Stream.unwrap(lifecycle.runtimeStack.pipe(Effect.flatMap(operation))).pipe(
    Stream.catchTag("StackRpcTransportError", (error) => Stream.die(error)),
    Stream.catchTag("StackRpcProtocolError", (error) => Stream.die(error)),
  );

export interface StackLaunchUpdater {
  readonly update: (
    stackId: string,
    launch: StackLaunchUpdateRpc,
  ) => Effect.Effect<void, StackBuildError>;
}

export const StackLaunchUpdater = Context.Reference<StackLaunchUpdater>(
  "stack/StackLaunchUpdater",
  {
    defaultValue: () => ({
      update: () =>
        Effect.fail(
          new StackBuildError({ detail: "Managed launch updates require a supervisor owner" }),
        ),
    }),
  },
);

/** Runtime-backed implementations for the shared StackRpc contract. */
export const StackRpcHandlers = StackRpc.toLayer(
  Effect.gen(function* () {
    const lifecycle = yield* SupervisorLifecycle;
    const launchUpdater = yield* StackLaunchUpdater;
    return {
      GetInfo: () => local(lifecycle, (stack) => stack.getInfo()),
      StartStack: () => local(lifecycle, (stack) => stack.start()),
      StartService: ({ name }: { readonly name: string }) =>
        local(lifecycle, (stack) => stack.startService(name)),
      StopService: ({ name }: { readonly name: string }) =>
        local(lifecycle, (stack) => stack.stopService(name)),
      RestartService: ({ name }: { readonly name: string }) =>
        local(lifecycle, (stack) => stack.restartService(name)),
      WaitStackReady: ({
        options,
      }: {
        readonly options?: Parameters<StackService["waitAllReady"]>[0];
      }) => local(lifecycle, (stack) => stack.waitAllReady(options ?? inheritReadyOptions)),
      WaitServiceReady: ({
        name,
        options,
      }: {
        readonly name: string;
        readonly options?: Parameters<StackService["waitReady"]>[1];
      }) => local(lifecycle, (stack) => stack.waitReady(name, options ?? inheritReadyOptions)),
      ReloadFunctions: ({
        options,
      }: {
        readonly options?: Parameters<StackService["reloadFunctions"]>[0];
      }) => local(lifecycle, (stack) => stack.reloadFunctions(options)),
      ReloadEdgeRuntime: (options: Parameters<StackService["reloadEdgeRuntime"]>[0]) =>
        local(lifecycle, (stack) => stack.reloadEdgeRuntime(options)),
      UpdateLaunch: ({
        stackId,
        launch,
      }: {
        readonly stackId: string;
        readonly launch: StackLaunchUpdateRpc;
      }) => launchUpdater.update(stackId, launch),
      GetServiceState: ({ name }: { readonly name: string }) =>
        local(lifecycle, (stack) => stack.getState(name)),
      GetAllServiceStates: () => local(lifecycle, (stack) => stack.getAllStates()),
      WatchServiceStates: ({ name }: { readonly name?: string }) =>
        name === undefined
          ? localStream(lifecycle, (stack) => Effect.succeed(stack.allStateChanges()))
          : localStream(lifecycle, (stack) => stack.stateChanges(name)),
      GetLogHistory: ({
        name,
        limit,
        services,
      }: {
        readonly name?: string;
        readonly limit?: number;
        readonly services?: ReadonlyArray<string>;
      }) =>
        name === undefined
          ? local(lifecycle, (stack) => stack.logHistoryAll(limit, services))
          : local(lifecycle, (stack) =>
              stack.getState(name).pipe(Effect.flatMap(() => stack.logHistory(name, limit))),
            ),
      WatchLogs: ({
        name,
        services,
      }: {
        readonly name?: string;
        readonly services?: ReadonlyArray<string>;
      }) =>
        name === undefined
          ? localStream(lifecycle, (stack) =>
              Effect.forEach(services ?? [], (service) => stack.getState(service), {
                discard: true,
              }).pipe(Effect.as(stack.subscribeAllLogs(services))),
            )
          : localStream(lifecycle, (stack) =>
              stack.getState(name).pipe(Effect.as(stack.subscribeLogs(name))),
            ),
    };
  }),
);
