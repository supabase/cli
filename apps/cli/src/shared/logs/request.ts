import { operationDefinitions, type ApiClient } from "@supabase/api/effect";
import { Effect } from "effect";

export const requestLogs = Effect.fn("Logs.request")(function* (
  api: ApiClient,
  ref: string,
  sql: string,
  window: { readonly start: string; readonly end: string },
) {
  return yield* api.executeRaw(operationDefinitions.v1GetProjectLogs, {
    ref,
    sql,
    iso_timestamp_start: window.start,
    iso_timestamp_end: window.end,
  });
});
