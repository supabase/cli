import type { ApiClient, SupabaseApiConfigError } from "@supabase/api/effect";
import { type Effect, Context } from "effect";

import type {
  LegacyInvalidAccessTokenError,
  LegacyPlatformAuthRequiredError,
} from "./legacy-errors.ts";

/**
 * Lazy accessor for the typed Management API client.
 *
 * Unlike `LegacyPlatformApi` (built eagerly by `legacyPlatformApiLayer`, which
 * resolves an access token at layer-build time), `make` defers construction
 * until it is yielded. This lets tokenless command paths — `gen types --local`,
 * `gen types --db-url`, the `services` local matrix, and the project-ref
 * resolver's TTY prompt — run without an access token, only requiring one when
 * a Management API call is genuinely reached.
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
