import { Clock, DateTime, Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const AnalyticsLog = Schema.Struct({
  event_message: Schema.String,
});

const AnalyticsQueryResponse = Schema.Struct({
  result: Schema.Array(AnalyticsLog),
});

const AnalyticsLogResponse = Schema.Struct({
  message: Schema.String,
});

class AnalyticsFlowError extends Schema.TaggedError<AnalyticsFlowError>()(
  "WholeStack.AnalyticsFlowError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Builds the Vector config used by the whole-stack Analytics flow. */
export const vectorAnalyticsConfig = (marker: string): string =>
  `sources:
  demo_logs:
    type: demo_logs
    format: json
    interval: 1
transforms:
  fixture_marker:
    type: remap
    inputs: [demo_logs]
    source: |
      .event_message = ${JSON.stringify(marker)}
      .message = ${JSON.stringify(marker)}
sinks:
  analytics:
    type: http
    inputs: [fixture_marker]
    uri: "${"${LOGFLARE_URL}"}/api/logs?source_name=postgres.logs"
    method: post
    encoding:
      codec: json
    request:
      headers:
        x-api-key: "${"${LOGFLARE_PRIVATE_ACCESS_TOKEN}"}"
    batch:
      max_events: 1
      timeout_secs: 1
    healthcheck: false
api:
  enabled: true
  address: "${"${VECTOR_API_ADDRESS}"}"
`;

const request = Effect.fn("WholeStack.analyticsRequest")(
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return yield* client.execute(request);
    }).pipe(Effect.mapError((cause) => new AnalyticsFlowError({ operation: "request", cause }))),
);

/** Sends one marker directly to Logflare, for separating API ingest from Vector ingest. */
const postAnalyticsMarker = Effect.fn("WholeStack.postAnalyticsMarker")(
  (analyticsUrl: string, apiKey: string, marker: string, timestampMillis: number) =>
    Effect.gen(function* () {
      const body = [{ event_message: marker, timestamp: timestampMillis * 1000 }];
      const bodyRequest = yield* HttpClientRequest.bodyJson(body)(
        HttpClientRequest.post(`${analyticsUrl}/api/logs?source_name=postgres.logs`),
      ).pipe(
        Effect.mapError((cause) => new AnalyticsFlowError({ operation: "encode-log", cause })),
      );
      const response = yield* request(
        HttpClientRequest.setHeader("x-api-key", apiKey)(bodyRequest),
      );
      if (response.status >= 400)
        return yield* new AnalyticsFlowError({
          operation: "post-log",
          cause: {
            status: response.status,
            body: yield* response.text,
            url: `${analyticsUrl}/api/logs?source_name=postgres.logs`,
          },
        });
      const decoded = yield* Schema.decodeUnknownEffect(AnalyticsLogResponse)(
        yield* response.json,
      ).pipe(
        Effect.mapError(
          (cause) => new AnalyticsFlowError({ operation: "decode-log-response", cause }),
        ),
      );
      if (decoded.message !== "Logged!")
        return yield* new AnalyticsFlowError({ operation: "post-log", cause: decoded.message });
    }),
);

/** Performs one exact-marker SQL query against Logflare's Postgres backend. */
export const queryAnalyticsMarker = Effect.fn("WholeStack.queryAnalyticsMarker")(
  (analyticsUrl: string, apiKey: string, marker: string, phaseStartedAtMillis: number) =>
    Effect.gen(function* () {
      const escapedMarker = marker.replaceAll("'", "''");
      const timestamp = DateTime.formatIso(DateTime.fromEpochSeconds(phaseStartedAtMillis / 1000))
        .replace("T", " ")
        .replace("Z", "");
      const sql =
        `select event_message from postgres.logs where event_message = '${escapedMarker}' ` +
        `and timestamp >= '${timestamp}'`;
      const response = yield* request(
        HttpClientRequest.get(`${analyticsUrl}/api/query?pg_sql=${encodeURIComponent(sql)}`).pipe(
          HttpClientRequest.setHeader("x-api-key", apiKey),
        ),
      );
      if (response.status >= 400)
        return yield* new AnalyticsFlowError({ operation: "query-log", cause: response.status });
      const rows = yield* Schema.decodeUnknownEffect(AnalyticsQueryResponse)(
        yield* response.json,
      ).pipe(
        Effect.mapError(
          (cause) => new AnalyticsFlowError({ operation: "decode-query-response", cause }),
        ),
        Effect.map((result) => result.result),
      );
      return rows;
    }),
);

const queryMarkerUntilVisible = Effect.fn("WholeStack.queryMarkerUntilVisible")(
  (analyticsUrl: string, apiKey: string, marker: string, phaseStartedAtMillis: number) =>
    queryAnalyticsMarker(analyticsUrl, apiKey, marker, phaseStartedAtMillis).pipe(
      Effect.flatMap((rows) =>
        rows.some((row) => row.event_message === marker)
          ? Effect.void
          : Effect.fail(new AnalyticsFlowError({ operation: "query-empty", cause: { marker } })),
      ),
      Effect.retry({
        schedule: Schedule.spaced("1 second"),
        while: (error) => Schema.is(AnalyticsFlowError)(error) && error.operation === "query-empty",
      }),
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(new AnalyticsFlowError({ operation: "query-timeout", cause: { marker } })),
      }),
    ),
);

/** Exercises direct and Vector Analytics ingestion for one whole-stack phase. */
export const exerciseAnalytics = Effect.fn("WholeStack.exerciseAnalytics")(
  (analyticsUrl: string, vectorUrl: string, apiKey: string, stackId: string, phase: string) =>
    Effect.gen(function* () {
      const phaseStartedAtMillis = yield* Clock.currentTimeMillis;
      const directMarker = `direct-${stackId}-${phase}-${phaseStartedAtMillis}`;
      const vectorMarker = `vector-${stackId}`;
      yield* postAnalyticsMarker(analyticsUrl, apiKey, directMarker, phaseStartedAtMillis);
      const vectorHealth = yield* request(HttpClientRequest.get(`${vectorUrl}/health`));
      yield* vectorHealth.text;
      if (vectorHealth.status >= 400)
        return yield* new AnalyticsFlowError({
          operation: "vector-health",
          cause: vectorHealth.status,
        });
      yield* Effect.all(
        [
          queryMarkerUntilVisible(analyticsUrl, apiKey, directMarker, phaseStartedAtMillis),
          queryMarkerUntilVisible(analyticsUrl, apiKey, vectorMarker, phaseStartedAtMillis),
        ],
        { concurrency: 2, discard: true },
      );
    }),
);
