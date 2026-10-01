/**
 * Summarizes a `SUPABASE_TRACE_FILE` trace: heaviest path, top self time, repeated span names,
 * and failures. Run as `bun scripts/trace-report.ts <trace-file> [--top N] [--json]`.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Schema, Stdio } from "effect";

const KeyValues = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
  }),
);

const stringAttribute = (attributes: typeof KeyValues.Type | undefined, key: string) =>
  attributes?.find((attribute) => attribute.key === key)?.value.stringValue;

/** Labels container CLI spans with their verb so `pull` and `run` report separately. */
export function reportSpanName(name: string, subcommand: string | undefined): string {
  return subcommand === undefined ? name : `${name} (${subcommand})`;
}

const OtlpSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  name: Schema.String,
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  status: Schema.Struct({ code: Schema.Number }),
  attributes: Schema.optional(KeyValues),
  events: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, attributes: KeyValues })),
  ),
});

const TraceBatch = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(OtlpSpan) })),
      }),
    ),
  }),
);

export interface ReportSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly failed: boolean;
  readonly errorType: string | undefined;
}

export interface TraceReport {
  readonly spanCount: number;
  readonly criticalPath: ReadonlyArray<{ readonly name: string; readonly durationMs: number }>;
  readonly topSelfTime: ReadonlyArray<{ readonly name: string; readonly selfMs: number }>;
  readonly repeated: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly totalMs: number;
  }>;
  readonly failures: ReadonlyArray<{
    readonly name: string;
    readonly errorType: string | undefined;
  }>;
}

const STATUS_ERROR = 2;
const nanosToMs = (value: string) => Number(BigInt(value) / 1_000n) / 1_000;
const round = (value: number) => Math.round(value * 100) / 100;

function coveredMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const [start, end] of sorted) {
    if (current === undefined || start > current[1]) {
      if (current !== undefined) total += current[1] - current[0];
      current = [start, end];
    } else {
      current[1] = Math.max(current[1], end);
    }
  }
  return current === undefined ? total : total + current[1] - current[0];
}

/** Builds the report from decoded spans. */
export function analyzeTrace(spans: ReadonlyArray<ReportSpan>, top: number): TraceReport {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, Array<ReportSpan>>();
  for (const span of spans) {
    if (span.parentSpanId === undefined || !ids.has(span.parentSpanId)) continue;
    const siblings = children.get(span.parentSpanId) ?? [];
    siblings.push(span);
    children.set(span.parentSpanId, siblings);
  }

  const roots = spans
    .filter((span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId))
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs));
  const criticalPath: Array<{ name: string; durationMs: number }> = [];
  let node = roots[0];
  while (node !== undefined) {
    criticalPath.push({ name: node.name, durationMs: round(node.endMs - node.startMs) });
    const next = children.get(node.spanId);
    node = next?.reduce((longest, child) =>
      child.endMs - child.startMs > longest.endMs - longest.startMs ? child : longest,
    );
  }

  const selfByName = new Map<string, number>();
  const repeatedByName = new Map<string, { count: number; totalMs: number }>();
  for (const span of spans) {
    const duration = span.endMs - span.startMs;
    const childIntervals = (children.get(span.spanId) ?? []).map(
      (child) =>
        [Math.max(child.startMs, span.startMs), Math.min(child.endMs, span.endMs)] as const,
    );
    const self = Math.max(0, duration - coveredMs(childIntervals));
    selfByName.set(span.name, (selfByName.get(span.name) ?? 0) + self);
    const entry = repeatedByName.get(span.name) ?? { count: 0, totalMs: 0 };
    repeatedByName.set(span.name, { count: entry.count + 1, totalMs: entry.totalMs + duration });
  }

  return {
    spanCount: spans.length,
    criticalPath,
    topSelfTime: [...selfByName]
      .map(([name, selfMs]) => ({ name, selfMs: round(selfMs) }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, top),
    repeated: [...repeatedByName]
      .filter(([, entry]) => entry.count > 1)
      .map(([name, entry]) => ({ name, count: entry.count, totalMs: round(entry.totalMs) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
    failures: spans
      .filter((span) => span.failed)
      .map((span) => ({ name: span.name, errorType: span.errorType })),
  };
}

function formatReport(report: TraceReport): string {
  const lines = [`spans: ${report.spanCount}`, "", "critical path:"];
  report.criticalPath.forEach((step, depth) =>
    lines.push(`  ${"  ".repeat(depth)}${step.name} ${step.durationMs}ms`),
  );
  lines.push("", "top self time:");
  for (const entry of report.topSelfTime) lines.push(`  ${entry.selfMs}ms  ${entry.name}`);
  lines.push("", "repeated spans:");
  for (const entry of report.repeated) {
    lines.push(`  ${entry.count}x  ${entry.totalMs}ms  ${entry.name}`);
  }
  lines.push("", "failures:");
  if (report.failures.length === 0) lines.push("  none");
  for (const failure of report.failures) {
    lines.push(
      `  ${failure.name}${failure.errorType === undefined ? "" : `: ${failure.errorType}`}`,
    );
  }
  return lines.join("\n");
}

/** Decodes a `SUPABASE_TRACE_FILE`'s OTLP/JSON lines into flat spans. */
export const readSpans = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);
  const spans: Array<ReportSpan> = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const batch = yield* Schema.decodeUnknownEffect(TraceBatch)(line);
    for (const resource of batch.resourceSpans) {
      for (const scope of resource.scopeSpans) {
        for (const span of scope.spans) {
          spans.push({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: reportSpanName(span.name, stringAttribute(span.attributes, "process.subcommand")),
            startMs: nanosToMs(span.startTimeUnixNano),
            endMs: nanosToMs(span.endTimeUnixNano),
            failed: span.status.code === STATUS_ERROR,
            errorType: stringAttribute(
              span.events?.find((event) => event.name === "exception")?.attributes,
              "exception.type",
            ),
          });
        }
      }
    }
  }
  return spans;
});

const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const json = args.includes("--json");
  const topIndex = args.indexOf("--top");
  const top = topIndex === -1 ? 15 : Number(args[topIndex + 1] ?? 15);
  const file = args.find(
    (arg, index) => !arg.startsWith("--") && (topIndex === -1 || index !== topIndex + 1),
  );
  if (file === undefined) {
    return yield* Effect.fail(
      new Error("usage: bun scripts/trace-report.ts <trace-file> [--top N] [--json]"),
    );
  }
  const report = analyzeTrace(yield* readSpans(file), top);
  yield* Console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
