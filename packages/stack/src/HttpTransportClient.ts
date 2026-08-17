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
      try: () =>
        fetch(`${endpoint.url}${path}`, {
          ...init,
          signal:
            init?.signal == null
              ? AbortSignal.timeout(30_000)
              : AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]),
        }),
      catch: (cause) =>
        new HttpTransportClientError({ endpoint, path, cause, reason: "transport" }),
    }),
});
