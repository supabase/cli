import { Cause, Effect, Fiber, Layer, Queue, Stdio, Stream, Tracer } from "effect";
import type { Exit } from "effect";

import { makeDebugConsoleExporter } from "./exporters/debug-console.ts";
import { exportSpanToNdjson, initNdjsonExporter } from "./exporters/ndjson.ts";
import { telemetryRuntimeLayer } from "./runtime.layer.ts";
import { TelemetryRuntime } from "./runtime.service.ts";
import { Tracing } from "./tracing.service.ts";

class ExportableSpan extends Tracer.NativeSpan {
  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    private readonly queue: Queue.Queue<Tracer.Span, Cause.Done>,
  ) {
    super(options);
  }

  override attribute(key: string, value: unknown): void {
    if (key.endsWith(".header.apikey")) return;
    super.attribute(key, value);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    if (this.sampled) Queue.offerUnsafe(this.queue, this);
  }
}

export const tracingLayer = Layer.effect(
  Tracing,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const telemetryRuntime = yield* TelemetryRuntime;
    const exportSpanToDebugConsole = makeDebugConsoleExporter((line) =>
      Stream.make(line).pipe(Stream.run(stdio.stderr()), Effect.asVoid),
    );

    if (telemetryRuntime.consent === "granted") {
      yield* initNdjsonExporter(telemetryRuntime.tracesDir);
    }

    const queue = yield* Queue.unbounded<Tracer.Span, Cause.Done>();
    const exportSpan = (span: Tracer.Span) =>
      Effect.gen(function* () {
        if (telemetryRuntime.consent === "granted") {
          yield* Effect.ignore(exportSpanToNdjson(span, telemetryRuntime.tracesDir));
        }
        if (telemetryRuntime.showDebug) {
          yield* Effect.ignore(exportSpanToDebugConsole(span));
        }
      });

    const workerEffect = Queue.take(queue).pipe(
      Effect.flatMap(exportSpan),
      Effect.forever,
      Effect.catchTag("Done", () => Effect.void),
    );
    const worker = yield* Effect.forkScoped(workerEffect);
    yield* Effect.addFinalizer(() =>
      Queue.end(queue).pipe(Effect.andThen(Fiber.join(worker)), Effect.ignore),
    );

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
        const span = new ExportableSpan(options, queue);
        for (const [key, value] of Object.entries(globalAttrs)) {
          span.attribute(key, value);
        }
        return span;
      },
    });
  }),
).pipe(Layer.provide(telemetryRuntimeLayer));
