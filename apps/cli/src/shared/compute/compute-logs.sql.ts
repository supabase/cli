import { DateTime } from "effect";

/**
 * The ClickHouse query `supabase compute logs` sends, and the two
 * literals it turns on.
 *
 * Pure — no Effect, no services — so the query text and the window arithmetic are
 * unit-testable without a stubbed API, and so the literals have exactly one home
 * if the log pipeline ever renames a stream.
 */

/**
 * The three streams that share the Compute Logflare source, keyed by the word the `--kind`
 * flag exposes (`worker_guest_logs` is internal; `app` is what a user means). Lives here
 * rather than in the command so the flag and the query cannot drift apart.
 */
export const COMPUTE_LOG_STREAMS = {
  app: "worker_guest_logs",
  requests: "worker_ingress_logs",
  builds: "worker_api_logs",
} as const;

export type ComputeLogKindChoice = keyof typeof COMPUTE_LOG_STREAMS;

/**
 * The `--kind` words, in the order help lists them. Checked against {@link COMPUTE_LOG_STREAMS}
 * so the flag can't offer a word the query has no stream for — without that link, an added
 * choice would index the map as `undefined` and reach the SQL as an empty stream name.
 */
export const COMPUTE_LOG_KINDS = [
  "app",
  "requests",
  "builds",
] as const satisfies ReadonlyArray<ComputeLogKindChoice>;

/** Every stream, for an invocation that named none. */
export const ALL_COMPUTE_LOG_STREAMS: ReadonlyArray<string> = Object.values(COMPUTE_LOG_STREAMS);

/**
 * Which `log_attributes` key carries the worker name.
 *
 * The Logflare writer stamps `metadata.worker`, and the whole metadata map lands
 * in `log_attributes` on the ClickHouse side.
 */
const COMPUTE_LOG_NAME_ATTRIBUTE = "worker";

/** Which key carries the stream name. See {@link computeLogsQuery} for why. */
const COMPUTE_LOG_STREAM_ATTRIBUTE = "source";

/**
 * The server clamps a span of more than 24 hours, so the default window sits just under the
 * boundary. Being clamped is worse than being rejected: the server rewrites `end` to
 * `start + 24h`, so an over-wide request silently returns an older slice than the one asked for.
 */
export const COMPUTE_LOG_WINDOW_MINUTES = 23 * 60 + 59;

/**
 * How often `--follow` re-queries — set by the rate limit, not by responsiveness. The v1
 * analytics endpoints allow 10 requests per 60 seconds, so a two-second poll would 429 within
 * the first ten seconds; ten seconds leaves room for the initial history query, the
 * deployed-compute check, and a retry inside the same window.
 */
export const COMPUTE_LOG_POLL_SECONDS = 10;

/**
 * How far behind the newest line seen the next window starts. Guest lines are relayed
 * CloudWatch -> subscription filter -> Lambda -> Logflare and arrive late and out of order, so
 * a cursor sitting exactly on the newest timestamp would drop every straggler permanently —
 * the window re-asks for ground already covered, and `id` dedupe absorbs the overlap. Wider
 * than one poll interval, so a line delayed a full cycle still lands inside the next window.
 */
const COMPUTE_LOG_CURSOR_GRACE_SECONDS = 60;

/**
 * A closed window ending at `now`, with UTC ISO timestamps ending in `Z` as
 * required by the logs API.
 *
 * Both bounds, always. Sending only a start yields a **one-minute** window
 * server-side (the lone bound is minute-rounded and the other derived from it),
 * and sending neither is an outright error — so there is no valid single-bound
 * call to make.
 */
export function logWindow(now: DateTime.Utc): { readonly start: string; readonly end: string } {
  return {
    start: DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - COMPUTE_LOG_WINDOW_MINUTES * 60_000),
    ),
    end: DateTime.formatIso(now),
  };
}

/**
 * The window for one `--follow` poll: from just before the newest line seen, up to now.
 * Clamped to the same sub-24h span as {@link logWindow} — a tail left running past a laptop
 * suspend would otherwise resume with a wider span, and the server answers that by rewriting
 * `end` to `start + 24h`, returning an older slice rather than a truncated one, so a resumed
 * tail would silently start replaying yesterday.
 */
export function followWindow(
  now: DateTime.Utc,
  newestSeen: DateTime.Utc,
): { readonly start: string; readonly end: string } {
  const earliest = DateTime.toEpochMillis(now) - COMPUTE_LOG_WINDOW_MINUTES * 60_000;
  return {
    start: DateTime.formatIso(
      DateTime.makeUnsafe(
        Math.max(
          DateTime.toEpochMillis(newestSeen) - COMPUTE_LOG_CURSOR_GRACE_SECONDS * 1000,
          earliest,
        ),
      ),
    ),
    end: DateTime.formatIso(now),
  };
}

/**
 * Single-quoted SQL string literal.
 *
 * Every value this module interpolates is either an internal constant or a name
 * `validateComputeName` has already reduced to a DNS label, so this is a
 * backstop rather than the guard. It exists so the guarantee does not rest on a
 * caller remembering to validate first.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The logs query for one compute. Two things about the projection are load-bearing: the filter
 * is `log_attributes`, not the `source` column, since compute rows carry an empty top-level
 * `source` (the stream survives only in `log_attributes['source']`); and the `in (...)` list
 * is a tenancy guard, not a convenience — with `source` empty, it's the only thing keeping a
 * non-compute row with a `worker` attribute out of the result. `toUnixTimestamp64Milli` rather
 * than a formatter, since ClickHouse's `%M` is the month name and bare `toString(timestamp)`
 * has no zone.
 */
export function computeLogsQuery(options: {
  readonly name: string;
  readonly streams: ReadonlyArray<string>;
  readonly tail: number;
}): string {
  const streams = options.streams.map(quote).join(", ");
  return (
    `select id, ` +
    `toUnixTimestamp64Milli(timestamp) as ts_ms, ` +
    `log_attributes['${COMPUTE_LOG_STREAM_ATTRIBUTE}'] as stream, ` +
    `event_message, ` +
    `log_attributes ` +
    `from logs ` +
    `where log_attributes['${COMPUTE_LOG_NAME_ATTRIBUTE}'] = ${quote(options.name)} ` +
    `and log_attributes['${COMPUTE_LOG_STREAM_ATTRIBUTE}'] in (${streams}) ` +
    `order by timestamp desc ` +
    `limit ${options.tail}`
  );
}
