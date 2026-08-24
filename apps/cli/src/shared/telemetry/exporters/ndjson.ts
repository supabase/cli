import { Clock, DateTime, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import type { Tracer } from "effect";

const RETENTION_DAYS = 7;
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

type NdjsonEffect<A> = Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>;

export const initNdjsonExporter: (tracesDir: string) => NdjsonEffect<void> = Effect.fnUntraced(
  function* (tracesDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(tracesDir, { recursive: true, mode: 0o700 });

    const files = yield* fs.readDirectory(tracesDir);
    const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const dateStr = file.replace(".ndjson", "");
      const fileDate = DateTime.make(dateStr);
      if (Option.isSome(fileDate) && fileDate.value.epochMilliseconds < cutoff) {
        yield* fs.remove(path.join(tracesDir, file));
      }
    }
  },
  (effect) => Effect.ignore(effect),
);

export const exportSpanToNdjson: (span: Tracer.Span, tracesDir: string) => NdjsonEffect<void> =
  Effect.fnUntraced(
    function* (span: Tracer.Span, tracesDir: string) {
      const status = span.status;
      if (status._tag !== "Ended") return;

      const durationMs = Number(status.endTime - status.startTime) / 1_000_000;
      const timestampMs = Number(status.startTime / BigInt(1_000_000));

      const attributes: Record<string, unknown> = {};
      for (const [key, value] of span.attributes) {
        attributes[key] = value;
      }

      let errorCode: string | undefined;
      if (Exit.isFailure(status.exit)) {
        errorCode = "Failure";
      }

      const line = encodeJson({
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(timestampMs)),
        traceId: span.traceId,
        spanId: span.spanId,
        name: span.name,
        duration_ms: Math.round(durationMs),
        status: Exit.isSuccess(status.exit) ? "ok" : "error",
        ...(errorCode && { error_code: errorCode }),
        attributes,
      });

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const date = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path.join(tracesDir, `${date}.ndjson`), { flag: "a" });
          yield* file.writeAll(new TextEncoder().encode(`${line}\n`));
        }),
      );
    },
    (effect) => Effect.ignore(effect),
  );
