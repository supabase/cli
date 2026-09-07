import { Effect, Match, Option, Stream } from "effect";
import {
  isStackError,
  isStackId,
  StackIdSchema,
  type CapabilityName,
  type StackLogEntry,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { LegacyExperimentalStackLogsError } from "./logs.errors.ts";

type LegacyExperimentalStackLogsFlags = {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
  readonly service: Option.Option<CapabilityName>;
  readonly tail: number;
  readonly follow: boolean;
};

const logsError = (error: unknown): LegacyExperimentalStackLogsError => {
  const stackError = isStackError(error) ? error : undefined;
  const classification =
    stackError === undefined
      ? ("unknown" as const)
      : Match.value(stackError).pipe(
          Match.tag("StackNotFoundError", "InvalidStackIdentityError", () => ({
            reason: "flags" as const,
          })),
          Match.tag("InvalidLogCursorError", () => ({ reason: "impossible-state" as const })),
          Match.tag(
            "StackNotRunningError",
            "StackOwnershipConflictError",
            "StackLifecycleConflictError",
            "StackUpgradeRequiredError",
            () => ({
              reason: "lifecycle" as const,
              suggestion: "Run supabase experimental stack start before reading logs.",
            }),
          ),
          Match.tag("StackStateInvalidError", "StackStateFormatUnsupportedError", () => ({
            reason: "invalid-config" as const,
          })),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new LegacyExperimentalStackLogsError({
    reason: typeof classification === "string" ? classification : classification.reason,
    message: stackError?.message ?? String(error),
    ...(typeof classification !== "string" && "suggestion" in classification
      ? { suggestion: classification.suggestion }
      : {}),
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

export const legacyExperimentalStackLogs = Effect.fn("legacy.experimental.stack.logs")(function* (
  flags: LegacyExperimentalStackLogsFlags,
) {
  const output = yield* Output;
  const settings = yield* LegacyCliSettings;
  const stackApi = yield* LegacyExperimentalStackApi;
  const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
  if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
    return yield* new LegacyExperimentalStackLogsError({
      reason: "flags",
      message: "The legacy -o/--output flag is not supported here; use --output-format json.",
      suggestion: "Use --output-format json, --output-format text, or --output-format stream-json.",
    });
  if (Option.isSome(flags.stack) && Option.isSome(flags.stackId))
    return yield* new LegacyExperimentalStackLogsError({
      reason: "flags",
      message: "--stack and --stack-id cannot be used together",
    });
  if (flags.follow && output.format === "json")
    return yield* new LegacyExperimentalStackLogsError({
      reason: "flags",
      message: "--follow cannot be combined with --output-format json.",
      suggestion: "Use --output-format stream-json for follow mode, or omit --follow.",
    });

  const id = Option.isSome(flags.stackId) ? flags.stackId.value : undefined;
  const targetOption =
    id === undefined
      ? yield* stackApi
          .findStack({
            projectRoot: settings.workdir,
            ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
          })
          .pipe(Effect.mapError(logsError))
      : yield* isStackId(id)
          ? Effect.succeed(
              Option.some({ id: StackIdSchema.make(id), projectRoot: settings.workdir }),
            )
          : Effect.fail(
              new LegacyExperimentalStackLogsError({
                reason: "flags",
                message: "--stack-id must be a lowercase SHA-256 stack id",
              }),
            );
  if (Option.isNone(targetOption)) {
    if (Option.isSome(flags.stack))
      return yield* new LegacyExperimentalStackLogsError({
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
    if (output.format === "text") {
      yield* output.raw(batch.entries.map(renderEntry).join(""));
    } else if (output.format === "stream-json") {
      for (const entry of batch.entries) yield* output.event(eventForEntry(entry, "history"));
    } else {
      yield* output.success("", batch);
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
