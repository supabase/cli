import type { ApiClient } from "@supabase/api/effect";
import { type Effect, Context } from "effect";

export class LegacyPlatformApi extends Context.Service<LegacyPlatformApi, ApiClient>()(
  "supabase/legacy/PlatformApi",
) {}

export interface LegacyPlatformApiFactoryShape {
  readonly make: Effect.Effect<ApiClient, unknown>;
}

export class LegacyPlatformApiFactory extends Context.Service<
  LegacyPlatformApiFactory,
  LegacyPlatformApiFactoryShape
>()("supabase/legacy/PlatformApiFactory") {}
