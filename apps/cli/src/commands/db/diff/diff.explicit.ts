import { isPostgresURL } from "../../../command-internal/pgdelta.ts";

/** The kinds an explicit `--from`/`--to` ref resolves to. */
export type ExplicitRefKind = "local" | "linked" | "migrations" | "url" | "unknown";

/**
 * Classifies an explicit `--from`/`--to` ref: `local`/`linked`/`migrations` are
 * the named targets; anything else must be a `postgres://` / `postgresql://`
 * URL, otherwise it is unknown.
 */
export function classifyExplicitRef(ref: string): ExplicitRefKind {
  if (ref === "local" || ref === "linked" || ref === "migrations") return ref;
  if (isPostgresURL(ref)) return "url";
  return "unknown";
}

/** Unknown-target error message; text is an established output contract. */
export function unknownTargetMessage(ref: string): string {
  return `unknown target ${JSON.stringify(ref)}: must be one of 'local', 'linked', 'migrations', or a postgres:// URL`;
}
