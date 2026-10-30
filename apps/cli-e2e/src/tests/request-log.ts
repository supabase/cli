import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const RequestEntry = Schema.Struct({
  method: Schema.String,
  pathname: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Unknown,
});

/** The requests the replay server received since the last test cleared its log. */
export const getRequestLog = Effect.fnUntraced(function* (apiUrl: string) {
  const res = yield* HttpClient.get(`${apiUrl}/_ctrl/requests`);
  return yield* HttpClientResponse.schemaBodyJson(Schema.Array(RequestEntry))(res);
});
