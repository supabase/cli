import type { Effect } from "effect";
import { Context } from "effect";

interface LegacyTelemetryStateShape {
  /**
   * Persists the legacy telemetry state to disk (matches Go's
   * `LoadOrCreateState` in `apps/cli-go/internal/telemetry/state.go:74-98`).
   *
   * Best-effort: any filesystem error is swallowed.
   */
  readonly flush: Effect.Effect<void>;
}

export class LegacyTelemetryState extends Context.Service<
  LegacyTelemetryState,
  LegacyTelemetryStateShape
>()("supabase/legacy/TelemetryState") {}
