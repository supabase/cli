import { wrapTerminalText as wrapLogsText } from "../../shared/output/wrap-terminal-text.ts";
import { hasGatewayLogs } from "../../command-internal/logs/local-sources.ts";
import { logEvent, markerText } from "../../command-internal/stack-log-events.ts";
import { Clock, Effect, FileSystem, Option, Path, Result, Schema, Stream } from "effect";
import { gatewayLog } from "@supabase/stack/effect";
import { unsupportedOutputFlagMessage } from "../../command-internal/output-formats.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { StackTargetResolver, validateStackTarget } from "../../command-internal/stack-target.ts";
import { parseTargetSelector } from "../../command-internal/target/target-selector.ts";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";
import { resolveTarget } from "../../command-internal/target/resolve-target.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../shared/config/experimental-feature.ts";
import { currentProjectStateMode } from "../../shared/config/project-state-mode.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { encodeHtmlSafeJsonIndented } from "../../command-internal/html-safe-json.ts";
import { renderLogsRows, renderLogsSources } from "./logs.display.ts";
import { hostedSources, severityServices } from "./logs.catalog.ts";
import { logsWindow } from "./logs.format.ts";
import { LogsInputError } from "./logs.errors.ts";
import { browseLogs, useLogsBrowser } from "./logs.browser.ts";
import { filteredLogsSql, makeRemoteLogsSession } from "./logs.remote-session.ts";
import { makeLocalLogsSession } from "./logs.local-session.ts";
import type { LogsFlags, LogsSession } from "./logs.session.ts";
import type { LogsSourcesFlags } from "./logs.command.ts";

const resolveLogsCompute = Effect.fn("Logs.resolveCompute")(function* () {
  const settings = yield* CommandSettings;
  const args = yield* Effect.serviceOption(CliArgs);
  return yield* resolveExperimentalFeature({
    feature: "compute",
    configValue: readExperimentalFeatureConfig({
      feature: "compute",
      cwd: settings.workdir,
      args: Option.isSome(args) ? args.value.args : [],
    }),
  });
});

const logsWidth = Effect.fnUntraced(function* () {
  const tty = yield* Effect.serviceOption(Tty);
  const columns = Option.isSome(tty) ? tty.value.stdoutColumns : undefined;
  return columns !== undefined && Number.isFinite(columns) && columns >= 20
    ? Math.floor(columns)
    : 80;
});

const logsResult = Effect.fnUntraced(function* (rows: ReadonlyArray<Schema.JsonObject>) {
  const output = yield* Output;
  return yield* output.format === "json"
    ? output.raw(encodeHtmlSafeJsonIndented(rows))
    : output.result(rows);
});

const rejectLegacyOutput = Effect.fnUntraced(function* (leaf: "sources" | undefined) {
  if (Option.isSome(yield* OutputFlag))
    return yield* new LogsInputError({
      message: unsupportedOutputFlagMessage(leaf === undefined ? "logs" : `logs ${leaf}`),
    });
});

const emitRows = Effect.fnUntraced(function* (
  rows: ReadonlyArray<Schema.JsonObject>,
  sourceDetail?: boolean,
) {
  const output = yield* Output;
  if (output.format !== "text") return yield* logsResult(rows);
  const width = yield* logsWidth();
  yield* output.raw(
    sourceDetail === undefined
      ? renderLogsRows(rows, width)
      : renderLogsSources(rows, sourceDetail, width),
  );
});

const sqlInput = Effect.fn("Logs.sqlInput")(function* (flags: LogsFlags) {
  let sql = Option.getOrUndefined(flags.sql);
  if (Option.isSome(flags.file)) {
    if (flags.file.value === "-") {
      const stdin = yield* Stdin;
      if (stdin.isTTY)
        return yield* new LogsInputError({
          message: "Pipe SQL into stdin when using --file -, or use --sql or --file <path>.",
        });
      sql = yield* stdin.pipedBytesStream.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.mapError(
          () =>
            new LogsInputError({
              message: "Could not read SQL from stdin. Check the input pipe and try again.",
            }),
        ),
      );
    } else {
      const file = flags.file.value;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = yield* CommandSettings;
      sql = yield* fs.readFileString(path.resolve(settings.workdir, file)).pipe(
        Effect.mapError(
          (error) =>
            new LogsInputError({
              message: `Could not read SQL file "${file}": ${error.message}`,
            }),
        ),
      );
    }
  }
  if (sql !== undefined && sql.trim() === "")
    return yield* new LogsInputError({ message: "The SQL input is empty." });
  return sql;
});

