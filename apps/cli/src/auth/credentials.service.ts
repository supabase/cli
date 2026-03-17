import type { Effect, Option, Redacted } from "effect";
import { ServiceMap } from "effect";

/**
 * Credentials - Boundary for loading and persisting the CLI access token.
 *
 * The implementation owns fallback policy between keyring-backed storage and the
 * filesystem so command handlers can treat token storage as one stable service.
 */
interface CredentialsShape {
  readonly getAccessToken: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  readonly saveAccessToken: (token: string | Redacted.Redacted<string>) => Effect.Effect<void>;
}

/**
 * Credentials - Service tag for access token persistence.
 */
export class Credentials extends ServiceMap.Service<Credentials, CredentialsShape>()(
  "@supabase/cli/auth/Credentials",
) {}
