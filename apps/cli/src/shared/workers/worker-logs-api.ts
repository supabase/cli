import { operationDefinitions, type ApiClient } from "@supabase/api/effect";
import { Effect, Option, Predicate, Schema } from "effect";
import { decodeBody, mapRequestError, unexpectedStatus } from "./workers-api-status.ts";
import {
  WorkerLogsQueryFailedError,
  WorkerLogsRateLimitedError,
  WorkerLogsUsageExceededError,
  WorkersUnavailableError,
} from "./workers.errors.ts";
import { workerLogsQuery } from "./worker-logs.sql.ts";

/**
 * Reading a worker's logs, over the project's unified logs stream:
 * `GET /v1/projects/{ref}/analytics/endpoints/logs`.
 *
 * Not `/v2/projects/{ref}/workers/...` like the rest of the family — there is no
 * worker-scoped log route — so this is the one Workers seam that talks to the
 * analytics API, and the one that has to reckon with its two quirks: the query is
 * SQL this CLI writes, and a failed query can arrive as **HTTP 200 with an
 * `error` field**.
 */

/** One log line, flattened out of the untyped `result` array. */
export interface WorkerLogEntry {
  /** Logflare-minted. The dedupe key for an overlapping-window poll. */
  readonly id: string;
  /** Epoch milliseconds. Order on this — guest lines arrive out of order. */
  readonly timestampMs: number;
  /**
   * Display text only, never a parse target. On the guest stream it is
   * tenant-controlled bytes and must be escaped before it reaches a terminal.
   */
  readonly message: string;
  /** `worker_guest_logs` | `worker_ingress_logs` | `worker_api_logs`, or newer. */
  readonly stream: string;
  /**
   * `log_attributes`, which is a `Map(String, String)` — so `status` arrives as
   * `"200"` and `duration_ms` as `"23"`. Coerce before comparing.
   */
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * The row shape the projection in `workerLogsQuery` produces.
 *
 * `stream` stays a plain string and `log_attributes` an open record because the
 * log contract is additive-only: a new stream or a new attribute must render,
 * not fail the whole read. A closed `Schema.Literal` union here would break the
 * command the next time a stream is added.
 */
const WorkerLogRow = Schema.Struct({
  id: Schema.String,
  ts_ms: Schema.Number,
  stream: Schema.String,
  event_message: Schema.String,
  log_attributes: Schema.Record(Schema.String, Schema.String),
});

/** The endpoint's structured error shape, when it is not a bare string. */
const StructuredLogError = Schema.Struct({
  message: Schema.String,
});

/**
 * The response envelope, declared here rather than reusing the generated
 * `V1GetProjectLogsOutput`.
 *
 * The generated schema is `optionalKey` on both fields but allows neither to be
 * `null` — while the endpoint sends exactly `{"result":[...],"error":null}` on
 * success and `{"result":null,"error":"..."}` on failure, because
 * `getAnalyticsResponse` normalises the unused half to an explicit `null`. Decoding
 * a real response against the generated schema therefore always fails.
 *
 * `error` stays `Unknown` so the string and structured forms are both accepted and
 * narrowed at the point of use; the generated struct also marks fields required
 * that real bodies omit.
 */
const LogsResponse = Schema.Struct({
  result: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  error: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
});

/**
 * Renders the endpoint's `error` field, which is `string | {code, errors[], message, status}`.
 *
 * Narrowed through the schema rather than a `typeof` chain so the structured
 * shape is checked rather than assumed.
 */
const describeLogError = Effect.fnUntraced(function* (error: unknown) {
  if (Predicate.isString(error)) {
    return error;
  }
  const structured = yield* Schema.decodeUnknownEffect(StructuredLogError)(error).pipe(
    Effect.option,
  );
  return Option.isSome(structured) ? structured.value.message : JSON.stringify(error);
});

export const fetchWorkerLogs = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  options: {
    readonly name: string;
    readonly streams: ReadonlyArray<string>;
    readonly tail: number;
    /** Both bounds, always — see `logWindow`. */
    readonly window: { readonly start: string; readonly end: string };
  },
) {
  const operation = `read logs for worker "${options.name}"`;
  const sql = workerLogsQuery({
    name: options.name,
    streams: options.streams,
    tail: options.tail,
  });

  const response = yield* api
    .executeRaw(operationDefinitions.v1GetProjectLogs, {
      ref: projectRef,
      sql,
      iso_timestamp_start: options.window.start,
      iso_timestamp_end: options.window.end,
    })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 402) {
    return yield* Effect.fail(
      new WorkerLogsUsageExceededError({
        detail: `The log query allowance for project ${projectRef} is exhausted.`,
        suggestion: "Enable additional usage for this project in the dashboard, then retry.",
      }),
    );
  }
  // The analytics endpoints allow 10 requests per 60 seconds, which is well
  // inside what a tight `--follow` poll would spend.
  if (response.status === 429) {
    return yield* Effect.fail(
      new WorkerLogsRateLimitedError({
        detail: "The logs API is rate limiting this project (10 requests per minute).",
        suggestion: "Wait a minute before retrying, and avoid running several tails at once.",
      }),
    );
  }
  // The route gates on the same private-alpha allow-list as the rest of the
  // family, and answers 404 for a project outside it.
  if (response.status === 404) {
    return yield* Effect.fail(
      new WorkersUnavailableError({
        detail: `Logs are not available for project ${projectRef}.`,
        suggestion:
          "Workers are in private alpha. Ask in the Supabase dashboard to have this project enrolled.",
      }),
    );
  }
  if (response.status !== 200) {
    // A rejected query or the server's 30-second timeout lands here rather than
    // in the 200-with-`error` branch below, so both paths have to exist.
    return yield* unexpectedStatus({
      operation,
      status: response.status,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
  }

  const body = yield* response.json.pipe(Effect.mapError(mapRequestError(operation)));
  const decoded = yield* decodeBody(LogsResponse, operation, body, response.status);

  // Checked before `result`: this endpoint reports a failed query with a 200 and
  // a populated `error`, so reading `result` first reports success on a failure.
  if (decoded.error !== undefined && decoded.error !== null) {
    const described = yield* describeLogError(decoded.error);
    return yield* Effect.fail(
      new WorkerLogsQueryFailedError({
        detail: `The logs API could not run this query: ${described}.`,
        suggestion: "Retry shortly; if it persists, report it with `supabase issue`.",
      }),
    );
  }

  // `result` is optional in the contract, so absent, null and [] all mean "no
  // rows" and must not be told apart.
  const rows = decoded.result ?? [];
  const entries: Array<WorkerLogEntry> = [];
  for (const row of rows) {
    const parsed = yield* decodeBody(WorkerLogRow, operation, row, response.status);
    entries.push({
      id: parsed.id,
      timestampMs: parsed.ts_ms,
      message: parsed.event_message,
      stream: parsed.stream,
      attributes: parsed.log_attributes,
    });
  }

  // The query orders `desc` to make `limit` mean "the most recent N". Sorting
  // here rather than trusting that order: guest lines are ingested late and out
  // of order, and once `--follow` merges overlapping windows the server's order
  // stops being meaningful at all.
  return entries.sort((left, right) => left.timestampMs - right.timestampMs);
});
