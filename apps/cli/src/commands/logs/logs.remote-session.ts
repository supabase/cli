import { DateTime, Duration, Effect, Option, Schedule, Schema } from "effect";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { queryLogs } from "./logs.api.ts";
import {
  COMPUTE_LOG_STREAMS,
  hostedSources,
  quoteLogValue,
  hostedSeveritySql,
  severityServices,
} from "./logs.catalog.ts";
import { logsWindow } from "./logs.format.ts";
import { LogsApiError, LogsInputError } from "./logs.errors.ts";
import type { LogsFlags, LogsSession } from "./logs.session.ts";

const filteredSql = Effect.fnUntraced(function* (flags: LogsFlags, computeEnabled: boolean) {
  if (Option.isSome(flags.stack) || Option.isSome(flags.stackId))
    return yield* new LogsInputError({ message: "--stack and --stack-id are local selectors." });
  const enabledSources = hostedSources.filter(
    (entry) => computeEnabled || entry.service !== "compute",
  );
  const selected =
    flags.service.length === 0
      ? flags.level.length > 0
        ? enabledSources.filter(
            ({ service }) => service !== "compute" && severityServices.includes(service),
          )
        : enabledSources
      : enabledSources.filter((entry) => flags.service.includes(entry.service));
  const unknown = flags.service.find(
    (service) => !enabledSources.some((entry) => entry.service === service),
  );
  if (unknown !== undefined)
    return yield* new LogsInputError({
      message: `Unknown or disabled hosted service ${unknown}. Use logs sources --remote.`,
    });
  if (Option.isSome(flags.kind) && (selected.length !== 1 || selected[0]?.service !== "compute"))
    return yield* new LogsInputError({ message: "--kind requires --service compute." });
  if (
    Option.isSome(flags.resource) &&
    (selected.length !== 1 ||
      !["compute", "functions", "function-edge"].includes(selected[0]?.service ?? ""))
  )
    return yield* new LogsInputError({
      message:
        "--resource requires one of: compute (name), functions or function-edge (function ID).",
    });
  if (flags.level.length > 0 && selected.some(({ service }) => !severityServices.includes(service)))
    return yield* new LogsInputError({
      message:
        "--level is supported for postgres, edge, auth, functions, function-edge, and compute request/build logs. Select supported services explicitly.",
    });
  if (
    flags.level.length > 0 &&
    selected.some(({ service }) => service === "compute") &&
    (!Option.isSome(flags.kind) || flags.kind.value === "app")
  )
    return yield* new LogsInputError({
      message:
        "Compute app output has no reliable severity. Use --kind requests or --kind builds with --level.",
    });
  const where = selected.map(({ source, service }) =>
    service === "compute"
      ? `log_attributes['subservice'] in (${Object.values(COMPUTE_LOG_STREAMS).map(quoteLogValue).join(", ")})`
      : `source = ${quoteLogValue(source)}`,
  );
  const conditions = [`(${where.join(" or ")})`];
  if (Option.isSome(flags.resource))
    conditions.push(
      `log_attributes['${selected[0]?.service === "compute" ? "worker" : "function_id"}'] = ${quoteLogValue(flags.resource.value)}`,
    );
  if (Option.isSome(flags.kind))
    conditions.push(
      `log_attributes['subservice'] = ${quoteLogValue(COMPUTE_LOG_STREAMS[flags.kind.value])}`,
    );
  if (flags.level.length > 0)
    conditions.push(
      `(${hostedSeveritySql}) in (${flags.level.map((level) => quoteLogValue(level.toLowerCase() === "warning" ? "warn" : level.toLowerCase())).join(", ")})`,
    );
  if (Option.isSome(flags.search))
    conditions.push(
      `positionCaseInsensitiveUTF8(event_message, ${quoteLogValue(flags.search.value)}) > 0`,
    );
  return `select id, toUnixTimestamp64Milli(timestamp) as ts_ms, source, severity_text, ${hostedSeveritySql} as level, event_message, log_attributes from logs where ${conditions.join(" and ")}`;
});

const logRow = Schema.Struct({
  id: Schema.String,
  ts_ms: Schema.Finite.pipe(
    Schema.check(
      Schema.isGreaterThanOrEqualTo(-8_640_000_000_000_000),
      Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
    ),
  ),
  source: Schema.String,
  severity_text: Schema.String,
  level: Schema.String,
  event_message: Schema.String,
  log_attributes: Schema.Record(Schema.String, Schema.String),
});

type Cursor = Pick<typeof logRow.Type, "id" | "ts_ms">;
const after = (row: Cursor, cursor: Cursor) =>
  row.ts_ms > cursor.ts_ms || (row.ts_ms === cursor.ts_ms && row.id > cursor.id);
const iso = (value: number) => DateTime.formatIso(DateTime.makeUnsafe(value));

