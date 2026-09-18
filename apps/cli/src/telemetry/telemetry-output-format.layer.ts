import { Effect, Layer, Option, Ref } from "effect";

import { TelemetryOutputFormat } from "./telemetry-output-format.service.ts";

/**
 * Command-scoped cell for the resolved telemetry `output_format`. A handler that
 * resolves its own `--output` (e.g. `db query`) writes the resolved value here, and
 * `withCommandTelemetry` prefers it over the default derivation. Read
 * optionally via `Effect.serviceOption`, so commands that don't provide this layer
 * are unaffected.
 */
export const telemetryOutputFormatLayer = Layer.effect(
  TelemetryOutputFormat,
  Effect.gen(function* () {
    const ref = yield* Ref.make(Option.none<string>());
    return TelemetryOutputFormat.of({
      set: (format) => Ref.set(ref, Option.some(format)),
      get: Ref.get(ref),
    });
  }),
);
