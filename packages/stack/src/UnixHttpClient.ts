import { Data, Effect, Context } from "effect";

interface LoopbackHttpEndpoint {
  readonly _tag: "Loopback";
  readonly hostname: string;
  readonly port: number;
  readonly url?: string;
}

export type HttpTransportTarget = string | LoopbackHttpEndpoint;

export class UnixHttpClientError extends Data.TaggedError("UnixHttpClientError")<{
  readonly socketPath: HttpTransportTarget;
  readonly path: string;
  readonly cause: unknown;
  readonly reason: "transport" | "status" | "protocol";
}> {}

export class UnixHttpClient extends Context.Service<
  UnixHttpClient,
  {
    readonly request: (
      socketPath: HttpTransportTarget,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<Response, UnixHttpClientError>;
  }
>()("stack/UnixHttpClient") {}
