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
  /**
   * Aliases the device id to the resolved gotrue id and persists it as the
   * telemetry `distinct_id`. Mirrors Go's `Service.StitchLogin`
   * (`service.go:132-143`): the alias is sent through the Analytics layer
   * (which gates delivery on consent), and `distinct_id` is **always** written
   * to `telemetry.json` — replacing any stale value.
   *
   * Best-effort: filesystem / analytics errors are swallowed.
   */
  readonly stitchLogin: (distinctId: string) => Effect.Effect<void>;
  /**
   * Clears the persisted telemetry `distinct_id`. Mirrors Go's
   * `Service.ClearDistinctID` (`service.go:145-151`).
   *
   * Best-effort: any filesystem error is swallowed.
   */
  readonly clearDistinctId: Effect.Effect<void>;
}

export class LegacyTelemetryState extends Context.Service<
  LegacyTelemetryState,
  LegacyTelemetryStateShape
>()("supabase/legacy/TelemetryState") {}
