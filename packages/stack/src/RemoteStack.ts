import { ServiceNotFoundError, ServiceReadyError } from "@supabase/process-compose";
import { Effect, Layer, Match, Predicate, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { Scope as ScopeType } from "effect/Scope";
import {
  DaemonUpgradeRequired,
  StackBuildError,
  StackNotRunningError,
  StackReadinessError,
  StackRpcProtocolError,
  StackRpcTransportError,
  StackUnavailableError,
} from "./errors.ts";
import { HttpTransportClient } from "./HttpTransportClient.ts";
import {
  ControlAddressConflictError,
  ControlProtocolError,
  ControlProtocolMismatchError,
  ControlTransportError,
  readControlOwnerStatus,
  waitForControlSessionEnd,
  type ControlEndpoint,
} from "./managed/control.ts";
import { Stack } from "./Stack.ts";
import { inheritReadyOptions } from "./StackConfig.ts";
import { StackRpc, STACK_RPC_PATH, type StackLaunchUpdateRpc } from "./StackRpc.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { CONTROL_PROTOCOL_VERSION, ControlOwnerStatusSchema } from "./DaemonProtocol.ts";
import type { BuildIdentityValue } from "./BuildIdentity.ts";

interface RemoteOwnerDescriptor {
  readonly ownershipId: string;
  readonly ownerSessionId: string;
  readonly endpoint: ControlEndpoint;
  readonly controlProtocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  readonly daemonCliVersion: string;
  readonly daemonBuildId: string;
}

export interface RemoteStackOptions {
  readonly owner: Omit<RemoteOwnerDescriptor, "endpoint">;
  readonly buildIdentity: BuildIdentityValue;
  readonly stackId?: string;
}

type RemoteDomainError =
  | StackUnavailableError
  | ServiceNotFoundError
  | ServiceReadyError
  | StackBuildError
  | StackNotRunningError
  | StackReadinessError;
type RemoteRpcError = RemoteDomainError | StackRpcTransportError | StackRpcProtocolError;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;
const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? Reflect.get(value, key) : undefined;
const stringField = (value: unknown, key: string): string | undefined => {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : undefined;
};
const taggedValue = (value: unknown, tag: string): unknown =>
  Predicate.isTagged(value, tag) ? value : undefined;
const knownErrorTag = (value: unknown): string | undefined => {
  const tags = [
    "StackUnavailableError",
    "ServiceNotFoundError",
    "ServiceReadyError",
    "StackBuildError",
    "StackNotRunningError",
    "StackReadinessError",
    "RpcClientError",
    "RpcClientDefect",
    "HttpClientError",
    "TransportError",
  ] as const;
  return tags.find((tag) => Predicate.isTagged(value, tag));
};
const remoteErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (isRecord(error))
    return (
      stringField(error, "detail") ??
      stringField(error, "reason") ??
      stringField(error, "message") ??
      String(error)
    );
  return String(error);
};

/** RPC schema transformations decode domain errors into their shared classes. */
const makeDomainError = (error: unknown): RemoteDomainError | undefined => {
  if (error instanceof StackUnavailableError) return error;
  if (error instanceof ServiceNotFoundError) return error;
  if (error instanceof ServiceReadyError) return error;
  if (error instanceof StackBuildError) return error;
  if (error instanceof StackNotRunningError) return error;
  if (error instanceof StackReadinessError) return error;
  return undefined;
};

const isAllowed = (error: RemoteDomainError, allowed: ReadonlyArray<string>): boolean =>
  allowed.some((tag) => Predicate.isTagged(error, tag));
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

const readRemoteOwner = (
  transport: HttpTransportClient["Service"],
  endpoint: ControlEndpoint,
  signal?: AbortSignal,
): Effect.Effect<unknown, ControlTransportError | ControlProtocolError> =>
  transport
    .request(endpoint, "/owner", {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    })
    .pipe(
      Effect.mapError(
        (cause) => new ControlTransportError({ endpoint, reason: "unreachable", cause }),
      ),
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) => new ControlProtocolError({ endpoint, cause }),
            })
          : Effect.fail(new ControlProtocolError({ endpoint, cause: response.status })),
      ),
    );

