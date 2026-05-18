import type { Effect } from "effect";
import { Context } from "effect";

interface AnalyticsShape {
  readonly capture: (event: string, properties?: Record<string, unknown>) => Effect.Effect<void>;
  readonly identify: (
    distinctId: string,
    properties?: Record<string, unknown>,
  ) => Effect.Effect<void>;
  readonly alias: (distinctId: string, alias: string) => Effect.Effect<void>;
  readonly groupIdentify: (
    groupType: string,
    groupKey: string,
    properties?: Record<string, unknown>,
  ) => Effect.Effect<void>;
}

export class Analytics extends Context.Service<Analytics, AnalyticsShape>()(
  "supabase/telemetry/Analytics",
) {}
