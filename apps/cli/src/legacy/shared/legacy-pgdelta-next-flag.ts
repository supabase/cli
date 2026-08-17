export type LegacyPgDeltaImplementation = "next" | "legacy";

/** The env var name for the pg-delta implementation rollout flag. */
export const LEGACY_PG_DELTA_NEXT_FLAG_NAME = "SUPABASE_USE_PG_DELTA_NEXT";

/**
 * Combines the shell and project-`.env` values of the pg-delta rollout flag
 * into the one raw value `legacyResolvePgDeltaImplementation` consumes.
 *
 * godotenv.Load never replaces a shell value, including an empty or invalid
 * one, so presence in `process.env` must suppress the project-file fallback —
 * this is the single source of truth for that precedence; every reader of
 * this flag must combine its shell/project values through this function
 * rather than reimplementing the rule (e.g. via `envLookup`, which treats an
 * empty shell value as unset and does not apply here).
 */
export const legacyPgDeltaImplementationFlag = (
  shellValue: string | undefined,
  projectValue: string | undefined,
) => shellValue ?? projectValue;

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
