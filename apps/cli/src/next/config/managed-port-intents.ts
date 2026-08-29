import type { PromiseStackConfig } from "@supabase/stack";

/** Port configuration now belongs to the stack compiler; CLI no longer persists a parallel document. */
export const managedPortIntents = (_config: PromiseStackConfig, _loaded?: unknown): undefined =>
  undefined;
