import {
  CAPABILITY_NAMES,
  excludeStackCapabilities,
  type StackConfig,
} from "@supabase/stack/effect";

/** Optional capabilities accepted by `stack start --exclude`. */
export const STACK_START_EXCLUDABLE_CAPABILITIES = CAPABILITY_NAMES.filter(
  (name) => name !== "database",
);

/** Database-only overlay for `db start`. Do not persist this on an existing full stack. */
export const postgresOnlyStackStartConfig = (config: StackConfig): StackConfig =>
  excludeStackCapabilities(config, STACK_START_EXCLUDABLE_CAPABILITIES);
