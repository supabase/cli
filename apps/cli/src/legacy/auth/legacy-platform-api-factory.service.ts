import type { ApiClient, SupabaseApiConfigError } from "@supabase/api/effect";
import { type Effect, Context } from "effect";

import type {
  LegacyInvalidAccessTokenError,
  LegacyPlatformAuthRequiredError,
} from "./legacy-errors.ts";

/**
 * The error `make` can fail with when it lazily resolves the access token and
 * constructs the typed client. Surfaces only when a command branch actually
 * reaches a Management API call — never at layer build — so consumers that route
 * through the lazy factory (e.g. the `--linked` db-config resolver) must include
 * it in their own effect error channel rather than a layer-build error channel.
 */
export type LegacyPlatformApiFactoryError =
  | LegacyInvalidAccessTokenError
  | LegacyPlatformAuthRequiredError
  | SupabaseApiConfigError;

/**
 * Lazy accessor for the typed Management API client.
 *
 * Unlike `LegacyPlatformApi`, whose layer resolves an access token when the
 * command runtime is built, `make` defers client construction until a command
 * branch actually reaches a Management API call.
 */
export interface LegacyPlatformApiFactoryShape {
  readonly make: Effect.Effect<ApiClient, LegacyPlatformApiFactoryError>;
}

export class LegacyPlatformApiFactory extends Context.Service<
  LegacyPlatformApiFactory,
  LegacyPlatformApiFactoryShape
>()("supabase/legacy/PlatformApiFactory") {}
