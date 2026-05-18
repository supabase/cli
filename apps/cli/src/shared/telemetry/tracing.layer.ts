import { Effect, Layer, Option, Stdio, Stream, Tracer } from "effect";
import type { Exit, Context } from "effect";

import { makeDebugConsoleExporter } from "./exporters/debug-console.ts";
import { exportSpanToNdjson, initNdjsonExporter } from "./exporters/ndjson.ts";
import { telemetryRuntimeLayer } from "./runtime.layer.ts";
import { TelemetryRuntime } from "./runtime.service.ts";
import { Tracing } from "./tracing.service.ts";

/**
 * tracingLayer - CLI tracing implementation.
 *
 * This layer owns telemetry bootstrap, consent evaluation, identifier loading,
 * and exporter wiring. Commands only depend on the `Tracing` service tag.
 */
function generateHexId(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

class ExportableSpan implements Tracer.Span {
  readonly _tag = "Span" as const;
  readonly spanId: string;
  readonly traceId: string;
  readonly sampled: boolean;
  readonly name: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Context.Context<never>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown> = new Map();

  private readonly onEnd: (span: ExportableSpan) => void;

  constructor(
    options: {
      readonly name: string;
      readonly parent: Option.Option<Tracer.AnySpan>;
      readonly annotations: Context.Context<never>;
      readonly links: Array<Tracer.SpanLink>;
      readonly startTime: bigint;
      readonly kind: Tracer.SpanKind;
      readonly sampled: boolean;
    },
    onEnd: (span: ExportableSpan) => void,
  ) {
    this.name = options.name;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = options.links;
    this.kind = options.kind;
    this.sampled = options.sampled;
    this.status = { _tag: "Started", startTime: options.startTime };
    this.traceId = Option.match(options.parent, {
      onNone: () => generateHexId(32),
      onSome: (parent) => parent.traceId,
    });
    this.spanId = generateHexId(16);
    this.onEnd = onEnd;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    this.onEnd(this);
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
  }

  event(_name: string, _startTime: bigint, _attributes?: Record<string, unknown>): void {}

  addLinks(_links: ReadonlyArray<Tracer.SpanLink>): void {}
}

export const tracingLayer = Layer.effect(
  Tracing,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const telemetryRuntime = yield* TelemetryRuntime;
    const exportSpanToDebugConsole = makeDebugConsoleExporter((line) => {
      Effect.runFork(Stream.make(line).pipe(Stream.run(stdio.stderr()), Effect.ignore));
    });

    // Exporters are gated by consent/debug flags before spans start flowing.
    if (telemetryRuntime.consent === "granted") {
      yield* initNdjsonExporter(telemetryRuntime.tracesDir);
    }

    function onSpanEnd(span: ExportableSpan): void {
      if (!span.sampled) return;
      if (telemetryRuntime.consent === "granted") {
        exportSpanToNdjson(span, telemetryRuntime.tracesDir);
      }
      if (telemetryRuntime.showDebug) {
        exportSpanToDebugConsole(span);
      }
    }

    // Global attributes are attached once here so individual commands stay lean.
    const globalAttrs: Record<string, unknown> = {
      schema_version: 1,
      device_id: telemetryRuntime.deviceId,
      session_id: telemetryRuntime.sessionId,
      is_first_run: telemetryRuntime.isFirstRun,
      is_tty: telemetryRuntime.isTty,
      is_ci: telemetryRuntime.isCi,
      os: telemetryRuntime.os,
      arch: telemetryRuntime.arch,
      cli_version: telemetryRuntime.cliVersion,
    };

    return Tracer.make({
      span(options) {
        const span = new ExportableSpan(options, onSpanEnd);
        for (const [key, value] of Object.entries(globalAttrs)) {
          span.attribute(key, value);
        }
        return span;
      },
    });
  }),
).pipe(Layer.provide(telemetryRuntimeLayer));
