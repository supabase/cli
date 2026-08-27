import { Effect } from "effect";
import { errorCode } from "./error-code.ts";
import {
  CONTROL_STOP_PATH,
  ControlMaintenanceBusyError,
  ControlStopConflictError,
  ControlTransportError,
  type ControlEndpoint,
  type ControlStopRequest,
} from "./managed/control.ts";

const isDefinitivelyUnreachable = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return code === "ECONNREFUSED" || code === "ConnectionRefused";
};

const consumeResponse = (
  endpoint: ControlEndpoint,
  response: Response,
): Effect.Effect<Response, ControlTransportError> =>
  Effect.tryPromise({
    try: () =>
      (response.body === null ? Promise.resolve() : response.arrayBuffer()).then(() => response),
    catch: (cause) => new ControlTransportError({ endpoint, reason: "transport", cause }),
  });

export const requestControlStop = (
  endpoint: ControlEndpoint,
  request: ControlStopRequest,
): Effect.Effect<
  void,
  ControlTransportError | ControlStopConflictError | ControlMaintenanceBusyError
> =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`http://${endpoint.hostname}:${endpoint.port}${CONTROL_STOP_PATH}`, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
        headers: {
          connection: "close",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      }),
    catch: (cause) =>
      new ControlTransportError({
        endpoint,
        reason: isDefinitivelyUnreachable(cause) ? "unreachable" : "transport",
        cause,
      }),
  }).pipe(
    Effect.flatMap((response) => consumeResponse(endpoint, response)),
    Effect.flatMap(
      (
        response,
      ): Effect.Effect<
        void,
        ControlTransportError | ControlStopConflictError | ControlMaintenanceBusyError
      > => {
        if (response.ok) return Effect.void;
        if (response.status === 409) return Effect.fail(new ControlStopConflictError({ endpoint }));
        if (response.status === 423)
          return Effect.fail(new ControlMaintenanceBusyError({ endpoint }));
        return Effect.fail(
          new ControlTransportError({
            endpoint,
            reason: "transport",
            cause: new Error(`Control stop request returned ${response.status}`),
          }),
        );
      },
    ),
  );
