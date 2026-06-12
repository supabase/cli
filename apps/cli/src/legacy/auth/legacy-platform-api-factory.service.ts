import type { ApiClient, SupabaseApiConfigError } from "@supabase/api/effect";
import { type Effect, Context } from "effect";

import type {
  LegacyInvalidAccessTokenError,
  LegacyPlatformAuthRequiredError,
} from "./legacy-errors.ts";

/**
 * Lazy accessor for the typed Management API client.
 *
 * Unlike `LegacyPlatformApi`, whose layer resolves an access token when the
 * command runtime is built, `make` defers client construction until a command
 * branch actually reaches a Management API call.
 */
export interface LegacyPlatformApiFactoryShape {
  readonly make: Effect.Effect<
    ApiClient,
    LegacyInvalidAccessTokenError | LegacyPlatformAuthRequiredError | SupabaseApiConfigError
  >;
}

export class LegacyPlatformApiFactory extends Context.Service<
  LegacyPlatformApiFactory,
  LegacyPlatformApiFactoryShape
>()("supabase/legacy/PlatformApiFactory") {}
