import { outputFormatsForCommand } from "../../command-internal/output-formats.ts";
import { Clock, DateTime, Effect, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { Output } from "../../shared/output/output.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { resolveProjectTarget } from "../../command-internal/target/resolve-project-target.ts";
import { resolveTarget } from "../../command-internal/target/resolve-target.ts";
import { stackLogs } from "../../command-internal/stack-logs/retained-logs.ts";
import { gatewayLog, sharesApiEndpoint } from "@supabase/stack/effect";
import { StackTargetResolver, validateStackTarget } from "../../command-internal/stack-target.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { toCsv, renderTablewriter } from "../../command-internal/tabular-output.ts";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";
import { COMPUTE_LOG_STREAMS } from "../../shared/compute/compute-logs.sql.ts";
import { queryLogs } from "./logs.api.ts";
import {
  hostedSources,
  quoteLogValue,
  hostedSeveritySql,
  severityServices,
} from "./logs.catalog.ts";
import { logsWindow } from "./logs.format.ts";
import { LogsApiError, LogsInputError } from "./logs.errors.ts";
import type { LogsQueryFlags, LogsTailFlags, LogsSourcesFlags } from "./logs.command.ts";

const formatValue = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? stripControlSequences(value)
      : JSON.stringify(value);

const validateQueryOutput = Effect.fnUntraced(function* (leaf: "query" | "sources") {
  const flag = yield* OutputFlag;
  const format = Option.getOrUndefined(flag);
  if (format !== undefined && !outputFormatsForCommand(["logs", leaf]).includes(format))
    return yield* new LogsInputError({
      message: "Logs support -o table, -o pretty, -o json, and -o csv.",
    });
});

const emitRows = Effect.fnUntraced(function* (rows: ReadonlyArray<Schema.JsonObject>) {
  const output = yield* Output;
  const flag = yield* OutputFlag;
  const format = Option.getOrUndefined(flag);
  if (format === "json")
    return yield* output.raw(
      `${yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(rows)}\n`,
    );
  if (format === undefined && output.format !== "text") return yield* output.result(rows);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const values = rows.map((row) => columns.map((column) => row[column]));
  yield* output.raw(
    format === "csv"
      ? toCsv(columns, values, formatValue)
      : renderTablewriter(columns, values, formatValue),
  );
});

export const logsQuery = Effect.fn("logs.query")(function* (flags: LogsQueryFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    yield* validateQueryOutput("query");
    if (flags.local)
      return yield* new LogsInputError({
        message:
          "SQL log queries are available for hosted projects only. Use logs tail --local for retained local logs.",
      });
    const stdin = yield* Stdin;
    if (Option.isSome(flags.sql) && Option.isSome(flags.file))
      return yield* new LogsInputError({
        message: "Provide SQL as an argument or with --file, not both.",
      });
    const piped =
      stdin.isTTY || Option.isSome(flags.sql) || Option.isSome(flags.file)
        ? Option.none<string>()
        : yield* stdin.readPipedText;
    const sources = [flags.sql, flags.file, piped].filter(Option.isSome);
    if (sources.length !== 1)
      return yield* new LogsInputError({
        message: "Provide SQL exactly once: as an argument, with --file, or through stdin.",
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* CommandSettings;
    const sql = Option.isSome(flags.file)
      ? yield* fs.readFileString(path.resolve(settings.workdir, flags.file.value))
      : Option.getOrElse(flags.sql, () => Option.getOrElse(piped, () => ""));
    if (sql.trim() === "") return yield* new LogsInputError({ message: "The SQL input is empty." });
    const window = yield* logsWindow(flags, yield* Clock.currentTimeMillis);
    const ref = yield* resolveProjectTarget(flags);
    const cache = yield* LinkedProjectCache;
    yield* Effect.gen(function* () {
      const api = yield* (yield* CommandPlatformApiFactory).make;
      const output = yield* Output;
      const task = yield* output.task("Querying logs...");
      const rows = yield* queryLogs(api, ref, sql, window).pipe(Effect.tapError(() => task.fail()));
      yield* task.clear;
      yield* emitRows(rows);
    }).pipe(Effect.ensuring(cache.cache(ref)));
  }).pipe(Effect.ensuring(telemetry.flush));
});

const tailRow = Schema.Struct({
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

const hostedTail = Effect.fn("logs.tail.remote")(function* (
  flags: LogsTailFlags,
  ref: string,
  computeEnabled: boolean,
) {
  const output = yield* Output;
  const cache = yield* LinkedProjectCache;
  const processControl = yield* ProcessControl;
  yield* Effect.gen(function* () {
    if (Option.isSome(flags.stack) || Option.isSome(flags.stackId))
      return yield* new LogsInputError({ message: "--stack and --stack-id are local selectors." });
    const enabledSources = hostedSources.filter(
      (entry) => computeEnabled || entry.service !== "compute",
    );
    const selected =
      flags.service.length === 0
        ? enabledSources
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
    if (
      flags.level.length > 0 &&
      selected.some(({ service }) => !severityServices.includes(service))
    )
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
    const base = `select id, toUnixTimestamp64Milli(timestamp) as ts_ms, source, severity_text, ${hostedSeveritySql} as level, event_message, log_attributes from logs where ${conditions.join(" and ")} order by timestamp desc, id desc`;
    const started = yield* Clock.currentTimeMillis;
    const window = yield* logsWindow({ since: flags.since }, started);
    const format = yield* OutputFlag;
    if (Option.isSome(format) && !outputFormatsForCommand(["logs", "tail"]).includes(format.value))
      return yield* new LogsInputError({
        message: "Log tails support -o json (JSON Lines) or -o pretty.",
      });
    const json = Option.isSome(format) ? format.value === "json" : output.format !== "text";
    const seen = new Map<string, number>();
    let newest = flags.tail === 0 ? started : Date.parse(window.start);
    const api = yield* (yield* CommandPlatformApiFactory).make;
    const read = Effect.fn("Logs.tail.read")(function* (
      range: { start: string; end: string },
      limit: number,
    ) {
      const rows = yield* queryLogs(api, ref, `${base} limit ${limit}`, range);
      return yield* Schema.decodeUnknownEffect(Schema.Array(tailRow))(rows).pipe(
        Effect.mapError(
          () =>
            new LogsApiError({
              message: "The logs API returned an unreadable log row.",
              status: 502,
            }),
        ),
      );
    });
    const emit = Effect.fnUntraced(function* (rows: ReadonlyArray<typeof tailRow.Type>) {
      for (const row of [...rows].sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id))) {
        if (seen.has(row.id) || (flags.tail === 0 && row.ts_ms < started)) continue;
        seen.set(row.id, row.ts_ms);
        newest = Math.max(newest, row.ts_ms);
        const payload = { ...row, timestamp: DateTime.formatIso(DateTime.makeUnsafe(row.ts_ms)) };
        yield* output.raw(
          json
            ? `${yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(payload)}\n`
            : `${payload.timestamp} ${stripControlSequences(row.source || row.log_attributes["subservice"] || "compute")} ${stripControlSequences(row.event_message)}\n`,
        );
      }
      const floor = Math.max(Date.parse(window.start), newest - 120_000);
      for (const [id, timestamp] of seen) if (timestamp < floor) seen.delete(id);
      if (seen.size > 10_000)
        return yield* new LogsInputError({
          message:
            "More than 10000 logs arrived inside the overlap window. Narrow the filters and restart the tail.",
        });
    });
    if (flags.tail > 0) {
      const rows = yield* read(window, flags.tail);
      yield* emit(rows);
      if (rows.length === flags.tail)
        yield* output.raw(
          "History reached --tail; older rows may exist. Use logs query to read a wider result.\n",
          "stderr",
        );
    }
    if (flags.noFollow) return;
    const poll = Effect.fn("Logs.tail.poll")(function* () {
      const end = yield* Clock.currentTimeMillis;
      const start = Math.max(
        flags.tail === 0 ? started : Date.parse(window.start),
        newest - 60_000,
        end - 86_340_000,
      );
      const rows = yield* read(
        {
          start: DateTime.formatIso(DateTime.makeUnsafe(start)),
          end: DateTime.formatIso(DateTime.makeUnsafe(end)),
        },
        1000,
      );
      if (rows.length === 1000)
        return yield* new LogsInputError({
          message:
            "The poll reached 1000 rows; some logs may be missing. Narrow --service or --search, or use logs query.",
        });
      yield* emit(rows);
      newest = Math.max(newest, end - 60_000);
    });
    yield* Effect.raceFirst(
      poll().pipe(
        Effect.retry({
          schedule: Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "1 minute" })),
          while: (error) =>
            Schema.is(LogsApiError)(error) && (error.status === 429 || error.status >= 500),
        }),
        Effect.repeat(Schedule.spaced("10 seconds")),
      ),
      processControl
        .awaitSignal()
        .pipe(
          Effect.flatMap((signal) => processControl.setExitCode(signal === "SIGINT" ? 130 : 0)),
        ),
    );
  }).pipe(Effect.ensuring(cache.cache(ref)));
});

