import { operationDefinitions, type ApiClient } from "@supabase/api/effect";
import { Effect, Schema } from "effect";
import { LogsApiError } from "./logs.errors.ts";

const envelope = Schema.Struct({
  result: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.JsonObject))),
  error: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
});

export const queryLogs = Effect.fn("Logs.query")(function* (
  api: ApiClient,
  ref: string,
  sql: string,
  window: { readonly start: string; readonly end: string },
) {
  const response = yield* api
    .executeRaw(operationDefinitions.v1GetProjectLogs, {
      ref,
      sql,
      iso_timestamp_start: window.start,
      iso_timestamp_end: window.end,
    })
    .pipe(
      Effect.mapError(
        () => new LogsApiError({ message: "Could not reach the logs API.", status: 503 }),
      ),
    );
  if (response.status !== 200)
    return yield* new LogsApiError({
      status: response.status,
      message:
        response.status === 429
          ? "The logs API rate limit was reached. Wait before retrying."
          : `The logs API returned HTTP ${response.status}.`,
    });
  const body = yield* response.json.pipe(
    Effect.mapError(
      () => new LogsApiError({ message: "The logs API returned invalid JSON.", status: 502 }),
    ),
  );
  const decoded = yield* Schema.decodeUnknownEffect(envelope)(body).pipe(
    Effect.mapError(
      () =>
        new LogsApiError({ message: "The logs API returned an unreadable response.", status: 502 }),
    ),
  );
  if (decoded.error !== undefined && decoded.error !== null)
    return yield* new LogsApiError({
      message: `The logs API could not run this query: ${yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(decoded.error)}`,
      status: 400,
    });
  return decoded.result ?? [];
});
