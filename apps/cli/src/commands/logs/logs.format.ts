import { DateTime, Option } from "effect";
import { parseSince } from "../../command-internal/logs/since.ts";
import { LogsInputError } from "./logs.errors.ts";
import { Effect } from "effect";

export const logsWindow = Effect.fnUntraced(function* (
  options: {
    readonly since: Option.Option<string>;
    readonly from?: Option.Option<string>;
    readonly to?: Option.Option<string>;
  },
  now: number,
  maximumDuration = 86_400_000,
) {
  const from = Option.getOrUndefined(options.from ?? Option.none());
  const to = Option.getOrUndefined(options.to ?? Option.none());
  if (Option.isSome(options.since) && (from !== undefined || to !== undefined))
    return yield* new LogsInputError({ message: "Use --since or --from/--to, not both." });
  const utc = (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
      ? Option.getOrUndefined(DateTime.make(value))
      : undefined;
  const end = to === undefined ? DateTime.makeUnsafe(now) : utc(to);
  const since = parseSince(
    Option.getOrElse(options.since, () => "1h"),
    to !== undefined && end !== undefined ? DateTime.toEpochMillis(end) : now,
  );
  const start =
    from === undefined
      ? since?.kind === "time"
        ? Option.getOrUndefined(DateTime.make(since.iso))
        : undefined
      : utc(from);
  if (
    start === undefined ||
    end === undefined ||
    DateTime.toEpochMillis(end) < DateTime.toEpochMillis(start) ||
    DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start) > maximumDuration
  )
    return yield* new LogsInputError({
      message:
        maximumDuration === Infinity
          ? "Use a valid UTC time range, or --since with a duration such as 1h."
          : "Use a valid UTC time range of at most 24 hours, or --since with a duration such as 1h.",
    });
  return { start: DateTime.formatIso(start), end: DateTime.formatIso(end) };
});