const localRecord = Schema.Struct({
  kind: Schema.Literals(["stdout", "stderr", "launch", "lost"]),
  timestamp: Schema.String,
  service: Schema.String,
  instanceId: Schema.String,
  text: Schema.optionalKey(Schema.String),
  stream: Schema.optionalKey(Schema.Literals(["stdout", "stderr"])),
  count: Schema.optionalKey(Schema.Finite),
  launchId: Schema.optionalKey(Schema.Int),
});

const filteredText = (row: Schema.JsonObject) =>
  `${String(row["timestamp"] ?? "—")} ${String(row["service"] ?? row["source"] ?? "logs")} ${String(row["event_message"] ?? row["text"] ?? (Schema.is(localRecord)(row) ? markerText(row) : (row["kind"] ?? "")))}`;

export const logs = Effect.fn("logs")(function* (flags: LogsFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    yield* rejectLegacyOutput(undefined);
    const hasSql = Option.isSome(flags.sql) || Option.isSome(flags.file);
    if (Option.isSome(flags.sql) && Option.isSome(flags.file))
      return yield* new LogsInputError({ message: "Provide SQL with --sql or --file, not both." });
    if (
      hasSql &&
      (flags.service.length > 0 ||
        flags.level.length > 0 ||
        Option.isSome(flags.resource) ||
        Option.isSome(flags.kind) ||
        Option.isSome(flags.search) ||
        Option.isSome(flags.stack) ||
        Option.isSome(flags.stackId))
    )
      return yield* new LogsInputError({
        message:
          "Custom SQL cannot be combined with service, resource, kind, level, search, or stack filters.",
      });
    const args = yield* Effect.serviceOption(CliArgs);
    const { selection } = yield* Result.match(
      parseTargetSelector(flags, {
        remoteConflict: Option.getOrUndefined(args)?.remoteConflict === true,
      }),
      { onFailure: Effect.fail, onSuccess: Effect.succeed },
    );
    if (selection._tag === "DbUrl")
      return yield* new LogsInputError({ message: "Logs do not support database URLs." });
    const hosted = selection._tag !== "Default" && selection._tag !== "Local";
    if (hasSql && !hosted)
      return yield* new LogsInputError({ message: "Custom log SQL requires --remote." });
    const started = yield* Clock.currentTimeMillis;
    if (hosted) yield* logsWindow(flags, started);
    const computeEnabled = hosted && !hasSql ? yield* resolveLogsCompute() : false;
    if (hosted && !hasSql) yield* filteredLogsSql(flags, computeEnabled);
    const target = yield* resolveTarget(flags);
    if (target.kind === "db-url")
      return yield* new LogsInputError({ message: "Logs do not support database URLs." });
    const sql = yield* sqlInput(flags);
    if (target.kind === "local" && (yield* currentProjectStateMode) !== "stack")
      return yield* new LogsInputError({
        message:
          "Local logs require the experimental stack backend. Set SUPABASE_EXPERIMENTAL_STACK=1 or [experimental] stack = true in supabase/config.toml, or use --remote for hosted logs.",
      });
    const output = yield* Output;
    const interactive = yield* useLogsBrowser();
    const run = Effect.fnUntraced(function* <E>(session: LogsSession<E>) {
      if (interactive) return yield* browseLogs(session, started, flags);
      const rows: Array<Schema.JsonObject> = [];
      yield* session.load(
        started,
        (row) =>
          Effect.sync(() => {
            rows.push(row);
          }),
        (update) => output.raw(`${update.message}\n`, "stderr"),
      );
      if (sql === undefined && rows.length >= flags.limit)
        yield* output.raw(
          "History reached --limit; older rows may exist. Narrow the window or use --sql for a wider result.\n",
          "stderr",
        );
      if (output.format === "json") return yield* logsResult(rows);
      if (sql !== undefined) return yield* emitRows(rows);
      const width = yield* logsWidth();
      const tty = yield* Effect.serviceOption(Tty);
      const wrap = Option.isSome(tty) && tty.value.stdoutIsTty;
      for (const row of rows) {
        if (output.format === "stream-json" && Schema.is(localRecord)(row))
          yield* output.event({ ...logEvent(row, "history"), data: row });
        else if (output.format === "stream-json")
          yield* output.event({
            type: "log-entry",
            stream: row["level"] === "error" || row["level"] === "warn" ? "stderr" : "stdout",
            timestamp: String(row["timestamp"] ?? ""),
            service: String(row["service"] ?? row["source"] ?? "logs"),
            source: "history",
            line: String(row["event_message"] ?? row["text"] ?? ""),
            data: row,
          });
        else {
          const text = filteredText(row);
          yield* output.raw(
            `${wrap ? wrapLogsText(text, width) : stripControlSequences(text.replaceAll("\r", "\\r").replaceAll("\n", "\\n"))}\n`,
          );
        }
      }
    });
    if (target.kind === "linked") {
      const cache = yield* LinkedProjectCache;
      return yield* Effect.gen(function* () {
        const session = yield* makeRemoteLogsSession(
          flags,
          target.ref,
          started,
          computeEnabled,
          sql,
          interactive,
        );
        yield* run(session);
      }).pipe(Effect.ensuring(cache.cache(target.ref)));
    }
    const session = yield* makeLocalLogsSession(flags, started);
    return yield* run(session);
  }).pipe(Effect.ensuring(telemetry.flush));
});

