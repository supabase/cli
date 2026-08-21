import { Context, Data, Effect, Layer } from "effect";
import type { ControlEndpoint } from "./managed/control.ts";

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
      try: (effectSignal) => {
        const signals: AbortSignal[] = [effectSignal];
        if (init?.signal !== undefined && init.signal !== null) {
          signals.push(init.signal);
        } else {
          signals.push(AbortSignal.timeout(30_000));
        }
        return fetch(`${endpoint.url}${path}`, {
          ...init,
          // Effect.tryPromise aborts this signal when the request fiber is
          // interrupted. Keep caller cancellation and the transport timeout
          // in the same signal tree.
          signal: AbortSignal.any(signals),
        });
      },
      catch: (cause) =>
        new HttpTransportClientError({ endpoint, path, cause, reason: "transport" }),
    }),
});
