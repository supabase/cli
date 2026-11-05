import { DateTime, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import {
  gatewayLog,
  streamStackLogs,
  type LogPosition,
  type StackLogRecord,
} from "@supabase/stack/effect";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { StackTargetResolver, validateStackTarget } from "../../command-internal/stack-target.ts";
import { isFromLaunch, makeHistoryCollector } from "../../command-internal/logs/local-history.ts";
import { parseSince } from "../../command-internal/logs/since.ts";
import { hasGatewayLogs } from "../../command-internal/logs/local-sources.ts";
import { LogsInputError } from "./logs.errors.ts";
import { logsWindow } from "./logs.format.ts";
import type { LogsFlags, LogsSession } from "./logs.session.ts";

const inputError = (error: { readonly message: string }) =>
  new LogsInputError({ message: error.message });
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const afterPosition = (left: LogPosition, right: LogPosition) =>
  left.generation > right.generation ||
  (left.generation === right.generation && left.byteOffset > right.byteOffset);

export const makeLocalLogsSession = Effect.fn("Logs.local.session")(function* (
  flags: LogsFlags,
  started: number,
) {
  if (flags.level.length > 0 || Option.isSome(flags.search) || Option.isSome(flags.kind))
    return yield* new LogsInputError({
      message:
        "Local logs support service, resource, and time filters. Level, search, and kind are unavailable.",
    });
  if (Option.isSome(flags.resource) && flags.service.length > 0)
    return yield* new LogsInputError({
      message: "For local logs, select either --resource (instance ID) or --service.",
    });
  yield* validateStackTarget({
    stack: Option.getOrUndefined(flags.stack),
    stackId: Option.getOrUndefined(flags.stackId),
  }).pipe(Effect.mapError(inputError));
  const settings = yield* CommandSettings;
  const resolver = yield* StackTargetResolver;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const target = yield* resolver
    .resolve({
      projectRoot: settings.workdir,
      runtime: "auto",
      ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
      ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
    })
    .pipe(Effect.mapError(inputError));
  if (target.id === undefined || target.definition === undefined)
    return yield* new LogsInputError({
      message: "No managed stack exists for the selected project. Run supabase stack start first.",
    });
  const requested = Option.isSome(flags.resource)
    ? [flags.resource.value]
    : flags.service.map((service) => (service === "postgres" ? "database" : service));
  const definition = target.definition;
  const members = new Set(definition.composition.members.map(({ id }) => id));
  const available: Array<{ readonly id: string; readonly service: string }> =
    definition.instances.map(({ id, creation }) => ({ id, service: creation.service }));
  if (hasGatewayLogs(definition))
    available.push({ id: gatewayLog.instanceId, service: gatewayLog.service });
  const unknown = requested.find(
    (value) =>
      !available.some(
        ({ id, service }) => id === value || (Option.isNone(flags.resource) && service === value),
      ),
  );
  if (unknown !== undefined)
    return yield* new LogsInputError({ message: `No service matches ${unknown}.` });
  const selected = available.filter(({ id, service }) =>
    requested.length === 0
      ? members.has(id) || id === gatewayLog.instanceId
      : requested.includes(id) || (Option.isNone(flags.resource) && requested.includes(service)),
  );
  if (selected.length === 0)
    return yield* new LogsInputError({
      message:
        "The stack has no composition members to read. Select a standalone service with --service.",
    });
  const explicitRange =
    Option.isSome(flags.from) || Option.isSome(flags.to)
      ? yield* logsWindow(flags, started, Infinity)
      : undefined;
  const since =
    explicitRange === undefined
      ? parseSince(
          Option.getOrElse(flags.since, () => "1h"),
          started,
        )
      : { kind: "time" as const, iso: explicitRange.start };
  if (since === undefined)
    return yield* new LogsInputError({
      message: "Invalid --since value. Use a duration, an ISO-8601 time, or start.",
    });
  const stackId = target.id;
  const stateRoot = path.join(settings.supabaseHome, "stacks");
  let positions = new Map<string, LogPosition>();
  let launches: ReadonlyMap<string, number> = new Map();
  let gaps = new Map<string, LogPosition>();
  let resumePositions = new Map<string, LogPosition>();
  let initialized = false;
  let attempted = false;
  let lastEnd = explicitRange === undefined ? started : Date.parse(explicitRange.end);
  const load = Effect.fn("Logs.local.load")(function* (
    capturedEnd: number,
    emit: (row: Schema.JsonObject) => Effect.Effect<void>,
  ) {
    const end = attempted ? Math.max(lastEnd, capturedEnd) : lastEnd;
    attempted = true;
    const nextPositions = new Map(positions);
    const nextGaps = new Map(gaps);
    const scannedPositions = new Map(resumePositions);
    const nextResume = new Map<string, LogPosition>();
    const collector = makeHistoryCollector(flags.limit, since.kind === "start");
    const accept = Effect.fnUntraced(function* (record: StackLogRecord) {
      const position = record.position ?? record.resumeAt;
      const previous = scannedPositions.get(record.instanceId);
      if (Date.parse(record.timestamp) > end && !nextResume.has(record.instanceId))
        nextResume.set(
          record.instanceId,
          previous ?? { generation: position?.generation ?? 0, byteOffset: 0 },
        );
      if (position !== undefined) {
        scannedPositions.set(record.instanceId, position);
        const highWater = nextPositions.get(record.instanceId);
        if (
          record.position !== undefined &&
          (highWater === undefined || afterPosition(position, highWater))
        )
          nextPositions.set(record.instanceId, position);
      }
      if (Date.parse(record.timestamp) > end) return;
      if (record.position === undefined && record.resumeAt !== undefined) {
        const previousGap = gaps.get(record.instanceId);
        if (previousGap !== undefined && !afterPosition(record.resumeAt, previousGap)) return;
        nextGaps.set(record.instanceId, record.resumeAt);
      }
      const scanned = positions.get(record.instanceId);
      if (
        initialized &&
        record.position !== undefined &&
        scanned !== undefined &&
        !afterPosition(record.position, scanned) &&
        Date.parse(record.timestamp) <= lastEnd
      )
        return;
      if (!initialized) collector.push(record);
      else if (isFromLaunch(record, launches.get(record.instanceId)))
        yield* Schema.decodeEffect(Schema.JsonObject)(record).pipe(
          Effect.orDie,
          Effect.flatMap(emit),
        );
    });
    yield* streamStackLogs({
      stateRoot,
      stackId,
      instances: selected.map(({ id }) => id),
      snapshot: true,
      from: resumePositions,
      ...(since.kind === "time" ? { since: since.iso } : {}),
    }).pipe(
      Stream.mapError(inputError),
      Stream.runForEach(accept),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (!initialized) {
      const initial = collector.finish();
      for (const record of initial.window.records)
        yield* Schema.decodeEffect(Schema.JsonObject)(record).pipe(
          Effect.orDie,
          Effect.flatMap(emit),
        );
      launches = initial.launches;
    }
    positions = nextPositions;
    gaps = nextGaps;
    resumePositions = scannedPositions;
    for (const [instance, position] of nextResume) resumePositions.set(instance, position);
    initialized = true;
    lastEnd = end;
    yield* Effect.annotateCurrentSpan({
      "logs.instance_count": selected.length,
      "logs.deferred_instance_count": nextResume.size,
    });
    return since.kind === "time"
      ? { kind: "range" as const, start: since.iso, end: iso(end) }
      : { kind: "launch" as const, end: iso(end) };
  });
  return { mode: "append", load } satisfies LogsSession<LogsInputError>;
});
