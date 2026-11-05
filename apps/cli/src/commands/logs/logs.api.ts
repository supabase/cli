import { requestLogs } from "../../shared/logs/request.ts";
import { type ApiClient } from "@supabase/api/effect";
import { Clock, Effect, Schema } from "effect";
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
  const response = yield* requestLogs(api, ref, sql, window);
  const retryAfter = response.headers["retry-after"];
  const retryAfterMs =
    retryAfter === undefined
      ? undefined
      : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - (yield* Clock.currentTimeMillis);
  if (response.status !== 200)
    return yield* new LogsApiError({
      status: response.status,
      ...(response.status === 429 && retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
        ? { retryAfterMs: Math.max(0, retryAfterMs) }
        : {}),
      message:
        response.status === 401
          ? "The logs API rejected your credentials (HTTP 401). Run supabase login and retry."
          : response.status === 403
            ? "The logs API denied access (HTTP 403). Check that your account or token has permission to read this project's logs."
            : response.status === 402
              ? "The logs API usage limit was reached (HTTP 402). Check your organization's log usage limits and billing settings in the Dashboard."
              : response.status === 429
                ? "The logs API rate limit was reached. Wait before retrying."
                : `The logs API returned HTTP ${response.status}.`,
    });
  const body = yield* response.json.pipe(
    Effect.mapError(
      () =>
        new LogsApiError({
          message: "The logs API returned invalid JSON.",
          status: response.status,
          reason: "response",
        }),
    ),
  );
  const decoded = yield* Schema.decodeUnknownEffect(envelope)(body).pipe(
    Effect.mapError(
      () =>
        new LogsApiError({
          message: "The logs API returned an unreadable response.",
          status: response.status,
          reason: "response",
        }),
    ),
  );
  if (decoded.error !== undefined && decoded.error !== null)
    return yield* new LogsApiError({
      message: `The logs API could not run this query: ${yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(decoded.error)}`,
      status: response.status,
      reason: "query",
    });
  return decoded.result ?? [];
});
