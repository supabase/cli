/**
 * Classifies every root global flag as having no effect on which API operations a command calls.
 * A command overrides this where a global flag does change its calls (e.g. `--experimental`) by
 * naming the flag in a `when` condition on the affected operation entries instead of relying on
 * this list.
 */
export const GLOBAL_NO_API_EFFECT_FLAGS: ReadonlyArray<string> = [
  "output",
  "output-format",
  "profile",
  "debug",
  "workdir",
  "experimental",
  "network-id",
  "yes",
  "dns-resolver",
  "create-ticket",
  "agent",
];