export const logsSources = Effect.fn("logs.sources")(function* (flags: LogsSourcesFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    yield* rejectLegacyOutput("sources");
    const target = yield* resolveTarget(flags);
    if (target.kind === "linked") {
      const availableCompute = yield* resolveLogsCompute();
      if (Option.isSome(flags.stack) || Option.isSome(flags.stackId))
        return yield* new LogsInputError({
          message: "--stack and --stack-id are local selectors.",
        });
      if (
        Option.isSome(flags.service) &&
        !hostedSources.some(
          (entry) =>
            entry.service === Option.getOrUndefined(flags.service) &&
            (availableCompute || entry.service !== "compute"),
        )
      )
        return yield* new LogsInputError({
          message: "Unknown or disabled hosted service. Use logs sources --remote.",
        });
      return yield* emitRows(
        hostedSources
          .filter(
            (entry) =>
              (availableCompute || entry.service !== "compute") &&
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
        Option.isSome(flags.service),
      );
    }
    if ((yield* currentProjectStateMode) !== "stack")
      return yield* new LogsInputError({
        message:
          "Local log discovery requires the experimental stack backend. Set SUPABASE_EXPERIMENTAL_STACK=1 or [experimental] stack = true in supabase/config.toml, or use --remote for hosted sources.",
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
      const gateway = target.definition !== undefined && hasGatewayLogs(target.definition);
      if (
        requested !== undefined &&
        !instances.some(
          ({ creation }) =>
            creation.service === (requested === "postgres" ? "database" : requested),
        ) &&
        !(requested === "gateway" && gateway)
      )
        return yield* new LogsInputError({
          message: "Unknown local service. Use logs sources.",
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
          filters: ["service", "resource", "since", "limit"],
          kinds: ["stdout", "stderr", "launch", "lost"],
          severity: null,
        }));
      yield* emitRows(
        [
          ...rows,
          ...(gateway && (requested === undefined || requested === "gateway")
            ? [
                {
                  service: gatewayLog.service,
                  resource: gatewayLog.instanceId,
                  sql: null,
                  filters: ["service", "since", "limit"],
                  kinds: ["stdout", "stderr", "launch", "lost"],
                  severity: null,
                },
              ]
            : []),
        ],
        Option.isSome(flags.service),
      );
    });
  }).pipe(Effect.ensuring(telemetry.flush));
});
