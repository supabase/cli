import { DateTime, Effect, Match, Option, Schema } from "effect";
import type { PlatformError, Tracer } from "effect";

type EndedSpanStatus = Extract<Tracer.SpanStatus, { readonly _tag: "Ended" }>;
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

export const formatSpanForDebugConsole = Effect.fnUntraced(function* (span: Tracer.Span) {
  const ended = Match.value(span.status).pipe(
    Match.tag("Started", (): Option.Option<EndedSpanStatus> => Option.none()),
    Match.tag("Ended", (status): Option.Option<EndedSpanStatus> => Option.some(status)),
    Match.exhaustive,
  );
  if (Option.isNone(ended)) return Option.none<string>();

  const durationMs = Math.round(Number(ended.value.endTime - ended.value.startTime) / 1_000_000);
  const timestampMs = Number(ended.value.startTime / BigInt(1_000_000));
  const time = formatTimestamp(timestampMs);
  if (Option.isNone(time)) return Option.none<string>();

  const attrs: Record<string, unknown> = {};
  for (const [key, value] of span.attributes) {
    attrs[key] = value;
  }
  const attrStr =
    Object.keys(attrs).length === 0
      ? ""
      : ` ${yield* Schema.encodeEffect(JsonAttributesSchema)(attrs)}`;

  return Option.some(`[${time.value}] ${span.name} (${durationMs}ms)${attrStr}\n`);
});

export function makeDebugConsoleExporter(
  write: (line: string) => Effect.Effect<void, PlatformError.PlatformError, never>,
): (
  span: Tracer.Span,
) => Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError, never> {
  return (span) =>
    formatSpanForDebugConsole(span).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: write,
        }),
      ),
    );
}
