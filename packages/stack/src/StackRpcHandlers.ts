import { Context, Effect, Predicate, Stream } from "effect";
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
import { SupervisorSession } from "./SupervisorSession.ts";

type StackService = Stack["Service"];

const isRpcBoundaryError = (
  error: unknown,
): error is StackRpcTransportError | StackRpcProtocolError =>
  Predicate.isTagged(error, "StackRpcTransportError") ||
  Predicate.isTagged(error, "StackRpcProtocolError");

const local = <A, E>(
  session: SupervisorSession["Service"],
  operation: (
    stack: StackService,
  ) => Effect.Effect<A, E | StackRpcTransportError | StackRpcProtocolError>,
): Effect.Effect<A, E | StackUnavailableError> =>
  session.runtimeStack.pipe(
    Effect.flatMap((stack) => session.interruptWhenStopping(operation(stack))),
    Effect.catchIf(isRpcBoundaryError, (error) => Effect.die(error)),
  );

const localStream = <A, E>(
  session: SupervisorSession["Service"],
  operation: (
    stack: StackService,
  ) => Effect.Effect<
    Stream.Stream<A, E | StackRpcTransportError | StackRpcProtocolError>,
    E | StackRpcTransportError | StackRpcProtocolError
  >,
): Stream.Stream<A, E | StackUnavailableError> =>
  Stream.unwrap(
    session
      .interruptWhenStopping(session.runtimeStack.pipe(Effect.flatMap(operation)))
      .pipe(Effect.map(session.interruptStreamWhenStopping)),
  ).pipe(Stream.catchIf(isRpcBoundaryError, (error) => Stream.die(error)));

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
    const session = yield* SupervisorSession;
    const launchUpdater = yield* StackLaunchUpdater;
    return {
      GetInfo: () => local(session, (stack) => stack.getInfo()),
      StartStack: () => local(session, (stack) => stack.start()),
      StartService: ({ name }: { readonly name: string }) =>
        local(session, (stack) => stack.startService(name)),
      StopService: ({ name }: { readonly name: string }) =>
        local(session, (stack) => stack.stopService(name)),
      RestartService: ({ name }: { readonly name: string }) =>
        local(session, (stack) => stack.restartService(name)),
      WaitStackReady: ({
        options,
      }: {
        readonly options?: Parameters<StackService["waitAllReady"]>[0];
      }) => local(session, (stack) => stack.waitAllReady(options ?? inheritReadyOptions)),
      WaitServiceReady: ({
        name,
        options,
      }: {
        readonly name: string;
        readonly options?: Parameters<StackService["waitReady"]>[1];
      }) => local(session, (stack) => stack.waitReady(name, options ?? inheritReadyOptions)),
      ReloadFunctions: ({
        options,
      }: {
        readonly options?: Parameters<StackService["reloadFunctions"]>[0];
      }) => local(session, (stack) => stack.reloadFunctions(options)),
      ReloadEdgeRuntime: (options: Parameters<StackService["reloadEdgeRuntime"]>[0]) =>
        local(session, (stack) => stack.reloadEdgeRuntime(options)),
      UpdateLaunch: ({
        stackId,
        launch,
      }: {
        readonly stackId: string;
        readonly launch: StackLaunchUpdateRpc;
      }) => local(session, () => launchUpdater.update(stackId, launch)),
      GetServiceState: ({ name }: { readonly name: string }) =>
        local(session, (stack) => stack.getState(name)),
      GetAllServiceStates: () => local(session, (stack) => stack.getAllStates()),
      WatchServiceStates: ({ name }: { readonly name?: string }) =>
        name === undefined
          ? localStream(session, (stack) => Effect.succeed(stack.allStateChanges()))
          : localStream(session, (stack) => stack.stateChanges(name)),
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
          ? local(session, (stack) => stack.logHistoryAll(limit, services))
          : local(session, (stack) => stack.logHistory(name, limit)),
      WatchLogs: ({
        name,
        services,
      }: {
        readonly name?: string;
        readonly services?: ReadonlyArray<string>;
      }) =>
        name === undefined
          ? localStream(session, (stack) => Effect.succeed(stack.subscribeAllLogs(services)))
          : localStream(session, (stack) => Effect.succeed(stack.subscribeLogs(name))),
    };
  }),
);
