import { Context, Data, Effect } from "effect";

type ProxyWebSocketData = string | Uint8Array;

export interface ProxyWebSocket {
  readonly send: (data: ProxyWebSocketData) => Effect.Effect<void, ProxyWebSocketError>;
  readonly close: (code?: number, reason?: string) => void;
  readonly onMessage: (listener: (data: ProxyWebSocketData) => void) => () => void;
  readonly onClose: (listener: (code: number, reason: string) => void) => () => void;
  readonly onError: (listener: (cause: unknown) => void) => () => void;
}

export interface ProxyWebSocketConnectOptions {
  readonly url: string;
  readonly host: string;
  readonly protocols?: ReadonlyArray<string>;
}

export class ProxyWebSocketError extends Data.TaggedError("ProxyWebSocketError")<{
  readonly operation: "connect" | "send";
  readonly cause: unknown;
}> {}

export class ProxyWebSocketConnector extends Context.Service<
  ProxyWebSocketConnector,
  {
    readonly connect: (
      options: ProxyWebSocketConnectOptions,
    ) => Effect.Effect<ProxyWebSocket, ProxyWebSocketError>;
  }
>()("stack/ProxyWebSocketConnector") {}
