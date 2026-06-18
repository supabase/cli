import { legacyIsPostgresURL } from "../shared/legacy-pgdelta.ts";

/** The kinds an explicit `--from`/`--to` ref resolves to. */
export type LegacyExplicitRefKind = "local" | "linked" | "migrations" | "url" | "unknown";

const VALID_TARGETS = new Set(["local", "linked", "migrations"]);

/**
 * Classifies an explicit `--from`/`--to` ref. Mirrors Go's
 * `resolveExplicitDatabaseRef` validation (`internal/db/diff/explicit.go:40-71`):
 * `local`/`linked`/`migrations` are the named targets; anything else must be a
 * `postgres://` / `postgresql://` URL, otherwise it is unknown.
 */
export function legacyClassifyExplicitRef(ref: string): LegacyExplicitRefKind {
  if (VALID_TARGETS.has(ref)) return ref as "local" | "linked" | "migrations";
  if (legacyIsPostgresURL(ref)) return "url";
  return "unknown";
}

/** Go's unknown-target error message (`internal/db/diff/explicit.go:44`). */
export function legacyUnknownTargetMessage(ref: string): string {
  return `unknown target ${JSON.stringify(ref)}: must be one of 'local', 'linked', 'migrations', or a postgres:// URL`;
}
