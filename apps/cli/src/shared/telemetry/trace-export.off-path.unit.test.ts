import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, References } from "effect";
import { mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { TraceExportConfigError, withTraceExport } from "./trace-export.layer.ts";

const runtime = Layer.mergeAll(mockRuntimeInfo(), BunServices.layer);

const sinkModule = vi.hoisted(() => ({ evaluated: false }));

vi.mock("./otlp-trace-sink.ts", () => {
  sinkModule.evaluated = true;
  return {};
});

describe("withTraceExport without a sink or debug console", () => {
  it.effect("runs with the tracer disabled and never loads the OTLP sink", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.gen(function* () {
        const tracerEnabled = yield* References.TracerEnabled;
        const span = yield* Effect.currentSpan;
        return { tracerEnabled, spanName: span.name, spanAttributes: span.attributes.size };
      }).pipe(
        Effect.withSpan("Probe.span", { attributes: { a: 1 } }),
        withTraceExport({ sink: Option.none(), debugConsole: false }, {}),
        Effect.provide(runtime),
      );

      expect(observed).toEqual({ tracerEnabled: false, spanName: "Probe.span", spanAttributes: 0 });
      expect(sinkModule.evaluated).toBe(false);
    }),
  );

  it.effect("loads the sink module once a sink is configured", () =>
    Effect.gen(function* () {
      const error = yield* Effect.void.pipe(
        withTraceExport(
          { sink: Option.some({ _tag: "File", path: "/unused" }), debugConsole: false },
          {},
        ),
        Effect.provide(runtime),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(TraceExportConfigError);
      expect(sinkModule.evaluated).toBe(true);
    }),
  );
});
