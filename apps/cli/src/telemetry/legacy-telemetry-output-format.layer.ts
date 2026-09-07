import { Effect, Layer, Option, Ref } from "effect";

import { LegacyTelemetryOutputFormat } from "./legacy-telemetry-output-format.service.ts";

/**
 * Command-scoped cell for the resolved telemetry `output_format`. A handler that
 * resolves its own `--output` (e.g. `db query`) writes the resolved value here, and
 * `withLegacyCommandInstrumentation` prefers it over the default derivation. Read
 * optionally via `Effect.serviceOption`, so commands that don't provide this layer
 * are unaffected.
 */
export const legacyTelemetryOutputFormatLayer = Layer.effect(
  LegacyTelemetryOutputFormat,
  Effect.gen(function* () {
    const ref = yield* Ref.make(Option.none<string>());
    return LegacyTelemetryOutputFormat.of({
      set: (format) => Ref.set(ref, Option.some(format)),
      get: Ref.get(ref),
    });
  }),
);
