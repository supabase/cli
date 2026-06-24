import {
  LEGACY_MIGRATION_VERSION_MAX,
  legacyFormatTimestampVersion,
  legacyParseMigrationVersion,
} from "../../../shared/legacy-migration-timestamp.format.ts";

/** A merged local/remote migration row. `local`/`remote` are empty when absent. */
export interface LegacyMigrationListRow {
  readonly local: string;
  readonly remote: string;
  readonly time: string;
}

/**
 * Two-pointer merge of remote + local migration versions into chronological
 * rows. Pure port of Go's `makeTable` (`internal/migration/list/list.go:38-79`)
 * minus the markdown framing: non-numeric versions are skipped, and the time
 * column uses `FormatTimestampVersion`.
 */
export function legacyMakeMigrationListRows(
  remote: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
): ReadonlyArray<LegacyMigrationListRow> {
  const rows: Array<LegacyMigrationListRow> = [];
  let i = 0;
  let j = 0;
  while (i < remote.length || j < local.length) {
    let remoteTs = LEGACY_MIGRATION_VERSION_MAX;
    if (i < remote.length) {
      const parsed = legacyParseMigrationVersion(remote[i]!);
      if (parsed === undefined) {
        i++;
        continue;
      }
      remoteTs = parsed;
    }
    let localTs = LEGACY_MIGRATION_VERSION_MAX;
    if (j < local.length) {
      const parsed = legacyParseMigrationVersion(local[j]!);
      if (parsed === undefined) {
        j++;
        continue;
      }
      localTs = parsed;
    }
    if (localTs < remoteTs) {
      rows.push({ local: local[j]!, remote: "", time: legacyFormatTimestampVersion(local[j]!) });
      j++;
    } else if (remoteTs < localTs) {
      rows.push({ local: "", remote: remote[i]!, time: legacyFormatTimestampVersion(remote[i]!) });
      i++;
    } else {
      rows.push({
        local: local[j]!,
        remote: remote[i]!,
        time: legacyFormatTimestampVersion(remote[i]!),
      });
      i++;
      j++;
    }
  }
  return rows;
}

/**
 * Renders the merged rows as the backtick-wrapped Glamour markdown cells Go
 * emits (`|`<v>`|` `|`<time>`|`): present cells are inline code spans, absent
 * cells are a single space inside backticks. AsciiStyle preserves the backticks
 * (`code.block_prefix`/`block_suffix` = "`"), so the rendered table includes them.
 */
export function legacyMigrationListTableCells(
  rows: ReadonlyArray<LegacyMigrationListRow>,
): ReadonlyArray<readonly [string, string, string]> {
  const cell = (value: string): string => (value.length > 0 ? `\`${value}\`` : "` `");
  return rows.map((row) => [cell(row.local), cell(row.remote), `\`${row.time}\``] as const);
}
