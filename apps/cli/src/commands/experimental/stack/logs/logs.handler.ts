import { Clock, Effect, Option, Path, Stream } from "effect";
import { streamStackLogs, type SavedStack, type StackLogRecord } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { dim } from "../../../../command-internal/colors.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetError,
  StackTargetResolver,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import { StackCommandLogsError } from "./logs.errors.ts";
import type { StackLogsFlags } from "./logs.command.ts";
import {
  isAfter,
  logEvent,
  makeHistoryCollector,
  makeTextFormatter,
  parseSince,
  truncationFooter,
  type LogSource,
} from "./logs.format.ts";

const targetError = (cause: StackTargetError) =>
  new StackCommandLogsError({
    reason: cause.reason,
    message: cause.message,
    ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
    cause,
  });
const logsError = (cause: { readonly message: string }) =>
  new StackCommandLogsError({ reason: "unknown", message: cause.message, cause });

type SavedInstance = SavedStack["instances"][number];
interface Selected {
  readonly id: string;
  readonly service: string;
}

const select = (
  definition: SavedStack,
  requested: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Selected>, StackCommandLogsError> => {
  const subject = ({ id, creation }: SavedInstance): Selected => ({
    id,
    service: creation.service,
  });
  if (requested.length === 0) {
    const members = new Set(definition.composition.members.map(({ id }) => id));
    const selected = definition.instances.filter(({ id }) => members.has(id)).map(subject);
    return selected.length === 0
      ? Effect.fail(
          new StackCommandLogsError({
            reason: "flags",
            message: "The stack has no composition members to read.",
            suggestion: "Select a standalone service with --service.",
          }),
        )
      : Effect.succeed(selected);
  }
  const unmatched = requested.find(
    (value) =>
      !definition.instances.some(({ id, creation }) => id === value || creation.service === value),
  );
  if (unmatched !== undefined)
    return Effect.fail(
      new StackCommandLogsError({ reason: "flags", message: `No service matches ${unmatched}.` }),
    );
  return Effect.succeed(
    definition.instances
      .filter(({ id, creation }) => requested.includes(id) || requested.includes(creation.service))
      .map(subject),
  );
};

export const stackLogs = Effect.fn("experimental.stack.logs")(function* (flags: StackLogsFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const api = yield* StackApi;
    const resolver = yield* StackTargetResolver;
    yield* rejectStackOutput(yield* Effect.serviceOption(OutputFlag)).pipe(
      Effect.mapError(targetError),
    );
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(targetError));
    if (flags.follow && output.format === "json")
      return yield* new StackCommandLogsError({
        reason: "flags",
        message: "Following logs requires text or stream-json output.",
        suggestion: "Use --output-format stream-json, or omit --follow.",
      });
    const now = yield* Clock.currentTimeMillis;
    const since = Option.isNone(flags.since) ? undefined : parseSince(flags.since.value, now);
    if (Option.isSome(flags.since) && since === undefined)
      return yield* new StackCommandLogsError({
        reason: "flags",
        message: `Invalid --since value ${flags.since.value}.`,
        suggestion: "Use a duration such as 10m or 1h30m, an ISO-8601 time, or start.",
      });
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        runtime: "auto",
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
      })
      .pipe(Effect.mapError(targetError));
    if (target.id === undefined || target.definition === undefined)
      return yield* new StackCommandLogsError({
        reason: "flags",
        message: "No managed stack exists for the selected project.",
        suggestion: "Run supabase stack start first.",
      });
    if (flags.follow && !target.hostRunning)
      return yield* new StackCommandLogsError({
        reason: "lifecycle",
        message: "The stack is not running, so there are no new lines to follow.",
        suggestion:
          "Run supabase stack logs without --follow to read retained logs, or supabase stack start first.",
      });
    const selected = yield* select(target.definition, flags.service);
    const stackId = target.id;
    const locations = {
      stateRoot: path.join(settings.supabaseHome, "stacks"),
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    };
    const sinceTime = since?.kind === "time" ? { since: since.iso } : {};
    const collector = makeHistoryCollector(flags.tail, since?.kind === "start");
    if (flags.tail > 0)
      yield* streamStackLogs({
        stateRoot: locations.stateRoot,
        stackId,
        instances: selected.map(({ id }) => id),
        ...sinceTime,
      }).pipe(
        Stream.mapError(logsError),
        Stream.runForEach((record) => Effect.sync(() => collector.push(record))),
      );
    const { window, positions: printed } = collector.finish();

    if (output.format === "json")
      return yield* output.result(window.records.map((record) => logEvent(record, "history")));
    // Colour follows the terminal only when stdout is one, so piped logs stay plain.
    const terminal = output.interactive;
    const text = makeTextFormatter(selected, terminal ? process.stdout : {});
    const emit = (record: StackLogRecord, source: LogSource) =>
      output.format === "stream-json"
        ? output.event(logEvent(record, source))
        : output.raw(text(record));
    yield* Effect.forEach(window.records, (record) => emit(record, "history"), { discard: true });
    if (output.format === "text" && flags.tail > 0) {
      const note = (message: string) =>
        output.raw(`${dim(message, terminal ? process.stderr : {})}\n`, "stderr");
      if (window.shown < window.total) yield* note(truncationFooter(window));
      else if (window.total === 0 && !flags.follow)
        yield* note("No retained log lines for the selected services.");
    }
    if (!flags.follow) return;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* api
          .open({ ...locations, id: stackId })
          .pipe(Effect.mapError(logsError));
        const handles = new Map(
          (yield* stack.services.list.pipe(Effect.mapError(logsError))).map((handle) => [
            handle.id,
            handle,
          ]),
        );
        const streams = selected.flatMap(({ id, service }) => {
          const handle = handles.get(id);
          if (handle === undefined) return [];
          const from = printed.get(id);
          // Without history, the owner pins the start at its end under the writer's lock.
          const start = flags.tail === 0 ? { tail: 0 } : from === undefined ? {} : { from };
          return [
            handle.readLogs({ follow: true, ...start, ...sinceTime }).pipe(
              Stream.filter((record) => isAfter(record, from)),
              Stream.map((record): StackLogRecord => ({ ...record, service, instanceId: id })),
            ),
          ];
        });
        yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
          Stream.mapError(logsError),
          Stream.runForEach((record) => emit(record, "live")),
        );
      }),
    );
  }).pipe(Effect.ensuring(telemetry.flush));
});
