import { Exit, Option, Tracer } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- benchmark spans append synchronously when ended.
import { appendFileSync } from "node:fs";

// oxlint-disable-next-line effecttsgo/process-env -- the benchmark path is inherited by detached runtimes.
const traceFile = process.env.SUPABASE_STARTUP_SPANS_FILE;

const safeAttributes = (attributes: ReadonlyMap<string, unknown>) =>
  Object.fromEntries(
    Array.from(attributes).filter(
      ([key]) =>
        !/(?:token|password|secret|apikey|authorization|credential|database.?url|connection.?string|jwt|private.?key|device.?id|session.?id)/iu.test(
          key,
        ),
    ),
  );

/** Native Effect span that appends benchmark-only JSONL when explicitly enabled. */
export class StartupTraceSpan extends Tracer.NativeSpan {
  // oxlint-disable-next-line effecttsgo/global-date -- benchmark spans need wall-clock alignment across processes.
  private readonly epochStartMs = traceFile === undefined ? undefined : Date.now();

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    if (traceFile === undefined || this.epochStartMs === undefined || !this.sampled) return;
    const durationMs = Number(endTime - this.startTime) / 1_000_000;
    const parent = Option.getOrUndefined(this.parent);
    const row = {
      epoch_ms: this.epochStartMs,
      end_epoch_ms: this.epochStartMs + durationMs,
      duration_ms: durationMs,
      pid: process.pid,
      event: this.name,
      trace_id: this.traceId,
      span_id: this.spanId,
      ...(parent === undefined ? {} : { parent_span_id: parent.spanId }),
      status: Exit.isSuccess(exit) ? "ok" : "error",
      attributes: safeAttributes(this.attributes),
    };
    try {
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- this local benchmark sink is intentionally best-effort.
      appendFileSync(traceFile, `${JSON.stringify(row)}\n`, { encoding: "utf8" });
    } catch {
      // Benchmark output must not change application error behavior.
    }
  }
}

/** Creates the benchmark tracer used by detached stack hosts and direct API runners. */
export const startupTracingTracer = Tracer.make({
  span: (options) => new StartupTraceSpan(options),
});
