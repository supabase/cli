import { Context, Effect, Stream } from "effect";
import { StackBuildError } from "./errors.ts";
import { inheritReadyOptions } from "./StackConfig.ts";
import { StackRpc } from "./StackRpc.ts";
import { RuntimeGate } from "./RuntimeGate.ts";
import type { Stack } from "./Stack.ts";
import type { StackLaunchUpdateRpc } from "./StackRpc.ts";

type StackService = Stack["Service"];

const local = <A, E>(
  gate: RuntimeGate["Service"],
  operation: (
    stack: StackService,
  ) => Effect.Effect<
    A,
    E | import("./errors.ts").StackRpcTransportError | import("./errors.ts").StackRpcProtocolError
  >,
): Effect.Effect<A, E | import("./errors.ts").StackUnavailableError> =>
  gate.stack.pipe(
    Effect.flatMap(operation),
    Effect.catchTag("StackRpcTransportError", (error) => Effect.die(error)),
    Effect.catchTag("StackRpcProtocolError", (error) => Effect.die(error)),
  );

const localStream = <A, E>(
  gate: RuntimeGate["Service"],
  operation: (
    stack: StackService,
  ) => Effect.Effect<
    Stream.Stream<
      A,
      E | import("./errors.ts").StackRpcTransportError | import("./errors.ts").StackRpcProtocolError
    >,
    E | import("./errors.ts").StackRpcTransportError | import("./errors.ts").StackRpcProtocolError
  >,
): Stream.Stream<A, E | import("./errors.ts").StackUnavailableError> =>
  Stream.unwrap(gate.stack.pipe(Effect.flatMap(operation))).pipe(
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
    const gate = yield* RuntimeGate;
    const launchUpdater = yield* StackLaunchUpdater;
    return {
      GetInfo: () => local(gate, (stack) => stack.getInfo()),
      StartStack: () => local(gate, (stack) => stack.start()),
      StartService: ({ name }: { readonly name: string }) =>
        local(gate, (stack) => stack.startService(name)),
      StopService: ({ name }: { readonly name: string }) =>
        local(gate, (stack) => stack.stopService(name)),
      RestartService: ({ name }: { readonly name: string }) =>
        local(gate, (stack) => stack.restartService(name)),
      WaitStackReady: ({
        options,
      }: {
        readonly options?: Parameters<StackService["waitAllReady"]>[0];
      }) => local(gate, (stack) => stack.waitAllReady(options ?? inheritReadyOptions)),
      WaitServiceReady: ({
        name,
        options,
      }: {
        readonly name: string;
        readonly options?: Parameters<StackService["waitReady"]>[1];
      }) => local(gate, (stack) => stack.waitReady(name, options ?? inheritReadyOptions)),
      ReloadFunctions: ({
        options,
      }: {
        readonly options?: Parameters<StackService["reloadFunctions"]>[0];
      }) => local(gate, (stack) => stack.reloadFunctions(options)),
      ReloadEdgeRuntime: (options: Parameters<StackService["reloadEdgeRuntime"]>[0]) =>
        local(gate, (stack) => stack.reloadEdgeRuntime(options)),
      UpdateLaunch: ({
        stackId,
        launch,
      }: {
        readonly stackId: string;
        readonly launch: StackLaunchUpdateRpc;
      }) => launchUpdater.update(stackId, launch),
      GetServiceState: ({ name }: { readonly name: string }) =>
        local(gate, (stack) => stack.getState(name)),
      GetAllServiceStates: () => local(gate, (stack) => stack.getAllStates()),
      WatchServiceStates: ({ name }: { readonly name?: string }) =>
        name === undefined
          ? localStream(gate, (stack) => Effect.succeed(stack.allStateChanges()))
          : localStream(gate, (stack) => stack.stateChanges(name)),
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
          ? local(gate, (stack) => stack.logHistoryAll(limit, services))
          : local(gate, (stack) =>
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
          ? localStream(gate, (stack) =>
              Effect.forEach(services ?? [], (service) => stack.getState(service), {
                discard: true,
              }).pipe(Effect.as(stack.subscribeAllLogs(services))),
            )
          : localStream(gate, (stack) =>
              stack.getState(name).pipe(Effect.as(stack.subscribeLogs(name))),
            ),
    };
  }),
);
