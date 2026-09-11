import { CAPABILITY_NAMES } from "@supabase/stack/effect";

/** Optional capabilities accepted by `stack start --exclude`. */
export const STACK_START_EXCLUDABLE_CAPABILITIES = CAPABILITY_NAMES.filter(
  (name) => name !== "database",
);
