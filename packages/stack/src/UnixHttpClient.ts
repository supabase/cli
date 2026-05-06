import { Data, Effect, ServiceMap } from "effect";

export class UnixHttpClientError extends Data.TaggedError("UnixHttpClientError")<{
  readonly socketPath: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class UnixHttpClient extends ServiceMap.Service<
  UnixHttpClient,
  {
    readonly request: (
      socketPath: string,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<Response, UnixHttpClientError>;
  }
>()("stack/UnixHttpClient") {}
