import { Config } from "effect";

/** Slim image repositories, `ghcr.io/supabase/cli/<service>`; catalog pins always name this host. */
export const SLIM_IMAGE_GHCR_REGISTRY = "ghcr.io/supabase/cli/";

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/u, "");

/**
 * Base URL of the slim-services release downloads, `<base>/<tag>/<asset>`. Overridable through
 * `SUPABASE_INTERNAL_SLIM_RELEASES_URL`, which a spawned stack owner inherits with the rest of the
 * process environment.
 */
export const slimReleasesUrl = Config.NonEmptyString("SUPABASE_INTERNAL_SLIM_RELEASES_URL").pipe(
  Config.withDefault("https://github.com/supabase/slim-services/releases/download"),
  Config.map(trimTrailingSlashes),
);

/** Origin of the registry API serving the slim images, overridable through `SUPABASE_INTERNAL_SLIM_REGISTRY_URL`. */
export const slimRegistryUrl = Config.NonEmptyString("SUPABASE_INTERNAL_SLIM_REGISTRY_URL").pipe(
  Config.withDefault("https://ghcr.io"),
  Config.map(trimTrailingSlashes),
);
