import { appendFileSync } from "node:fs";
import { Effect, FileSystem, Path } from "effect";
import type { Tracer } from "effect";

const RETENTION_DAYS = 7;

export const initNdjsonExporter = Effect.fnUntraced(
  function* (tracesDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(tracesDir, { recursive: true, mode: 0o700 });

    const files = yield* fs.readDirectory(tracesDir);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const dateStr = file.replace(".ndjson", "");
      const fileDate = new Date(dateStr).getTime();
      if (!Number.isNaN(fileDate) && fileDate < cutoff) {
        yield* fs.remove(path.join(tracesDir, file));
      }
    }
  },
  (effect, _tracesDir) => Effect.ignore(effect),
);

export function exportSpanToNdjson(span: Tracer.Span, tracesDir: string): void {
  const status = span.status;
  if (status._tag !== "Ended") return;

  const durationMs = Number(status.endTime - status.startTime) / 1_000_000;
  const timestampMs = Number(status.startTime / BigInt(1_000_000));

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of span.attributes) {
    attributes[key] = value;
  }

  let errorCode: string | undefined;
  if (status.exit._tag !== "Success") {
    const exitStr = JSON.stringify(status.exit);
    const match = exitStr.match(/"_tag"\s*:\s*"([^"]+)"/);
    if (match) errorCode = match[1];
  }

  const line = JSON.stringify({
    timestamp: new Date(timestampMs).toISOString(),
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    duration_ms: Math.round(durationMs),
    status: status.exit._tag === "Success" ? "ok" : "error",
    ...(errorCode && { error_code: errorCode }),
    attributes,
  });

  try {
    const date = new Date().toISOString().split("T")[0];
    appendFileSync(`${tracesDir}/${date}.ndjson`, `${line}\n`);
  } catch {
    // ignore write errors
  }
}