const controlErrorToRpc = (
  endpoint: ControlEndpoint,
  procedure: string,
  error:
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError,
): StackRpcTransportError | StackRpcProtocolError => {
  if (Predicate.isTagged(error, "ControlTransportError"))
    return transportError(endpoint, procedure, error);
  const detail =
    Predicate.isTagged(error, "ControlProtocolMismatchError") ||
    Predicate.isTagged(error, "ControlAddressConflictError")
      ? error.message
      : procedure === "owner" && typeof error.cause === "number"
        ? `Owner probe returned HTTP ${error.cause}`
        : `Invalid ${procedure} response`;
  return protocolError(endpoint, procedure, detail, error);
};

const mapRpcError = (
  error: unknown,
  endpoint: ControlEndpoint,
  procedure: string,
  allowed: ReadonlyArray<string>,
): RemoteRpcError => {
  const domain = makeDomainError(error);
  if (domain !== undefined)
    return isAllowed(domain, allowed)
      ? domain
      : protocolError(
          endpoint,
          procedure,
          `Unexpected error ${knownErrorTag(error) ?? "unknown"}`,
          error,
        );
  if (Predicate.isTagged(error, "HttpTransportClientError"))
    return transportError(endpoint, procedure, error);
  const rpcError = taggedValue(error, "RpcClientError");
  if (rpcError !== undefined) {
    const reason = field(rpcError, "reason");
    const defect = taggedValue(reason, "RpcClientDefect");
    if (defect !== undefined)
      return protocolError(
        endpoint,
        procedure,
        stringField(defect, "message") ?? "RPC protocol defect",
        field(defect, "cause"),
      );
    const httpError = taggedValue(reason, "HttpClientError");
    if (httpError !== undefined) {
      const nested = field(httpError, "reason");
      const transport = taggedValue(nested, "TransportError");
      if (transport !== undefined)
        return transportError(endpoint, procedure, field(transport, "cause") ?? transport);
      return protocolError(endpoint, procedure, remoteErrorMessage(httpError), httpError);
    }
    return transportError(endpoint, procedure, reason);
  }
  if (Predicate.isTagged(error, "HttpClientError"))
    return transportError(endpoint, procedure, error);
  return protocolError(endpoint, procedure, remoteErrorMessage(error), error);
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
): HttpClient.HttpClient =>
  HttpClient.make((request, url, signal) => {
    const rawPath = `${url.pathname}${url.search}`;
    const path = rawPath === `${STACK_RPC_PATH}/` ? STACK_RPC_PATH : rawPath;
    return bodyForRequest(request.body).pipe(
      Effect.flatMap((body) =>
        transport.request(endpoint, path, {
          method: request.method,
          headers: { ...request.headers },
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
  { readonly client: GeneratedRpcClient; readonly owner: typeof ControlOwnerStatusSchema.Type },
  DaemonUpgradeRequired | StackRpcTransportError | StackRpcProtocolError,
  HttpTransportClient | ScopeType
> =>
  Effect.gen(function* () {
    const transport = yield* HttpTransportClient;
    const expectedOwner = options.owner;
    const ownerStatus = yield* readControlOwnerStatus(
      endpoint,
      expectedOwner.ownershipId,
      (ownerEndpoint) => readRemoteOwner(transport, ownerEndpoint),
    ).pipe(Effect.mapError((error) => controlErrorToRpc(endpoint, "owner", error)));
    if (options.buildIdentity.buildId !== ownerStatus.daemonBuildId)
      return yield* Effect.fail(
        new DaemonUpgradeRequired({
          stackId: options.stackId ?? expectedOwner.ownershipId,
          oldCliVersion: ownerStatus.daemonCliVersion,
          oldBuildId: ownerStatus.daemonBuildId,
          newCliVersion: options.buildIdentity.cliVersion,
          newBuildId: options.buildIdentity.buildId,
        }),
      );
    if (
      ownerStatus.ownershipId !== expectedOwner.ownershipId ||
      ownerStatus.ownerSessionId !== expectedOwner.ownerSessionId ||
      ownerStatus.controlProtocolVersion !== expectedOwner.controlProtocolVersion ||
      ownerStatus.daemonCliVersion !== expectedOwner.daemonCliVersion ||
      ownerStatus.daemonBuildId !== expectedOwner.daemonBuildId
    )
      return yield* Effect.fail(
        protocolError(
          endpoint,
          "owner",
          "Remote supervisor owner descriptor changed before RPC construction",
        ),
      );
    const rpcHttpClient = HttpClient.mapRequest(
      makeHttpClient(endpoint, transport),
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

const allowedError =
  <E extends RemoteDomainError>(
    endpoint: ControlEndpoint,
    procedure: string,
    allowed: ReadonlyArray<string>,
    guard: (error: RemoteDomainError) => error is E,
  ) =>
  (error: unknown): E | StackRpcTransportError | StackRpcProtocolError => {
    const mapped = mapRpcError(error, endpoint, procedure, allowed);
    if (mapped instanceof StackRpcTransportError || mapped instanceof StackRpcProtocolError)
      return mapped;
    return guard(mapped)
      ? mapped
      : protocolError(
          endpoint,
          procedure,
          `Unexpected error ${knownErrorTag(error) ?? "unknown"}`,
          error,
        );
  };
const unavailable = (error: RemoteDomainError): error is StackUnavailableError =>
  error instanceof StackUnavailableError;
const notFound = (error: RemoteDomainError): error is ServiceNotFoundError =>
  error instanceof ServiceNotFoundError;
const ready = (error: RemoteDomainError): error is ServiceReadyError =>
  error instanceof ServiceReadyError;
const build = (error: RemoteDomainError): error is StackBuildError =>
  error instanceof StackBuildError;
const notRunning = (error: RemoteDomainError): error is StackNotRunningError =>
  error instanceof StackNotRunningError;
const readiness = (error: RemoteDomainError): error is StackReadinessError =>
  error instanceof StackReadinessError;
const mutating = (
  error: RemoteDomainError,
): error is
  | StackUnavailableError
  | ServiceNotFoundError
  | ServiceReadyError
  | StackBuildError
  | StackNotRunningError
  | StackReadinessError =>
  unavailable(error) ||
  notFound(error) ||
  ready(error) ||
  build(error) ||
  notRunning(error) ||
  readiness(error);
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
        const transport = yield* HttpTransportClient;
        const { client } = yield* makeRemoteRpcClient(endpoint, options);
        const call = <A, E extends RemoteDomainError>(
          procedure: string,
          effect: Effect.Effect<A, unknown>,
          allowed: ReadonlyArray<string>,
          guard: (error: RemoteDomainError) => error is E,
        ): Effect.Effect<A, E | StackRpcTransportError | StackRpcProtocolError> =>
          effect.pipe(Effect.mapError(allowedError(endpoint, procedure, allowed, guard)));
        const fastCall = <A, E extends RemoteDomainError>(
          procedure: string,
          effect: Effect.Effect<A, unknown>,
          allowed: ReadonlyArray<string>,
          guard: (error: RemoteDomainError) => error is E,
        ): Effect.Effect<A, E | StackRpcTransportError | StackRpcProtocolError> =>
          call(procedure, effect, allowed, guard).pipe(
            Effect.timeout("30 seconds"),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(transportError(endpoint, procedure, cause)),
            ),
          );
        const requestStop = (signal?: AbortSignal) => {
          const owner = options.owner;
          const body = JSON.stringify({
            ownershipId: owner.ownershipId,
            ownerSessionId: owner.ownerSessionId,
          });
          const readOwnerAfterStop = readControlOwnerStatus(
            endpoint,
            owner.ownershipId,
            (ownerEndpoint) => readRemoteOwner(transport, ownerEndpoint, signal),
          );
          return transport
            .request(endpoint, "/stop", {
              method: "POST",
              body,
              headers: { "content-type": "application/json", connection: "close" },
              ...(signal === undefined ? {} : { signal }),
            })
            .pipe(
              Effect.mapError(
                (cause) => new ControlTransportError({ endpoint, reason: "unreachable", cause }),
              ),
              Effect.flatMap((response) =>
                response.ok
                  ? waitForControlSessionEnd(
                      endpoint,
                      owner.ownershipId,
                      owner.ownerSessionId,
                      readOwnerAfterStop,
                    )
                  : Effect.fail(new ControlProtocolError({ endpoint, cause: response.status })),
              ),
            );
        };
        return {
          getInfo: () =>
            fastCall("GetInfo", client.GetInfo(undefined), ["StackUnavailableError"], unavailable),
          start: () =>
            call(
              "StartStack",
              client.StartStack(undefined),
              [
                "StackUnavailableError",
                "ServiceReadyError",
                "StackBuildError",
                "StackReadinessError",
              ],
              (
                e,
              ): e is
                | StackUnavailableError
                | ServiceReadyError
                | StackBuildError
                | StackReadinessError => unavailable(e) || ready(e) || build(e) || readiness(e),
            ),
          stop: () => requestStop(),
          dispose: () => requestStop(),
          startService: (name: string) =>
            call(
              "StartService",
              client.StartService({ name }),
              [
                "StackUnavailableError",
                "ServiceNotFoundError",
                "ServiceReadyError",
                "StackBuildError",
                "StackNotRunningError",
                "StackReadinessError",
              ],
              mutating,
            ),
          stopService: (name: string) =>
            // LocalStack/Orchestrator stopService signals owned fibers and settles projected state
            // without a graceful readiness wait, preserving the bounded fast-unary policy.
            fastCall(
              "StopService",
              client.StopService({ name }),
              [
                "StackUnavailableError",
                "ServiceNotFoundError",
                "StackBuildError",
                "StackNotRunningError",
              ],
              (
                e,
              ): e is
                | StackUnavailableError
                | ServiceNotFoundError
                | StackBuildError
                | StackNotRunningError =>
                unavailable(e) || notFound(e) || build(e) || notRunning(e),
            ),
          restartService: (name: string) =>
            call(
              "RestartService",
              client.RestartService({ name }),
              [
                "StackUnavailableError",
                "ServiceNotFoundError",
                "ServiceReadyError",
                "StackBuildError",
                "StackNotRunningError",
                "StackReadinessError",
              ],
              mutating,
            ),
          reloadFunctions: (opts) =>
            call(
              "ReloadFunctions",
              client.ReloadFunctions(opts === undefined ? {} : { options: opts }),
              [
                "StackUnavailableError",
                "ServiceNotFoundError",
                "ServiceReadyError",
                "StackBuildError",
                "StackNotRunningError",
                "StackReadinessError",
              ],
              mutating,
            ),
          reloadEdgeRuntime: (opts) =>
            call(
              "ReloadEdgeRuntime",
              client.ReloadEdgeRuntime(opts),
              [
                "StackUnavailableError",
                "ServiceNotFoundError",
                "ServiceReadyError",
                "StackBuildError",
                "StackNotRunningError",
                "StackReadinessError",
              ],
              mutating,
            ),
          getState: (name: string) =>
            fastCall(
              "GetServiceState",
              client.GetServiceState({ name }),
              ["StackUnavailableError", "ServiceNotFoundError"],
              (e): e is StackUnavailableError | ServiceNotFoundError =>
                unavailable(e) || notFound(e),
            ).pipe(Effect.map((state) => new StackServiceState(state))),
          getAllStates: () =>
            fastCall(
              "GetAllServiceStates",
              client.GetAllServiceStates(undefined),
              ["StackUnavailableError"],
              unavailable,
            ).pipe(Effect.map((states) => states.map((state) => new StackServiceState(state)))),
          stateChanges: (name: string) =>
            fastCall(
              "GetServiceState",
              client.GetServiceState({ name }),
              ["StackUnavailableError", "ServiceNotFoundError"],
              (e): e is StackUnavailableError | ServiceNotFoundError =>
                unavailable(e) || notFound(e),
            ).pipe(
              Effect.as(
                client.WatchServiceStates({ name }).pipe(
                  Stream.map((state) => new StackServiceState(state)),
                  Stream.mapError(
                    allowedError(
                      endpoint,
                      "WatchServiceStates",
                      ["StackUnavailableError", "ServiceNotFoundError"],
                      (e): e is StackUnavailableError | ServiceNotFoundError =>
                        unavailable(e) || notFound(e),
                    ),
                  ),
                ),
              ),
            ),
          allStateChanges: () =>
            client.WatchServiceStates({}).pipe(
              Stream.map((state) => new StackServiceState(state)),
              Stream.mapError(
                allowedError(
                  endpoint,
                  "WatchServiceStates",
                  ["StackUnavailableError"],
                  unavailable,
                ),
              ),
            ),
          waitReady: (name: string, opts) =>
            call(
              "WaitServiceReady",
              client.WaitServiceReady({ name, options: opts ?? inheritReadyOptions }),
              [
                "StackUnavailableError",
                "ServiceNotFoundError",
                "ServiceReadyError",
                "StackBuildError",
                "StackReadinessError",
              ],
              (
                e,
              ): e is
                | StackUnavailableError
                | ServiceNotFoundError
                | ServiceReadyError
                | StackBuildError
                | StackReadinessError =>
                unavailable(e) || notFound(e) || ready(e) || build(e) || readiness(e),
            ),
          waitAllReady: (opts) =>
            call(
              "WaitStackReady",
              client.WaitStackReady({ options: opts ?? inheritReadyOptions }),
              [
                "StackUnavailableError",
                "ServiceReadyError",
                "StackBuildError",
                "StackReadinessError",
              ],
              (
                e,
              ): e is
                | StackUnavailableError
                | ServiceReadyError
                | StackBuildError
                | StackReadinessError => unavailable(e) || ready(e) || build(e) || readiness(e),
            ),
          subscribeLogs: (name: string) =>
            client
              .WatchLogs({ name })
              .pipe(
                Stream.mapError(
                  allowedError(
                    endpoint,
                    "WatchLogs",
                    ["StackUnavailableError", "ServiceNotFoundError"],
                    (e): e is StackUnavailableError | ServiceNotFoundError =>
                      unavailable(e) || notFound(e),
                  ),
                ),
              ),
          subscribeAllLogs: (services) =>
            client
              .WatchLogs(services === undefined ? {} : { services })
              .pipe(
                Stream.mapError(
                  allowedError(
                    endpoint,
                    "WatchLogs",
                    ["StackUnavailableError", "ServiceNotFoundError"],
                    (e): e is StackUnavailableError | ServiceNotFoundError =>
                      unavailable(e) || notFound(e),
                  ),
                ),
              ),
          logHistory: (name: string, limit?: number) =>
            fastCall(
              "GetLogHistory",
              client.GetLogHistory(limit === undefined ? { name } : { name, limit }),
              ["StackUnavailableError", "ServiceNotFoundError"],
              (e): e is StackUnavailableError | ServiceNotFoundError =>
                unavailable(e) || notFound(e),
            ),
          logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) =>
            fastCall(
              "GetLogHistory",
              client.GetLogHistory({
                ...(limit === undefined ? {} : { limit }),
                ...(services === undefined ? {} : { services }),
              }),
              ["StackUnavailableError", "ServiceNotFoundError"],
              (e): e is StackUnavailableError | ServiceNotFoundError =>
                unavailable(e) || notFound(e),
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
  DaemonUpgradeRequired | StackBuildError | StackRpcTransportError | StackRpcProtocolError,
  HttpTransportClient
> =>
  Effect.scoped(
    makeRemoteRpcClient(endpoint, options).pipe(
      Effect.flatMap(({ client }) =>
        client.UpdateLaunch({ stackId, launch }).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchTag("TimeoutError", (cause) =>
            Effect.fail(transportError(endpoint, "UpdateLaunch", cause)),
          ),
        ),
      ),
      Effect.mapError((error) => {
        if (error instanceof DaemonUpgradeRequired) return error;
        const mapped = mapRpcError(error, endpoint, "UpdateLaunch", ["StackBuildError"]);
        if (
          mapped instanceof StackBuildError ||
          mapped instanceof StackRpcTransportError ||
          mapped instanceof StackRpcProtocolError
        )
          return mapped;
        return protocolError(
          endpoint,
          "UpdateLaunch",
          `Unexpected error ${knownErrorTag(error) ?? "unknown"}`,
          error,
        );
      }),
    ),
  );
