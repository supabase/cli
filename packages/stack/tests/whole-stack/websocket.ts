import { Deferred, Effect, Queue, Schedule, Schema, Scope } from "effect";
import { NodeSocket } from "@effect/platform-node";
import * as Socket from "effect/unstable/socket/Socket";

class RealtimeProbeError extends Schema.TaggedError<RealtimeProbeError>()("RealtimeProbeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export class WebSocketChannelError extends Schema.TaggedError<WebSocketChannelError>()(
  "WebSocketChannelError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) },
) {}

export interface WebSocketChannel {
  readonly messages: Queue.Queue<string, WebSocketChannelError>;
  readonly send: (message: string) => Effect.Effect<void, WebSocketChannelError>;
}

const RealtimeMessage = Schema.Struct({
  event: Schema.String,
  payload: Schema.Unknown,
  topic: Schema.optionalKey(Schema.String),
});
type RealtimeMessage = Schema.Schema.Type<typeof RealtimeMessage>;

const RealtimeChange = Schema.Struct({
  event: Schema.Literal("postgres_changes"),
  payload: Schema.Struct({ data: Schema.Unknown }),
  topic: Schema.String,
});

type RealtimeChange = Schema.Schema.Type<typeof RealtimeChange>;

interface RealtimeSubscription {
  readonly nextChange: Effect.Effect<RealtimeChange, RealtimeProbeError>;
}

const errorFor = (cause: unknown) =>
  new RealtimeProbeError({
    message: String(cause),
    cause,
  });

const channelError = (cause: unknown) =>
  new WebSocketChannelError({
    message: String(cause),
    cause,
  });

export const openWebSocket = Effect.fn("WholeStack.openWebSocket")(
  (url: string): Effect.Effect<WebSocketChannel, WebSocketChannelError, Scope.Scope> =>
    Effect.gen(function* () {
      const messages = yield* Queue.unbounded<string, WebSocketChannelError>();
      const ready = yield* Deferred.make<void, Socket.SocketError>();
      const socket = yield* Socket.makeWebSocket(url, { openTimeout: "60 seconds" }).pipe(
        Effect.provide(NodeSocket.layerWebSocketConstructorWS),
      );
      yield* socket
        .runString((message) => Queue.offer(messages, message), {
          onOpen: Deferred.succeed(ready, undefined),
        })
        .pipe(
          Effect.catch((cause: Socket.SocketError) =>
            Effect.all([
              Deferred.fail(ready, cause),
              Queue.fail(messages, channelError(cause)),
            ]).pipe(Effect.asVoid),
          ),
          Effect.andThen(
            Queue.fail(messages, new WebSocketChannelError({ message: "WebSocket closed" })).pipe(
              Effect.asVoid,
            ),
          ),
          Effect.forkScoped,
        );
      yield* Deferred.await(ready).pipe(Effect.mapError(channelError));
      const writer = yield* socket.writer;
      return {
        messages,
        send: (message) => writer(message).pipe(Effect.mapError(channelError)),
      };
    }),
);

const websocketUrl = (url: string, token: string) => {
  const value = new URL(url);
  value.protocol = value.protocol === "https:" ? "wss:" : "ws:";
  value.pathname = "/realtime/v1/websocket";
  value.search = new URLSearchParams({ apikey: token, vsn: "1.0.0" }).toString();
  return value.toString();
};

const decodeMessage = (value: string) =>
  Schema.decodeEffect(Schema.fromJsonString(RealtimeMessage))(value).pipe(
    Effect.mapError(errorFor),
  );

const waitsFor = <A extends RealtimeMessage>(
  messages: Queue.Queue<string, WebSocketChannelError>,
  predicate: (message: RealtimeMessage) => message is A,
) =>
  Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(messages).pipe(
        Effect.mapError(errorFor),
        Effect.flatMap(decodeMessage),
      );
      if (predicate(message)) return message;
    }
  });

const waitForHandshake = (
  messages: Queue.Queue<string, WebSocketChannelError>,
): Effect.Effect<void, RealtimeProbeError> =>
  Effect.gen(function* () {
    let joined = false;
    let subscribed = false;
    while (!joined || !subscribed) {
      const message = yield* Queue.take(messages).pipe(
        Effect.mapError(errorFor),
        Effect.flatMap(decodeMessage),
      );
      if (
        message.event === "phx_reply" &&
        typeof message.payload === "object" &&
        message.payload !== null
      )
        joined = "status" in message.payload && message.payload.status === "ok";
      if (
        message.event === "system" &&
        typeof message.payload === "object" &&
        message.payload !== null
      )
        subscribed =
          "status" in message.payload &&
          message.payload.status === "ok" &&
          "extension" in message.payload &&
          message.payload.extension === "postgres_changes";
    }
  });

const isRealtimeChange = (message: RealtimeMessage): message is RealtimeChange =>
  Schema.is(RealtimeChange)(message);

export const subscribeRealtime = Effect.fn("WholeStack.subscribeRealtime")(
  (
    url: string,
    token: string,
    table: string,
    event: "INSERT" | "UPDATE",
  ): Effect.Effect<RealtimeSubscription, RealtimeProbeError, Scope.Scope> =>
    Effect.gen(function* () {
      const channel = yield* openWebSocket(websocketUrl(url, token)).pipe(
        Effect.mapError(errorFor),
      );
      const topic = `realtime:public:${table}`;
      const joinMessage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        topic,
        event: "phx_join",
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: "" },
            postgres_changes: [{ event, schema: "public", table }],
          },
          access_token: token,
        },
        ref: "1",
      }).pipe(Effect.mapError(errorFor));
      yield* channel.send(joinMessage).pipe(Effect.mapError(errorFor));
      yield* waitForHandshake(channel.messages).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(errorFor),
      );
      const heartbeat = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        topic: "phoenix",
        event: "heartbeat",
        payload: {},
        ref: "heartbeat",
      }).pipe(Effect.mapError(errorFor));
      yield* channel
        .send(heartbeat)
        .pipe(
          Effect.mapError(errorFor),
          Effect.repeat(Schedule.spaced("20 seconds")),
          Effect.forkScoped,
        );
      return {
        nextChange: waitsFor(channel.messages, isRealtimeChange).pipe(
          Effect.flatMap((message) =>
            Schema.decodeEffect(RealtimeChange)(message).pipe(Effect.mapError(errorFor)),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError(errorFor),
        ),
      };
    }),
);
