import { Context, Data, Effect, Layer } from "effect";
import {
  CONTROL_STATUS_PATH,
  CONTROL_STOP_PATH,
  ControlProtocolError,
  ControlStopConflictError,
  ControlMaintenanceBusyError,
  ControlTransportError,
  makeControlClient,
  type ControlClientShape,
  type ControlClientTransport,
  type ControlEndpoint,
} from "./managed/control.ts";
import { errorCode } from "./error-code.ts";

export class HttpTransportClientError extends Data.TaggedError("HttpTransportClientError")<{
  readonly endpoint: ControlEndpoint;
  readonly path: string;
  readonly cause: unknown;
  readonly reason: "transport" | "status" | "protocol";
}> {}

export class HttpTransportClient extends Context.Service<
  HttpTransportClient,
  {
    readonly request: (
      endpoint: ControlEndpoint,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<Response, HttpTransportClientError>;
  }
>()("stack/HttpTransportClient") {}

export const httpTransportClientLayer = Layer.succeed(HttpTransportClient, {
  request: (endpoint, path, init) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`${endpoint.url}${path}`, {
          ...init,
          signal:
            init?.signal === undefined || init.signal === null
              ? signal
              : AbortSignal.any([signal, init.signal]),
        }),
      catch: (cause) =>
        new HttpTransportClientError({ endpoint, path, cause, reason: "transport" }),
    }),
});

const CONTROL_REQUEST_TIMEOUT_MS = 500;

const controlTransportError = (
  endpoint: ControlEndpoint,
  cause: HttpTransportClientError,
): ControlTransportError =>
  new ControlTransportError({
    endpoint,
    reason:
      errorCode(cause) === "ECONNREFUSED" || errorCode(cause) === "ConnectionRefused"
        ? "unreachable"
        : "transport",
    cause,
  });

const consumeControlResponse = (
  endpoint: ControlEndpoint,
  response: Response,
): Effect.Effect<void, ControlTransportError> =>
  Effect.tryPromise({
    try: () =>
      (response.body === null ? Promise.resolve() : response.arrayBuffer()).then(() => undefined),
    catch: (cause) => new ControlTransportError({ endpoint, reason: "transport", cause }),
  });

const makeHttpControlTransport = (
  transport: HttpTransportClient["Service"],
): ControlClientTransport => ({
  read: (endpoint) =>
    Effect.suspend(() =>
      transport.request(endpoint, CONTROL_STATUS_PATH, {
        method: "GET",
        headers: { connection: "close" },
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      }),
    ).pipe(
      Effect.mapError((cause) => controlTransportError(endpoint, cause)),
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) => new ControlProtocolError({ endpoint, cause }),
            })
          : Effect.fail(new ControlProtocolError({ endpoint, cause: response.status })),
      ),
    ),
  requestStop: (endpoint, request) =>
    Effect.suspend(() =>
      transport.request(endpoint, CONTROL_STOP_PATH, {
        method: "POST",
        body: JSON.stringify(request),
        headers: { "content-type": "application/json", connection: "close" },
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      }),
    ).pipe(
      Effect.mapError((cause) => controlTransportError(endpoint, cause)),
      Effect.flatMap((response) =>
        consumeControlResponse(endpoint, response).pipe(Effect.as(response)),
      ),
      Effect.flatMap(
        (
          response,
        ): Effect.Effect<
          void,
          | ControlTransportError
          | ControlProtocolError
          | ControlStopConflictError
          | ControlMaintenanceBusyError
        > => {
          if (response.ok) return Effect.void;
          if (response.status === 409)
            return Effect.fail(new ControlStopConflictError({ endpoint }));
          if (response.status === 423)
            return Effect.fail(new ControlMaintenanceBusyError({ endpoint }));
          // A stop response can be lost after the daemon accepts the request
          // (for example while it closes its listener). Treat every non-409
          // HTTP status as ambiguous transport, matching the platform
          // transports so callers can observe the fenced owner session.
          return Effect.fail(
            controlTransportError(
              endpoint,
              new HttpTransportClientError({
                endpoint,
                path: CONTROL_STOP_PATH,
                cause: response.status,
                reason: "status",
              }),
            ),
          );
        },
      ),
    ),
});

/** Stable control client backed by the shared HTTP transport service. */
export const makeHttpControlClient = (
  transport: HttpTransportClient["Service"],
): ControlClientShape => makeControlClient(makeHttpControlTransport(transport));
