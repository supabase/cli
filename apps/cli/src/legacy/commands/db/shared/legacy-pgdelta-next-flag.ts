export type LegacyPgDeltaImplementation = "next" | "legacy";

/**
 * Resolves the pg-delta implementation rollout flag from one raw environment
 * value. Defaults to the next implementation when unset or not an explicit
 * false; only known false spellings select the legacy implementation.
 *
 * The caller owns reading `process.env`, allowing the strategy boundary to
 * resolve the selection exactly once per command invocation.
 */
export function legacyResolvePgDeltaImplementation(
  raw: string | undefined,
): LegacyPgDeltaImplementation {
  switch (raw?.toLowerCase()) {
    case "0":
    case "f":
    case "false":
      return "legacy";
    default:
      return "next";
  }
}
