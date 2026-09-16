import { Clock, DateTime, Effect, Exit, FileSystem, Match, Option, Path, Schema } from "effect";
import type { Tracer } from "effect";

const RETENTION_DAYS = 7;
type EndedSpanStatus = Extract<Tracer.SpanStatus, { readonly _tag: "Ended" }>;

const NdjsonPayloadSchema = Schema.fromJsonString(
  Schema.Struct({
    timestamp: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    name: Schema.String,
    duration_ms: Schema.Finite,
    status: Schema.Literals(["ok", "error"]),
    error_code: Schema.optionalKey(Schema.String),
    attributes: Schema.Record(Schema.String, Schema.Unknown),
  }),
);

export const initNdjsonExporter = Effect.fnUntraced(
  function* (tracesDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(tracesDir, { recursive: true, mode: 0o700 });

    const files = yield* fs.readDirectory(tracesDir);
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const dateStr = file.replace(".ndjson", "");
      const fileDate = DateTime.make(dateStr);
      if (Option.isSome(fileDate) && DateTime.toEpochMillis(fileDate.value) < cutoff) {
        yield* fs.remove(path.join(tracesDir, file));
      }
    }
  },
  (effect, _tracesDir) => Effect.ignore(effect),
);

export const exportSpanToNdjson = Effect.fnUntraced(function* (
  span: Tracer.Span,
  tracesDir: string,
) {
  const status = span.status;
  const ended = Match.value(status).pipe(
    Match.tag("Started", (): Option.Option<EndedSpanStatus> => Option.none()),
    Match.tag("Ended", (status): Option.Option<EndedSpanStatus> => Option.some(status)),
    Match.exhaustive,
  );
  if (Option.isNone(ended)) return;

  const durationMs = Number(ended.value.endTime - ended.value.startTime) / 1_000_000;
  const timestamp = DateTime.make(Number(ended.value.startTime / BigInt(1_000_000)));
  if (Option.isNone(timestamp)) return;

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of span.attributes) {
    attributes[key] = value;
  }

  const payload = {
    timestamp: DateTime.formatIso(timestamp.value),
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    duration_ms: Math.round(durationMs),
    status: Exit.isSuccess(ended.value.exit) ? ("ok" as const) : ("error" as const),
    ...(Exit.isFailure(ended.value.exit) && { error_code: "Failure" }),
    attributes,
  };

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const dateTime = DateTime.make(now);
  if (Option.isNone(dateTime)) return;
  const date = DateTime.formatIsoDateUtc(dateTime.value);
  const line = yield* Schema.encodeEffect(NdjsonPayloadSchema)(payload);
  yield* fs.writeFileString(path.join(tracesDir, `${date}.ndjson`), `${line}\n`, { flag: "a" });
});
