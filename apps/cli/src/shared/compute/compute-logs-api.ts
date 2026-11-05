import { requestLogs } from "../logs/request.ts";
import { type ApiClient } from "@supabase/api/effect";
import { Effect, Option, Predicate, Schema } from "effect";
import {
  bodyText,
  decodeBody,
  decodeJsonBody,
  hasErrorCode,
  mapRequestError,
  parse404,
  projectNotFound,
  unexpectedStatus,
  unroutedPath,
} from "./compute-api-status.ts";
import {
  ComputeLogsQueryFailedError,
  ComputeLogsRateLimitedError,
  ComputeLogsUsageExceededError,
  ComputeRouteNotFoundError,
  ComputeUnavailableError,
} from "./compute.errors.ts";
import { computeLogsQuery } from "./compute-logs.sql.ts";

export interface ComputeLogEntry {
  readonly id: string;

  readonly timestampMs: number;

  readonly message: string;

  readonly stream: string;

  readonly attributes: Readonly<Record<string, string>>;
}

const MAX_DATE_MS = 8_640_000_000_000_000;

const ComputeLogRow = Schema.Struct({
  id: Schema.String,
  ts_ms: Schema.Finite.pipe(
    Schema.check(
      Schema.isGreaterThanOrEqualTo(-MAX_DATE_MS),
      Schema.isLessThanOrEqualTo(MAX_DATE_MS),
    ),
  ),
  stream: Schema.String,
  event_message: Schema.String,
  log_attributes: Schema.Record(Schema.String, Schema.String),
});

const StructuredLogError = Schema.Struct({
  message: Schema.String,
});

const LogsResponse = Schema.Struct({
  result: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  error: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
});

const describeLogError = Effect.fnUntraced(function* (error: unknown) {
  if (Predicate.isString(error)) {
    return error;
  }
  const structured = yield* Schema.decodeUnknownEffect(StructuredLogError)(error).pipe(
    Effect.option,
  );
  if (Option.isSome(structured)) return structured.value.message;
  return yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(error).pipe(
    Effect.orElseSucceed(() => "Unknown server error"),
  );
});

export const fetchComputeLogs = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  options: {
    readonly name: string;
    readonly streams: ReadonlyArray<string>;
    readonly tail: number;

    readonly window: { readonly start: string; readonly end: string };
  },
) {
  const operation = `read logs for compute "${options.name}"`;
  const sql = computeLogsQuery({
    name: options.name,
    streams: options.streams,
    tail: options.tail,
  });

  const response = yield* requestLogs(api, projectRef, sql, options.window).pipe(
    Effect.mapError(mapRequestError(operation)),
  );
  if (response.status === 402) {
    return yield* new ComputeLogsUsageExceededError({
      detail: `The log query allowance for project ${projectRef} is exhausted.`,
      suggestion: "Enable additional usage for this project in the dashboard, then retry.",
    });
  }

  if (response.status === 429) {
    return yield* new ComputeLogsRateLimitedError({
      detail: "The logs API is rate limiting this project (10 requests per minute).",
      suggestion: "Wait a minute before retrying, and avoid running several tails at once.",
    });
  }

  if (response.status === 404) {
    const parsed = yield* parse404(yield* bodyText(response));
    const route = unroutedPath(parsed);

    if (Option.isSome(route)) {
      return yield* new ComputeRouteNotFoundError({
        detail: `The Management API does not serve ${route.value}, so this CLI cannot read logs for project ${projectRef}.`,
        suggestion: "Report it with `supabase issue`, including the route named above.",
      });
    }
    if (hasErrorCode(parsed, "not_found")) {
      return yield* projectNotFound(projectRef);
    }
    return yield* new ComputeUnavailableError({
      detail: `Logs are not available for project ${projectRef}.`,
      suggestion: "Compute is in private alpha. Stay tuned for the public alpha coming soon.",
    });
  }
  if (response.status !== 200) {
    return yield* unexpectedStatus(operation, response);
  }

  const decoded = yield* decodeJsonBody(LogsResponse, operation, response);

  if (decoded.error !== undefined && decoded.error !== null) {
    const described = yield* describeLogError(decoded.error);
    return yield* new ComputeLogsQueryFailedError({
      detail: `The logs API could not run this query: ${described}.`,
      suggestion: "Retry shortly; if it persists, report it with `supabase issue`.",
    });
  }

  const rows = decoded.result ?? [];
  const entries: Array<ComputeLogEntry> = [];
  for (const row of rows) {
    const parsed = yield* decodeBody(ComputeLogRow, operation, row, response.status);
    entries.push({
      id: parsed.id,
      timestampMs: parsed.ts_ms,
      message: parsed.event_message,
      stream: parsed.stream,
      attributes: parsed.log_attributes,
    });
  }

  return entries.sort((left, right) => left.timestampMs - right.timestampMs);
});
