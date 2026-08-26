import { Effect, Exit, Layer, Match, Scope, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { Scope as ScopeType } from "effect/Scope";
import {
  DaemonUpgradeRequired,
  StackBuildError,
  StackRpcProtocolError,
  StackRpcTransportError,
  StackUnavailableError,
} from "./errors.ts";
import { HttpTransportClient, makeHttpControlClient } from "./HttpTransportClient.ts";
import {
  ControlAddressConflictError,
  ControlProtocolError,
  ControlProtocolMismatchError,
  ControlTransportError,
  type ControlEndpoint,
} from "./managed/control.ts";
import { Stack } from "./Stack.ts";
import { inheritReadyOptions } from "./StackConfig.ts";
import {
  StackRpc,
  STACK_RPC_PATH,
  stackRpcFenceHeaders,
  type StackLaunchUpdateRpc,
  type StackRpcFence,
} from "./StackRpc.ts";
import { StackServiceState } from "./StackServiceState.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  isControlSupervisorStatus,
  type ControlSupervisorStatus,
} from "./DaemonProtocol.ts";

interface RemoteOwnerDescriptor {
  readonly ownershipId: string;
  readonly ownerSessionId: string;
  readonly endpoint: ControlEndpoint;
  readonly controlProtocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  readonly daemonCliVersion: string;
}

export interface RemoteStackOptions {
  readonly owner: Omit<RemoteOwnerDescriptor, "endpoint">;
  readonly cliVersion: string;
  readonly stackId?: string;
}

