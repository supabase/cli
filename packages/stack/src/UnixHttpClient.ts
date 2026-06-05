import { Data, Effect, Context } from "effect";

export class UnixHttpClientError extends Data.TaggedError("UnixHttpClientError")<{
  readonly socketPath: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class UnixHttpClient extends Context.Service<
  UnixHttpClient,
  {
    readonly request: (
      socketPath: string,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<Response, UnixHttpClientError>;
  }
>()("stack/UnixHttpClient") {}
