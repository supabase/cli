/**
 * Classifies every root global flag as having no effect on which API operations a command calls.
 * A command overrides this where a global flag does change its calls (e.g. `--experimental`) by
 * naming the flag in a `when` condition on the affected operation entries instead of relying on
 * this list.
 *
 * This set is checked against the root command's actual global flags by
 * `command-permissions.unit.test.ts`, so an added or renamed global flag fails that test instead
 * of silently going unclassified.
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