const protocolError = (
  endpoint: ControlEndpoint,
  procedure: string,
  detail: string,
  cause?: unknown,
) =>
  new StackRpcProtocolError({
    endpoint: endpoint.url,
    procedure,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
const transportError = (endpoint: ControlEndpoint, procedure: string, cause: unknown) =>
  new StackRpcTransportError({ endpoint: endpoint.url, procedure, cause });

const controlErrorToRpc = (
  endpoint: ControlEndpoint,
  procedure: string,
  error:
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError,
): StackRpcTransportError | StackRpcProtocolError => {
  if (error instanceof ControlTransportError) return transportError(endpoint, procedure, error);
  const detail =
    error instanceof ControlProtocolMismatchError || error instanceof ControlAddressConflictError
      ? error.message
      : procedure === "owner" && typeof error.cause === "number"
        ? `Owner probe returned HTTP ${error.cause}`
        : `Invalid ${procedure} response`;
  return protocolError(endpoint, procedure, detail, error);
};

const translateRpcClientFailure = (
  error: RpcClientError.RpcClientError,
  endpoint: ControlEndpoint,
  procedure: string,
): StackRpcTransportError | StackRpcProtocolError => {
  const reason = error.reason;
  if (reason instanceof RpcClientError.RpcClientDefect)
    return protocolError(endpoint, procedure, reason.message, reason.cause);
  if (reason instanceof HttpClientError.HttpClientErrorSchema)
    return reason.kind === "TransportError"
      ? transportError(endpoint, procedure, reason.cause ?? reason)
      : protocolError(endpoint, procedure, error.message, reason);
  return transportError(endpoint, procedure, reason);
};

const bodyForRequest = (
  body: HttpBody.HttpBody,
): Effect.Effect<string | Uint8Array | undefined, unknown> => {
  return Match.valueTags(body, {
    Empty: () => Effect.succeed(undefined),
    FormData: () => Effect.succeed(undefined),
    Uint8Array: (value) => Effect.succeed(value.body),
    Raw: (value) => Effect.succeed(typeof value.body === "string" ? value.body : undefined),
    Stream: (value) =>
      Stream.runCollect(value.stream).pipe(
        Effect.map((chunks) => {
          const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const result = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return result;
        }),
      ),
  });
};

const makeHttpClient = (
  endpoint: ControlEndpoint,
  transport: HttpTransportClient["Service"],
  fence: StackRpcFence,
): HttpClient.HttpClient =>
  HttpClient.make((request, url, signal) => {
    const rawPath = `${url.pathname}${url.search}`;
    const path = rawPath === `${STACK_RPC_PATH}/` ? STACK_RPC_PATH : rawPath;
    return bodyForRequest(request.body).pipe(
      Effect.flatMap((body) =>
        transport.request(endpoint, path, {
          method: request.method,
          headers: { ...request.headers, ...stackRpcFenceHeaders(fence) },
          signal,
          ...(body === undefined ? {} : { body }),
        }),
      ),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      ),
    );
  });

type GeneratedRpcClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof StackRpc>,
  RpcClientError.RpcClientError
>;
const makeRemoteRpcClient = (
  endpoint: ControlEndpoint,
  options: RemoteStackOptions,
): Effect.Effect<
  { readonly client: GeneratedRpcClient; readonly owner: ControlSupervisorStatus },
  DaemonUpgradeRequired | StackRpcTransportError | StackRpcProtocolError,
  HttpTransportClient | ScopeType
> =>
  Effect.gen(function* () {
    const transport = yield* HttpTransportClient;
    const control = makeHttpControlClient(transport);
    const expectedOwner = options.owner;
    const ownerStatus = yield* control
      .readOwner(endpoint, expectedOwner.ownershipId)
      .pipe(Effect.mapError((error) => controlErrorToRpc(endpoint, "owner", error)));
    if (!isControlSupervisorStatus(ownerStatus)) {
      return yield* Effect.fail(
        protocolError(endpoint, "owner", `Managed stack is busy with ${ownerStatus.operation}`),
      );
    }
    if (options.cliVersion !== ownerStatus.daemonCliVersion)
      return yield* Effect.fail(
        new DaemonUpgradeRequired({
          stackId: options.stackId ?? expectedOwner.ownershipId,
          oldCliVersion: ownerStatus.daemonCliVersion,
          newCliVersion: options.cliVersion,
          state: ownerStatus.state,
          ready: ownerStatus.ready,
        }),
      );
    if (
      ownerStatus.ownershipId !== expectedOwner.ownershipId ||
      ownerStatus.ownerSessionId !== expectedOwner.ownerSessionId ||
      ownerStatus.controlProtocolVersion !== expectedOwner.controlProtocolVersion ||
      ownerStatus.daemonCliVersion !== expectedOwner.daemonCliVersion
    )
      return yield* Effect.fail(
        protocolError(
          endpoint,
          "owner",
          "Remote supervisor owner descriptor changed before RPC construction",
        ),
      );
    const rpcHttpClient = HttpClient.mapRequest(
      makeHttpClient(endpoint, transport, {
        ownershipId: expectedOwner.ownershipId,
        ownerSessionId: expectedOwner.ownerSessionId,
      }),
      HttpClientRequest.prependUrl(`${endpoint.url}${STACK_RPC_PATH}`),
    );
    const protocol = yield* RpcClient.makeProtocolHttp(rpcHttpClient).pipe(
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const client = yield* RpcClient.make(StackRpc).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    return { client, owner: ownerStatus };
  });

type StackRpcDomainError = Rpc.Error<RpcGroup.Rpcs<typeof StackRpc>>;
type StackRpcFailure = StackRpcDomainError | RpcClientError.RpcClientError;

const isRpcClientFailure = <E extends StackRpcFailure>(
  error: E,
): error is Extract<E, RpcClientError.RpcClientError> =>
  error instanceof RpcClientError.RpcClientError;

const callRpc = <A, E extends StackRpcFailure, R>(
  endpoint: ControlEndpoint,
  procedure: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(isRpcClientFailure, (error) =>
      Effect.fail(translateRpcClientFailure(error, endpoint, procedure)),
    ),
  );

const streamRpc = <A, E extends StackRpcFailure, R>(
  endpoint: ControlEndpoint,
  procedure: string,
  stream: Stream.Stream<A, E, R>,
) =>
  stream.pipe(
    Stream.catchIf(isRpcClientFailure, (error) =>
      Stream.fail(translateRpcClientFailure(error, endpoint, procedure)),
    ),
  );
export const RemoteStack = {
  layer: (
    endpoint: ControlEndpoint,
    options: RemoteStackOptions,
  ): Layer.Layer<
    Stack,
    DaemonUpgradeRequired | StackRpcTransportError | StackRpcProtocolError,
    HttpTransportClient
  > =>
    Layer.effect(
      Stack,
      Effect.gen(function* () {
        const parentScope = yield* Effect.scope;
        const rpcScope = yield* Scope.fork(parentScope);
        const transport = yield* HttpTransportClient;
        const control = makeHttpControlClient(transport);
        const { client } = yield* makeRemoteRpcClient(endpoint, options).pipe(
          Scope.provide(rpcScope),
        );
        const closeRpcScope = yield* Effect.cached(Scope.close(rpcScope, Exit.void));
        const scopedRpcStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
          stream.pipe(Stream.provideService(Scope.Scope, rpcScope));
        const call = <A, E extends StackRpcFailure, R>(
          procedure: string,
          effect: Effect.Effect<A, E, R>,
        ) => callRpc(endpoint, procedure, effect);
        const fastCall = <A, E extends StackRpcFailure, R>(
          procedure: string,
          effect: Effect.Effect<A, E, R>,
        ) =>
          call(procedure, effect).pipe(
            Effect.timeout("30 seconds"),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(transportError(endpoint, procedure, cause)),
            ),
          );
        const requestStop = () => {
          const owner = options.owner;
          // Closing the RPC scope is best-effort cleanup. The control-plane
          // stop is fenced to the session captured during the owner handshake
          // and must still be sent when a stream/client finalizer fails. The
          // cleanup handoff is best-effort and interruptible so cancellation
          // cannot pin the caller behind the control-plane stop timeout.
          return Effect.uninterruptibleMask((restore) =>
            Effect.exit(restore(closeRpcScope)).pipe(
              Effect.andThen(
                restore(
                  control.stopSession(endpoint, owner.ownershipId, owner.ownerSessionId),
                ).pipe(
                  Effect.catchTag("ControlMaintenanceBusyError", (error) =>
                    Effect.fail(new ControlProtocolError({ endpoint, cause: error })),
                  ),
                ),
              ),
            ),
          );
        };
        return {
          getInfo: () => fastCall("GetInfo", client.GetInfo(undefined)),
          start: () => call("StartStack", client.StartStack(undefined)),
          stop: () => requestStop(),
          dispose: () => requestStop(),
          startService: (name: string) => call("StartService", client.StartService({ name })),
          stopService: (name: string) => call("StopService", client.StopService({ name })),
          restartService: (name: string) => call("RestartService", client.RestartService({ name })),
          reloadFunctions: (opts) =>
            call(
              "ReloadFunctions",
              client.ReloadFunctions(opts === undefined ? {} : { options: opts }),
            ),
          reloadEdgeRuntime: (opts) => call("ReloadEdgeRuntime", client.ReloadEdgeRuntime(opts)),
          getState: (name: string) =>
            fastCall("GetServiceState", client.GetServiceState({ name })).pipe(
              Effect.map((state) => new StackServiceState(state)),
            ),
          getAllStates: () =>
            fastCall("GetAllServiceStates", client.GetAllServiceStates(undefined)).pipe(
              Effect.map((states) => states.map((state) => new StackServiceState(state))),
            ),
          stateChanges: (name: string) =>
            fastCall("GetServiceState", client.GetServiceState({ name })).pipe(
              Effect.as(
                scopedRpcStream(
                  streamRpc(endpoint, "WatchServiceStates", client.WatchServiceStates({ name })),
                ).pipe(Stream.map((state) => new StackServiceState(state))),
              ),
            ),
          allStateChanges: () =>
            scopedRpcStream(
              streamRpc(endpoint, "WatchServiceStates", client.WatchServiceStates({})),
            ).pipe(
              Stream.catchTag("ServiceNotFoundError", Stream.die),
              Stream.map((state) => new StackServiceState(state)),
            ),
          waitReady: (name: string, opts) =>
            call(
              "WaitServiceReady",
              client.WaitServiceReady({ name, options: opts ?? inheritReadyOptions }),
            ),
          waitAllReady: (opts) =>
            call("WaitStackReady", client.WaitStackReady({ options: opts ?? inheritReadyOptions })),
          subscribeLogs: (name: string) =>
            scopedRpcStream(streamRpc(endpoint, "WatchLogs", client.WatchLogs({ name }))),
          subscribeAllLogs: (services) =>
            scopedRpcStream(
              streamRpc(
                endpoint,
                "WatchLogs",
                client.WatchLogs(services === undefined ? {} : { services }),
              ),
            ),
          logHistory: (name: string, limit?: number) =>
            fastCall(
              "GetLogHistory",
              client.GetLogHistory(limit === undefined ? { name } : { name, limit }),
            ),
          logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) =>
            fastCall(
              "GetLogHistory",
              client.GetLogHistory({
                ...(limit === undefined ? {} : { limit }),
                ...(services === undefined ? {} : { services }),
              }),
            ),
        };
      }),
    ),
};

export const updateRemoteLaunch = (
  endpoint: ControlEndpoint,
  options: RemoteStackOptions,
  stackId: string,
  launch: StackLaunchUpdateRpc,
): Effect.Effect<
  void,
  | DaemonUpgradeRequired
  | StackBuildError
  | StackUnavailableError
  | StackRpcTransportError
  | StackRpcProtocolError,
  HttpTransportClient
> =>
  Effect.scoped(
    makeRemoteRpcClient(endpoint, options).pipe(
      Effect.flatMap(({ client }) =>
        callRpc(endpoint, "UpdateLaunch", client.UpdateLaunch({ stackId, launch })).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchTag("TimeoutError", (cause) =>
            Effect.fail(transportError(endpoint, "UpdateLaunch", cause)),
          ),
        ),
      ),
    ),
  );
