import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import type { PlatformError, Tracer } from "effect";
import type { TraceSanitizer } from "../trace-sanitize.ts";

const MAX_PRINTED_DEPTH = 2;
/** Keeps each console line readable; exporters still receive every attribute. */
const MAX_PRINTED_ATTRIBUTES_LENGTH = 120;
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

const isSameSpan = (span: Tracer.AnySpan, other: Option.Option<Tracer.AnySpan>): boolean =>
  Option.isSome(other) &&
  span.spanId === other.value.spanId &&
  span.traceId === other.value.traceId;

/** Counts ancestors below `root`, the span current where the console is installed. */
function spanDepth(span: Tracer.Span, root: Option.Option<Tracer.AnySpan>): number {
  let depth = 0;
  let parent = span.parent;
  while (Option.isSome(parent) && parent.value._tag === "Span" && !isSameSpan(parent.value, root)) {
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
  root: Option.Option<Tracer.AnySpan> = Option.none(),
) {
  const status = span.status;
  if (status._tag !== "Ended") return Option.none<string>();
  const depth = spanDepth(span, root);
  const failed = spanFailed(span);
  if (depth > MAX_PRINTED_DEPTH && !failed) return Option.none<string>();

  const durationMs = Math.round(Number(status.endTime - status.startTime) / 1_000_000);
  const time = formatTimestamp(Number(status.startTime / BigInt(1_000_000)));
  if (Option.isNone(time)) return Option.none<string>();

  const attrs = Object.fromEntries(sanitizer.attributeEntries(span.attributes));
  const encoded =
    Object.keys(attrs).length === 0 ? "" : yield* Schema.encodeEffect(JsonAttributesSchema)(attrs);
  const attrStr =
    encoded.length === 0
      ? ""
      : ` ${encoded.length > MAX_PRINTED_ATTRIBUTES_LENGTH ? `${encoded.slice(0, MAX_PRINTED_ATTRIBUTES_LENGTH - 1)}…` : encoded}`;
  const indent = "  ".repeat(Math.min(depth, MAX_PRINTED_DEPTH + 1));
  const marker = failed ? " failed" : "";

  return Option.some(
    `[${time.value}] ${indent}${span.name} (${durationMs}ms)${marker}${attrStr}\n`,
  );
});

export function makeDebugConsoleExporter(
  write: (line: string) => Effect.Effect<void, PlatformError.PlatformError, never>,
  sanitizer: TraceSanitizer,
  root: Option.Option<Tracer.AnySpan> = Option.none(),
): (
  span: Tracer.Span,
) => Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError, never> {
  return (span) =>
    formatSpanForDebugConsole(span, sanitizer, root).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: write,
        }),
      ),
    );
}
