import { legacyIsPostgresURL } from "../../../shared/legacy-pgdelta.ts";

/** The kinds an explicit `--from`/`--to` ref resolves to. */
export type LegacyExplicitRefKind = "local" | "linked" | "migrations" | "url" | "unknown";

const VALID_TARGETS = new Set(["local", "linked", "migrations"]);

/**
 * Classifies an explicit `--from`/`--to` ref: `local`/`linked`/`migrations` are
 * the named targets; anything else must be a `postgres://` / `postgresql://`
 * URL, otherwise it is unknown.
 */
export function legacyClassifyExplicitRef(ref: string): LegacyExplicitRefKind {
  if (VALID_TARGETS.has(ref)) return ref as "local" | "linked" | "migrations";
  if (legacyIsPostgresURL(ref)) return "url";
  return "unknown";
}

/** Unknown-target error message; text is an established output contract. */
export function legacyUnknownTargetMessage(ref: string): string {
  return `unknown target ${JSON.stringify(ref)}: must be one of 'local', 'linked', 'migrations', or a postgres:// URL`;
}