export const makeRemoteLogsSession = Effect.fn("Logs.remote.session")(function* (
  flags: LogsFlags,
  ref: string,
  started: number,
  computeEnabled: boolean,
  customSql: string | undefined,
) {
  const window = yield* logsWindow(flags, started);
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const base = customSql === undefined ? yield* filteredSql(flags, computeEnabled) : customSql;
  let attempted = false;
  let committedEnd: number | undefined;
  let seen = new Map<string, number>();
  let initialFloor: Cursor | undefined;
  let pending:
    | { readonly start: number; readonly end: number; readonly cursor: Cursor }
    | undefined;
  const queryPage = Effect.fn("Logs.remote.page")(function* (
    sql: string,
    requested: { readonly start: string; readonly end: string },
  ) {
    return yield* queryLogs(api, ref, sql, requested).pipe(
      Effect.retry({
        while: (error) => error._tag === "LogsApiError" && error.status === 429,
        schedule: Schedule.spaced("60 seconds").pipe(
          Schedule.upTo({ times: 1 }),
          Schedule.setInputType<Effect.Error<ReturnType<typeof queryLogs>>>(),
          Schedule.modifyDelay(({ input, duration }) =>
            Effect.succeed(
              Duration.max(
                duration,
                Duration.millis(input._tag === "LogsApiError" ? (input.retryAfterMs ?? 0) : 0),
              ),
            ),
          ),
        ),
      }),
    );
  });
  const load = Effect.fn("Logs.remote.load")(function* (
    capturedEnd: number,
    emit: (row: Schema.JsonObject) => Effect.Effect<void>,
  ) {
    const initial = committedEnd === undefined;
    const firstAttempt = !attempted;
    attempted = true;
    const end =
      pending?.end ??
      (firstAttempt ? Date.parse(window.end) : Math.max(committedEnd ?? capturedEnd, capturedEnd));
    const start =
      pending?.start ??
      (initial || customSql !== undefined
        ? Date.parse(window.start)
        : Math.max(Date.parse(window.start), (committedEnd ?? end) - 60_000));
    if (end - start > 86_400_000)
      return yield* new LogsInputError({
        message:
          "The refresh window exceeds 24 hours. Restart logs with a narrower --since or --from.",
      });
    const requested = { start: iso(start), end: iso(end) };
    if (customSql !== undefined) {
      const rows = yield* queryLogs(api, ref, customSql, requested);
      yield* Effect.forEach(rows, emit, { discard: true });
      committedEnd = end;
      return {
        kind: "range",
        start: window.start,
        end: requested.end,
      } satisfies import("./logs.browser.format.ts").LogsBrowserWindow;
    }
    const nextSeen = new Map(seen);
    const retentionFloor = Math.max(Date.parse(window.start), end - 60_000);
    let cursor: Cursor | undefined = pending?.cursor;
    let nextPending: typeof pending;
    let pages = 0;
    let overlapCount = [...nextSeen.values()].filter((time) => time >= retentionFloor).length;
    let floor = initialFloor;
    while (true) {
      const condition =
        cursor === undefined
          ? ""
          : ` and (toUnixTimestamp64Milli(timestamp) > ${cursor.ts_ms} or (toUnixTimestamp64Milli(timestamp) = ${cursor.ts_ms} and id > ${quoteLogValue(cursor.id)}))`;
      const sql = `${base}${condition} order by ts_ms ${initial ? "desc" : "asc"}, id ${initial ? "desc" : "asc"} limit ${initial ? flags.limit : 1000}`;
      const raw = yield* queryPage(sql, requested);
      pages += 1;
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(logRow))(raw).pipe(
        Effect.mapError(
          () =>
            new LogsApiError({
              message: "The logs API returned an unreadable log row.",
              status: 200,
              reason: "response",
            }),
        ),
      );
      const pageCursor = cursor;
      if (!initial && pageCursor !== undefined && rows.some((row) => !after(row, pageCursor)))
        return yield* new LogsApiError({
          message: "The logs API did not advance its page cursor.",
          status: 200,
          reason: "response",
        });
      const ordered = [...rows].sort(
        (a, b) => a.ts_ms - b.ts_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const row of ordered) {
        if (!initial && (seen.has(row.id) || (floor !== undefined && !after(row, floor)))) continue;
        if (row.ts_ms >= retentionFloor) {
          if (!nextSeen.has(row.id)) overlapCount += 1;
          nextSeen.set(row.id, row.ts_ms);
        }
        if (overlapCount > 10_000)
          return yield* new LogsInputError({
            message:
              "More than 10000 logs occupy the refresh overlap. Narrow the filters and restart logs.",
          });
        const service =
          hostedSources.find(({ source }) => source === row.source && source !== "")?.service ??
          (Object.values(COMPUTE_LOG_STREAMS).some(
            (stream) => stream === row.log_attributes["subservice"],
          )
            ? "compute"
            : row.source);
        yield* emit({ ...row, service, timestamp: iso(row.ts_ms) });
      }
      if (initial) {
        floor = rows.length === flags.limit ? ordered[0] : undefined;
        break;
      }
      if (rows.length < 1000) break;
      const last = ordered.at(-1);
      if (last === undefined) break;
      cursor = { id: last.id, ts_ms: last.ts_ms };
      if (pages >= 5) {
        nextPending = { start, end, cursor };
        break;
      }
    }
    if (nextPending === undefined)
      for (const [id, time] of nextSeen) if (time < retentionFloor) nextSeen.delete(id);
    seen = nextSeen;
    pending = nextPending;
    initialFloor = floor;
    if (pending === undefined) committedEnd = end;
    yield* Effect.annotateCurrentSpan({
      "logs.page_count": pages,
      "logs.pending": pending !== undefined,
    });
    return {
      kind: "range",
      start: window.start,
      end: requested.end,
      ...(pending === undefined ? {} : { pending: true }),
    } satisfies import("./logs.browser.format.ts").LogsBrowserWindow;
  });
  const session: LogsSession<Effect.Error<ReturnType<typeof load>>> = {
    mode: customSql === undefined ? "append" : "replace",
    load,
  };
  return session;
});
