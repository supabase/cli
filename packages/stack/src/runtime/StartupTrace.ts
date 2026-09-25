import { Clock, Config, Effect, Option } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Benchmark traces must be shared by detached hosts.
import { appendFileSync } from "node:fs";

export const startupTrace = (
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const file = yield* Config.option(Config.string("SUPABASE_STARTUP_TRACE_FILE"));
    if (Option.isNone(file) || file.value.length === 0) return;
    const epochMillis = yield* Clock.currentTimeMillis;
    yield* Effect.sync(() => {
      try {
        appendFileSync(
          file.value,
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Benchmark JSONL fields vary by event.
          `${JSON.stringify({ epoch_ms: epochMillis, pid: process.pid, event, ...fields })}\n`,
        );
      } catch {
        // Tracing must not change startup behavior.
      }
    });
  }).pipe(Effect.ignore);
