import { Effect, Option, Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { mapHttpError } from "../../command-internal/http-errors.ts";
import { TracesNetworkError, TracesUnexpectedStatusError } from "./traces.errors.ts";

/** A trace span as the endpoint returns it: a JSON:API resource keyed by span id. */
const TraceSpanResource = Schema.Struct({
  type: Schema.Literals(["span"]),
  id: Schema.String,
  attributes: Schema.Struct({
    parent_span_id: Schema.NullOr(Schema.String),
    service_name: Schema.String,
    span_name: Schema.String,
    span_kind: Schema.String,
    status_code: Schema.String,
    start_time: Schema.String,
    duration_ns: Schema.Finite,
  }),
});

export type TraceSpanResource = typeof TraceSpanResource.Type;

const ListSpansResponse = Schema.Struct({
  data: Schema.Array(TraceSpanResource),
  meta: Schema.Struct({ partial: Schema.Boolean }),
});

const decodeListSpansResponse = Schema.decodeUnknownEffect(ListSpansResponse);

const mapTracesError = mapHttpError({
  networkError: TracesNetworkError,
  statusError: TracesUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve trace: ${cause}`,
  statusMessage: (status, body) =>
    status === 404 ? "project not found" : `failed to retrieve trace; received: ${body}`,
});

const resolveStoredToken = Effect.fn("Traces.resolveStoredToken")(function* () {
  const cliSettings = yield* CommandSettings;
  if (Option.isSome(cliSettings.accessToken)) return cliSettings.accessToken.value;
  const credentials = yield* CommandCredentials;
  const token = yield* credentials.getAccessToken;
  if (Option.isSome(token)) return token.value;
  // managementApiRuntimeLayer already built CommandPlatformApi, which fails the whole command
  // before this runs when no access token is configured.
  return yield* Effect.die(
    new Error("Traces.fetchSpans: no access token after CommandPlatformApi build"),
  );
});

/**
 * Fetches a trace's spans from the Management API's `v2-get-trace` operation
 * (`GET /v2/projects/:ref/analytics/traces/:trace_id`). The route exists and is live, but is
 * excluded from the generated OpenAPI spec for now, so `packages/api` has no typed operation for
 * it; this hand-written request stands in until that changes. An empty `data` array is a 200, not
 * a 404 — the caller decides what "not found" means.
 */
export const fetchTraceSpans = Effect.fn("Traces.fetchSpans")(function* (
  ref: string,
  traceId: string,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const cliSettings = yield* CommandSettings;
  const token = yield* resolveStoredToken();

  // oxlint-disable-next-line supabase/no-raw-management-api-url -- excluded from the OpenAPI spec, so no typed operation exists
  const url = `${cliSettings.apiUrl}/v2/projects/${encodeURIComponent(ref)}/analytics/traces/${encodeURIComponent(traceId)}`;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
    HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
  );

  return yield* Effect.gen(function* () {
    const response = yield* httpClient.execute(request);
    const body = yield* response.json;
    return yield* decodeListSpansResponse(body);
  }).pipe(Effect.catch(mapTracesError));
});
