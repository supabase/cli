import {
  MIGRATION_VERSION_MAX,
  formatTimestampVersion,
  parseMigrationVersion,
  sortMigrationVersions,
} from "../../../command-internal/migration-timestamp.format.ts";

/** A merged local/remote migration row. `local`/`remote` are empty when absent. */
export interface MigrationListRow {
  readonly local: string;
  readonly remote: string;
  readonly time: string;
}

/**
 * Two-pointer merge of remote + local migration versions into chronological
 * rows: non-numeric versions are skipped, and the time column uses
 * `formatTimestampVersion`.
 */
export function makeMigrationListRows(
  remote: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
): ReadonlyArray<MigrationListRow> {
  // Local versions arrive in file-name order, which can invert `ORDER BY version`
  // order when one version is a prefix of another (supabase/cli#6036); sorted here
  // to keep the merge in sync.
  const sortedLocal = sortMigrationVersions(local);
  const rows: Array<MigrationListRow> = [];
  let i = 0;
  let j = 0;
  while (i < remote.length || j < sortedLocal.length) {
    let remoteTs = MIGRATION_VERSION_MAX;
    if (i < remote.length) {
      const parsed = parseMigrationVersion(remote[i]!);
      if (parsed === undefined) {
        i++;
        continue;
      }
      remoteTs = parsed;
    }
    let localTs = MIGRATION_VERSION_MAX;
    if (j < sortedLocal.length) {
      const parsed = parseMigrationVersion(sortedLocal[j]!);
      if (parsed === undefined) {
        j++;
        continue;
      }
      localTs = parsed;
    }
    if (localTs < remoteTs) {
      rows.push({
        local: sortedLocal[j]!,
        remote: "",
        time: formatTimestampVersion(sortedLocal[j]!),
      });
      j++;
    } else if (remoteTs < localTs) {
      rows.push({ local: "", remote: remote[i]!, time: formatTimestampVersion(remote[i]!) });
      i++;
    } else {
      rows.push({
        local: sortedLocal[j]!,
        remote: remote[i]!,
        time: formatTimestampVersion(remote[i]!),
      });
      i++;
      j++;
    }
  }
  return rows;
}

/**
 * Renders merged rows as backtick-wrapped Glamour markdown cells: present cells are
 * inline code spans, and absent cells are a lone space inside backticks so AsciiStyle
 * keeps the code-span formatting.
 */
export function migrationListTableCells(
  rows: ReadonlyArray<MigrationListRow>,
): ReadonlyArray<readonly [string, string, string]> {
  const cell = (value: string): string => (value.length > 0 ? `\`${value}\`` : "` `");
  return rows.map((row) => [cell(row.local), cell(row.remote), `\`${row.time}\``] as const);
}
