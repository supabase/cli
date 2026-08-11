import type { Path } from "effect";

import { legacySplitAndTrim } from "./legacy-sql-split.ts";

type LegacyMigrationTransactionMode = "transactional" | "none";

export interface LegacyParsedMigrationContent {
  readonly statements: ReadonlyArray<string>;
  readonly transactionMode: LegacyMigrationTransactionMode;
}

const PG_DELTA_NO_TRANSACTION_DIRECTIVE = "-- pg-delta: transaction=false";

/**
 * Parses the durable execution metadata and SQL statements in a migration file.
 * Pg-delta writes its no-transaction directive as the first line because migration
 * apply commands only retain the generated file, not the in-memory plan metadata.
 * The exact directive may follow a UTF-8 BOM and may end with LF or CRLF. Marker-like
 * comments anywhere else remain ordinary SQL comments and preserve the established
 * transactional default.
 */
export function legacyParseMigrationContent(content: string): LegacyParsedMigrationContent {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const firstNewline = withoutBom.indexOf("\n");
  const rawFirstLine = firstNewline < 0 ? withoutBom : withoutBom.slice(0, firstNewline);
  const firstLine = rawFirstLine.endsWith("\r") ? rawFirstLine.slice(0, -1) : rawFirstLine;

  if (firstLine === PG_DELTA_NO_TRANSACTION_DIRECTIVE) {
    return {
      statements: legacySplitAndTrim(withoutBom),
      transactionMode: "none",
    };
  }

  return {
    statements: legacySplitAndTrim(content),
    transactionMode: "transactional",
  };
}

/**
 * Go's `GetCurrentTimestamp` (`apps/cli-go/internal/utils/misc.go:130`): the
 * current time formatted UTC as `YYYYMMDDHHMMSS` (Go's `layoutVersion`
 * `20060102150405`). Takes the epoch millis (from `Clock.currentTimeMillis`) so
 * it stays deterministic under test.
 */
export function legacyFormatMigrationTimestamp(millis: number): string {
  return new Date(millis).toISOString().replace(/\D/gu, "").slice(0, 14);
}

/**
 * Go's `new.GetMigrationPath` (`apps/cli-go/internal/migration/new/new.go:31`):
 * `<workdir>/supabase/migrations/<timestamp>_<name>.sql`. Returned absolute so
 * callers can write it regardless of the process CWD (Go chdir's into the workdir
 * in its persistent pre-run; the native shell resolves against it explicitly).
 */
export function legacyGetMigrationPath(
  path: Path.Path,
  workdir: string,
  timestamp: string,
  name: string,
): string {
  return path.join(workdir, "supabase", "migrations", `${timestamp}_${name}.sql`);
}
