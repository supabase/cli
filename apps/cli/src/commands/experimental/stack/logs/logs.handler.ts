import { Effect, Match, Option, Stream } from "effect";
import type {
  OpenStackError,
  StackDiscoveryError,
  StackLogEntry,
  StackLogsError as ApiStackLogsError,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetError,
  rejectStackOutput,
  validateStackId,
  validateStackTarget,
} from "../stack.shared.ts";
import { StackCommandLogsError } from "./logs.errors.ts";
import type { StackLogsFlags } from "./logs.command.ts";

const mapTargetError = (error: StackTargetError) =>
  new StackCommandLogsError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const logsError = (
  error: StackDiscoveryError | OpenStackError | ApiStackLogsError,
): StackCommandLogsError => {
  const classification = Match.value(error).pipe(
    Match.tag("StackNotFoundError", "InvalidStackIdentityError", () => ({
      reason: "flags" as const,
    })),
    Match.tag("InvalidLogCursorError", () => ({ reason: "impossible-state" as const })),
    Match.tag("StackNotRunningError", () => ({
      reason: "lifecycle" as const,
      suggestion: "Run supabase stack start before reading logs.",
    })),
    Match.tag("StackOwnershipConflictError", () => ({
      reason: "lifecycle" as const,
      suggestion:
        "Retry with --debug. If the owner is no longer running, stop the selected stack to reconcile its state, then retry.",
    })),
    Match.tag("StackLifecycleConflictError", () => ({
      reason: "lifecycle" as const,
      suggestion: "The stack owner is shutting down; retry shortly.",
    })),
    Match.tag("StackUpgradeRequiredError", () => ({
      reason: "lifecycle" as const,
      suggestion:
        "Stop and restart the selected stack using this CLI so its owner matches this release.",
    })),
    Match.tag("StackRuntimeMismatchError", () => ({ reason: "unknown" as const })),
    Match.tag("StackStateInvalidError", "StackStateFormatUnsupportedError", () => ({
      reason: "invalid-config" as const,
    })),
    Match.tag("InvalidProjectRootError", () => ({ reason: "invalid-config" as const })),
    Match.exhaustive,
  );
  return new StackCommandLogsError({
    ...classification,
    message: error.message,
    cause: error,
  });
};

const renderEntry = (entry: StackLogEntry) =>
  `${entry.timestamp} ${entry.source}/${entry.stream}: ${entry.message}\n`;

const eventForEntry = (entry: StackLogEntry, source: "history" | "live") => ({
  type: "log-entry" as const,
  timestamp: entry.timestamp,
  service: entry.source,
  stream: entry.stream,
  line: entry.message,
  source,
});

export const stackLogs = Effect.fn("experimental.stack.logs")(function* (flags: StackLogsFlags) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));
    if (flags.follow && output.format === "json")
      return yield* new StackCommandLogsError({
        reason: "flags",
        message: "--follow cannot be combined with --output-format json.",
        suggestion: "Use --output-format stream-json for follow mode, or omit --follow.",
      });

    const id = Option.isSome(flags.stackId)
      ? yield* validateStackId(flags.stackId.value).pipe(Effect.mapError(mapTargetError))
      : undefined;
    const targetOption =
      id === undefined
        ? yield* stackApi
            .findStack({
              projectRoot: settings.workdir,
              ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
            })
            .pipe(Effect.mapError(logsError))
        : Option.some({ id });
    if (Option.isNone(targetOption)) {
      if (Option.isSome(flags.stack))
        return yield* new StackCommandLogsError({
          reason: "flags",
          message: `No managed stack named "${flags.stack.value}" was found for this project.`,
        });
      yield* output.success("No managed stack found for this context.", {
        found: false,
        entries: [],
      });
      return;
    }
    const stack = yield* stackApi.openStack(targetOption.value.id).pipe(Effect.mapError(logsError));
    const query = {
      ...(Option.isSome(flags.service) ? { capabilities: [flags.service.value] } : {}),
      tail: flags.tail,
    };
    const batch = yield* stack.logs(query).pipe(Effect.mapError(logsError));
    const emitEntries = (source: "history" | "live", entries: ReadonlyArray<StackLogEntry>) =>
      output.format === "stream-json"
        ? Effect.forEach(entries, (entry) => output.event(eventForEntry(entry, source)), {
            discard: true,
          })
        : Effect.forEach(entries, (entry) => output.raw(renderEntry(entry)), { discard: true });
    if (!flags.follow) {
      if (output.format === "json") {
        yield* output.success("", { found: true, id: stack.id, ...batch });
      } else {
        yield* emitEntries("history", batch.entries);
      }
      return;
    }
    yield* emitEntries("history", batch.entries);
    if (!batch.running) return;
    const followQuery = {
      ...(Option.isSome(flags.service) ? { capabilities: [flags.service.value] } : {}),
      cursor: batch.cursor,
    };
    yield* stack.followLogs(followQuery).pipe(
      Stream.mapError(logsError),
      Stream.runForEach((entry) =>
        output.format === "stream-json"
          ? output.event(eventForEntry(entry, "live"))
          : output.raw(renderEntry(entry)),
      ),
    );
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
