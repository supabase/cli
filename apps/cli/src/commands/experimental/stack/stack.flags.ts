import { Flag } from "effect/cli";

/** Fails instead of resolving when `supabase/supabase.lock` is missing or stale. */
export const frozenFlag = Flag.Boolean("frozen").pipe(
  Flag.withDescription(
    "Fail instead of updating supabase/supabase.lock when it is missing or out of date with config.toml. Implied when CI is set and the lock exists.",
  ),
  Flag.withDefault(false),
);
