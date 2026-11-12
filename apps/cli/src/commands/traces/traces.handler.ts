import { Effect, Option } from "effect";

import { resolveProjectTarget } from "../../command-internal/target/resolve-project-target.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { supportsColor } from "../../command-internal/colors.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/output-formats.ts";
import { fetchTraceSpans, type TraceSpanResource } from "./traces.api.ts";
import {
  TracesMissingTraceIdError,
  TracesNotFoundError,
  TracesOutputFlagUnsupportedError,
} from "./traces.errors.ts";
import { renderTrace, type TraceRenderInput } from "./traces.render.ts";
import {
  buildSpanTree,
  flattenSpanTree,
  summarizeTrace,
  type TraceSpanRecord,
} from "./traces.tree.ts";
import type { TracesFlags } from "./traces.command.ts";

function toRenderSpan(resource: TraceSpanResource): TraceRenderInput["spans"][number] {
  const { attributes } = resource;
  const startMs = Date.parse(attributes.start_time);
  return {
    spanId: resource.id,
    parentSpanId: attributes.parent_span_id ?? undefined,
    name: attributes.span_name,
    serviceName: attributes.service_name,
    startMs: Number.isNaN(startMs) ? 0 : startMs,
    endMs: (Number.isNaN(startMs) ? 0 : startMs) + attributes.duration_ns / 1_000_000,
    isError: attributes.status_code.toLowerCase() === "error",
  };
}

function toTreeRecord(span: TraceRenderInput["spans"][number]): TraceSpanRecord {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    label: span.name,
    startMs: span.startMs,
    endMs: span.endMs,
    isError: span.isError,
  };
}

export const tracesGet = Effect.fn("Traces.get")(function* (flags: TracesFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const tty = yield* Tty;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  if (Option.isSome(outputFlag)) {
    return yield* new TracesOutputFlagUnsupportedError({
      message: unsupportedOutputFlagMessage("traces"),
    });
  }

  if (Option.isNone(flags.traceId)) {
    return yield* new TracesMissingTraceIdError();
  }
  const traceId = flags.traceId.value;

  yield* Effect.gen(function* () {
    const ref = yield* resolveProjectTarget(flags);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Fetching trace...") : undefined;
      const response = yield* fetchTraceSpans(ref, traceId).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
      );
      yield* fetching?.clear ?? Effect.void;

      if (response.data.length === 0) {
        return yield* new TracesNotFoundError();
      }

      const renderSpans = response.data.map(toRenderSpan);

      if (output.format === "json" || output.format === "stream-json") {
        const summary = summarizeTrace(
          flattenSpanTree(buildSpanTree(renderSpans.map(toTreeRecord))),
        );
        yield* output.success("", {
          trace_id: traceId,
          spans: response.data,
          partial: response.meta.partial,
          duration_ms: summary.durationMs,
          span_count: summary.spanCount,
          error_span_ids: summary.errorSpanIds,
          slowest_span_id: summary.slowestNonRootSpanId,
        });
        return;
      }

      yield* output.raw(
        renderTrace(
          { traceId, spans: renderSpans },
          {
            fancy: supportsColor({ hasColors: () => tty.stdoutIsTty }),
            terminalWidth: tty.stdoutColumns,
          },
        ),
      );
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