export const logsTail = Effect.fn("logs.tail")(function* (
  flags: LogsTailFlags,
  localEnabled: boolean,
  computeEnabled: boolean,
) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const target = yield* resolveTarget(flags, { localIsSupported: true });
    if (target.kind === "db-url")
      return yield* new LogsInputError({ message: "Logs do not support database URLs." });
    if (target.kind === "linked") return yield* hostedTail(flags, target.ref, computeEnabled);
    if (!localEnabled)
      return yield* new LogsInputError({
        message:
          "Local logs require the experimental stack backend. Enable experimental.stack in your CLI config.",
      });
    if (flags.level.length > 0 || Option.isSome(flags.search) || Option.isSome(flags.kind))
      return yield* new LogsInputError({
        message:
          "Local logs currently support service, resource, since, and tail filters. Level, search, and kind are unavailable.",
      });
    if (Option.isSome(flags.resource) && flags.service.length > 0)
      return yield* new LogsInputError({
        message: "For local logs, select either --resource (instance ID) or --service.",
      });
    return yield* stackLogs(
      {
        stack: flags.stack,
        stackId: flags.stackId,
        service: Option.isSome(flags.resource)
          ? [flags.resource.value]
          : flags.service.map((service) => (service === "postgres" ? "database" : service)),
        since: Option.orElse(flags.since, () => Option.some("1h")),
        tail: flags.tail,
        follow: !flags.noFollow,
      },
      { unified: true },
    );
  }).pipe(Effect.ensuring(telemetry.flush));
});

