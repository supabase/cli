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
        // The 30s deadline is a hang guard for one-shot requests only. A
        // caller-provided signal opts out of it: long-lived requests (SSE
        // streams, the blocking /start | /ready | /stop long-polls) legitimately
        // stay quiet for minutes on a cold image cache, and their lifetime is
        // governed by Effect interruption through that signal instead.
        fetch(`${endpoint.url}${path}`, {
          ...init,
          signal: init?.signal == null ? AbortSignal.timeout(30_000) : init.signal,
        }),
      catch: (cause) =>
        new HttpTransportClientError({ endpoint, path, cause, reason: "transport" }),
    }),
});
