import { Flag } from "effect/cli";
import { cliFlag } from "../../../shared/cli/cli-params.ts";

/** Fails instead of resolving when `supabase/supabase.lock` is missing or stale. */
export const frozenFlag = cliFlag("frozen", Flag.Boolean, {
  description:
    "Fail instead of updating supabase/supabase.lock when it is missing or out of date with the project config file. Implied when CI is set and the lock exists.",
  default: false,
});