export const logsSources = Effect.fn("logs.sources")(function* (
  flags: LogsSourcesFlags,
  localEnabled: boolean,
  computeEnabled: boolean,
) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    yield* validateQueryOutput("sources");
    const target = yield* resolveTarget(flags, { localIsSupported: true });
    if (target.kind === "linked") {
      if (Option.isSome(flags.stack) || Option.isSome(flags.stackId))
        return yield* new LogsInputError({
          message: "--stack and --stack-id are local selectors.",
        });
      if (
        Option.isSome(flags.service) &&
        !hostedSources.some(
          (entry) =>
            entry.service === Option.getOrUndefined(flags.service) &&
            (computeEnabled || entry.service !== "compute"),
        )
      )
        return yield* new LogsInputError({
          message: "Unknown or disabled hosted service. Use logs sources --remote.",
        });
      return yield* emitRows(
        hostedSources
          .filter(
            (entry) =>
              (computeEnabled || entry.service !== "compute") &&
              (Option.isNone(flags.service) || entry.service === flags.service.value),
          )
          .map((entry) => ({
            service: entry.service,
            sql:
              entry.service === "compute"
                ? "logs WHERE log_attributes['subservice'] IN ('worker_guest_logs','worker_ingress_logs','worker_api_logs')"
                : `logs WHERE source = '${entry.source}'`,
            filters:
              entry.service === "compute"
                ? ["service", "resource", "kind", "level", "search", "since"]
                : [
                    "service",
                    "search",
                    "since",
                    ...(severityServices.includes(entry.service) ? ["level"] : []),
                    ...(["functions", "function-edge"].includes(entry.service) ? ["resource"] : []),
                  ],
            levels: severityServices.includes(entry.service)
              ? entry.service === "compute" ||
                entry.service === "edge" ||
                entry.service === "function-edge"
                ? ["error", "warn", "info"]
                : ["error", "warn", "info", "debug", "log", "notice"]
              : [],
            severity: severityServices.includes(entry.service)
              ? entry.service === "compute"
                ? "Derived for requests/builds; app severity is unknown."
                : "Derived from service fields; unknown stays unknown."
              : null,
            kinds: "kinds" in entry ? entry.kinds : [],
          })),
      );
    }
    if (!localEnabled)
      return yield* new LogsInputError({
        message: "Local log discovery requires the experimental stack backend.",
      });
    return yield* Effect.gen(function* () {
      yield* validateStackTarget({
        stack: Option.getOrUndefined(flags.stack),
        stackId: Option.getOrUndefined(flags.stackId),
      }).pipe(Effect.mapError((error) => new LogsInputError({ message: error.message })));
      const resolver = yield* StackTargetResolver;
      const settings = yield* CommandSettings;
      const target = yield* resolver.resolve({
        projectRoot: settings.workdir,
        runtime: "auto",
        name: Option.getOrUndefined(flags.stack),
        id: Option.getOrUndefined(flags.stackId),
      });
      const instances = target.definition?.instances ?? [];
      const requested = Option.getOrUndefined(flags.service);
      const members = new Set(target.definition?.composition.members.map(({ id }) => id) ?? []);
      const gateway = instances.some(
        ({ id, creation }) => members.has(id) && sharesApiEndpoint(creation),
      );
      if (
        requested !== undefined &&
        !instances.some(
          ({ creation }) =>
            creation.service === (requested === "postgres" ? "database" : requested),
        ) &&
        !(requested === "gateway" && gateway)
      )
        return yield* new LogsInputError({
          message: "Unknown local service. Use logs sources --local.",
        });
      const rows = instances
        .filter(
          ({ creation }) =>
            Option.isNone(flags.service) ||
            creation.service ===
              (flags.service.value === "postgres" ? "database" : flags.service.value),
        )
        .map(({ id, creation }) => ({
          service: creation.service === "database" ? "postgres" : creation.service,
          resource: id,
          sql: null,
          filters: ["service", "resource", "since", "tail"],
          kinds: ["stdout", "stderr", "launch", "lost"],
          severity: null,
        }));
      yield* emitRows([
        ...rows,
        ...(gateway && (requested === undefined || requested === "gateway")
          ? [
              {
                service: gatewayLog.service,
                resource: gatewayLog.instanceId,
                sql: null,
                filters: ["service", "since", "tail"],
                kinds: ["stdout", "stderr", "launch", "lost"],
                severity: null,
              },
            ]
          : []),
      ]);
    });
  }).pipe(Effect.ensuring(telemetry.flush));
});
