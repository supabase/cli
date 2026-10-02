import { Effect, Option, Schema, Scope, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { openWebSocket } from "./websocket.ts";

const MailRecipient = Schema.Struct({ Address: Schema.String });
const MailEvent = Schema.Struct({
  Type: Schema.Literal("new"),
  Data: Schema.Struct({ ID: Schema.String, To: Schema.Array(MailRecipient) }),
});
const MailEventEnvelope = Schema.Struct({ Type: Schema.String, Data: Schema.Unknown });

const MailMessage = Schema.Struct({
  ID: Schema.String,
  To: Schema.Array(MailRecipient),
  Subject: Schema.optionalKey(Schema.String),
  Text: Schema.optionalKey(Schema.String),
  HTML: Schema.optionalKey(Schema.String),
});

type MailMessage = Schema.Schema.Type<typeof MailMessage>;

class MailProbeError extends Schema.TaggedError<MailProbeError>()("MailProbeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

const errorFor = (cause: unknown) =>
  new MailProbeError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const eventsUrl = (url: string) => {
  const value = new URL(url);
  value.protocol = value.protocol === "https:" ? "wss:" : "ws:";
  value.pathname = "/api/events";
  value.search = "";
  return value.toString();
};

export interface RecoveryMailWatcher {
  readonly awaitFullMail: Effect.Effect<MailMessage, MailProbeError, HttpClient.HttpClient>;
}

export const watchRecoveryMail = Effect.fn("WholeStack.watchRecoveryMail")(
  (
    mailUrl: string,
    email: string,
  ): Effect.Effect<RecoveryMailWatcher, MailProbeError, Scope.Scope> =>
    Effect.gen(function* () {
      const channel = yield* openWebSocket(eventsUrl(mailUrl)).pipe(Effect.mapError(errorFor));
      return {
        awaitFullMail: Stream.fromQueue(channel.messages).pipe(
          Stream.mapError(errorFor),
          Stream.mapEffect((value) =>
            Schema.decodeEffect(Schema.fromJsonString(MailEventEnvelope))(value).pipe(
              Effect.mapError(errorFor),
            ),
          ),
          Stream.filter((event) => event.Type === "new"),
          Stream.mapEffect((event) =>
            Schema.decodeUnknownEffect(MailEvent)(event).pipe(Effect.mapError(errorFor)),
          ),
          Stream.filter((event) => event.Data.To.some((recipient) => recipient.Address === email)),
          Stream.runHead,
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(new MailProbeError({ message: "Mail event stream ended" })),
          ),
          Effect.flatMap((event) =>
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              const response = yield* client
                .execute(HttpClientRequest.get(`${mailUrl}/api/v1/message/${event.Data.ID}`))
                .pipe(Effect.mapError(errorFor));
              return yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(MailMessage)),
                Effect.mapError(errorFor),
              );
            }),
          ),
        ),
      };
    }),
);
