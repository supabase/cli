import type { Effect } from "effect";
import { Context } from "effect";

interface TelemetryStateShape {
  /** Persists the telemetry state to disk. Best-effort: any filesystem error is swallowed. */
  readonly flush: Effect.Effect<void>;
  /**
   * Aliases the device id to the resolved gotrue id and persists it as the telemetry
   * `distinct_id`. The alias is sent through the Analytics layer (which gates delivery on
   * consent), and `distinct_id` is always written to `telemetry.json`, replacing any stale value.
   * Best-effort: filesystem/analytics errors are swallowed.
   */
  readonly stitchLogin: (distinctId: string) => Effect.Effect<void>;
  /**
   * Logout-only: forgets the user and rotates the persisted `device_id`, so a later login as a
   * different account aliases a fresh device instead of one already merged into the previous
   * user's person graph.
   */
  readonly resetIdentity: Effect.Effect<void>;
  /** Clears the persisted telemetry `distinct_id`. Best-effort: any filesystem error is swallowed. */
  readonly clearDistinctId: Effect.Effect<void>;
}

export class TelemetryState extends Context.Service<TelemetryState, TelemetryStateShape>()(
  "supabase/cli/TelemetryState",
) {}
