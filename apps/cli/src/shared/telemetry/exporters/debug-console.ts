import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import type { PlatformError, Tracer } from "effect";
import type { TraceSanitizer } from "../trace-sanitize.ts";

const MAX_PRINTED_DEPTH = 2;
const JsonAttributesSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

function formatTimestamp(ms: number): Option.Option<string> {
  const timestamp = DateTime.make(ms);
  return Option.map(timestamp, (date) =>
    DateTime.formatLocal({
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
      locale: "en-US",
    })(date),
  );
}

function spanDepth(span: Tracer.Span): number {
  let depth = 0;
  let parent = span.parent;
  while (Option.isSome(parent) && parent.value._tag === "Span") {
    depth += 1;
    parent = parent.value.parent;
  }
  return depth;
}

function spanFailed(span: Tracer.Span): boolean {
  return (
    span.status._tag === "Ended" &&
    Exit.isFailure(span.status.exit) &&
    !Cause.hasInterruptsOnly(span.status.exit.cause)
  );
}

export const formatSpanForDebugConsole = Effect.fnUntraced(function* (
  span: Tracer.Span,
  sanitizer: TraceSanitizer,
) {
  const status = span.status;
  if (status._tag !== "Ended") return Option.none<string>();
  const depth = spanDepth(span);
  const failed = spanFailed(span);
  if (depth > MAX_PRINTED_DEPTH && !failed) return Option.none<string>();

  const durationMs = Math.round(Number(status.endTime - status.startTime) / 1_000_000);
  const time = formatTimestamp(Number(status.startTime / BigInt(1_000_000)));
  if (Option.isNone(time)) return Option.none<string>();

  const attrs = Object.fromEntries(sanitizer.attributeEntries(span.attributes));
  const attrStr =
    Object.keys(attrs).length === 0
      ? ""
      : ` ${yield* Schema.encodeEffect(JsonAttributesSchema)(attrs)}`;
  const indent = "  ".repeat(Math.min(depth, MAX_PRINTED_DEPTH + 1));
  const marker = failed ? " failed" : "";

  return Option.some(
    `[${time.value}] ${indent}${span.name} (${durationMs}ms)${marker}${attrStr}\n`,
  );
});

export function makeDebugConsoleExporter(
  write: (line: string) => Effect.Effect<void, PlatformError.PlatformError, never>,
  sanitizer: TraceSanitizer,
): (
  span: Tracer.Span,
) => Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError, never> {
  return (span) =>
    formatSpanForDebugConsole(span, sanitizer).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: write,
        }),
      ),
    );
}
