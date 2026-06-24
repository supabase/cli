import { legacyBold } from "../../../shared/legacy-colors.ts";

/**
 * `pkg/migration/file.go` — local migration filenames are `<digits>_<name>.sql`.
 * `ListLocalMigrations` guarantees every path in `localMigrations` matches, so the
 * version capture group is always present.
 */
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

/** Last path segment, mirroring Go's `filepath.Base`. */
const baseName = (path: string): string => {
  const normalized = path.replace(/[/\\]+$/u, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash === -1 ? normalized : normalized.slice(slash + 1);
};

/**
 * `pkg/migration/apply.go:14-16` — the exact error strings Go raises so the legacy
 * handler can byte-match them on stderr.
 */
export const LEGACY_ERR_MISSING_REMOTE =
  "Found local migration files to be inserted before the last migration on remote database.";
export const LEGACY_ERR_MISSING_LOCAL =
  "Remote migration versions not found in local migrations directory.";

/**
 * The outcome of comparing local migration files against the remote
 * `schema_migrations` history. Pure 1:1 port of Go's `FindPendingMigrations`
 * (`pkg/migration/apply.go:21-54`).
 *
 * - `ok`            — `pending` are the local migration paths to apply (those
 *                     beyond the remote history, in order).
 * - `missing-local` — remote has versions with no local file (`ErrMissingLocal`).
 *                     `versions` are the offending remote versions.
 * - `missing-remote`— local has files ordered before the remote head
 *                     (`ErrMissingRemote`). `paths` are the out-of-order local
 *                     migration paths.
 */
export type LegacyPendingMigrations =
  | { readonly kind: "ok"; readonly pending: ReadonlyArray<string> }
  | { readonly kind: "missing-local"; readonly versions: ReadonlyArray<string> }
  | { readonly kind: "missing-remote"; readonly paths: ReadonlyArray<string> };

/**
 * Two-pointer reconciliation of local migration paths vs remote applied versions.
 * Mirrors Go's `FindPendingMigrations` exactly, including its **string**
 * comparison of versions (`remote == local` / `remote < local`) — version
 * prefixes are fixed-width timestamps, so lexical order equals chronological
 * order, matching Go.
 */
export function legacyFindPendingMigrations(
  localMigrations: ReadonlyArray<string>,
  remoteMigrations: ReadonlyArray<string>,
): LegacyPendingMigrations {
  const unapplied: Array<string> = [];
  const missing: Array<string> = [];
  let i = 0;
  let j = 0;
  while (i < remoteMigrations.length && j < localMigrations.length) {
    const remote = remoteMigrations[i]!;
    const filename = baseName(localMigrations[j]!);
    // ListLocalMigrations guarantees a match, so the capture group is present.
    const local = MIGRATE_FILE_PATTERN.exec(filename)![1]!;
    if (remote === local) {
      i++;
      j++;
    } else if (remote < local) {
      missing.push(remote);
      i++;
    } else {
      // Include out-of-order local migrations.
      unapplied.push(localMigrations[j]!);
      j++;
    }
  }
  // Ensure all remote versions exist on local.
  if (j === localMigrations.length) {
    missing.push(...remoteMigrations.slice(i));
  }
  if (missing.length > 0) {
    return { kind: "missing-local", versions: missing };
  }
  // Enforce migrations are applied in chronological order by default.
  if (unapplied.length > 0) {
    return { kind: "missing-remote", paths: unapplied };
  }
  return { kind: "ok", pending: localMigrations.slice(remoteMigrations.length) };
}

/**
 * Computes the `--include-all` pending set when reconciliation reports
 * `missing-remote`. Mirrors Go's `GetPendingMigrations` includeAll branch
 * (`internal/migration/up/up.go:46-48`): the out-of-order paths first, then the
 * local migrations beyond `len(remote)+len(diff)`.
 */
export function legacyIncludeAllPending(
  localMigrations: ReadonlyArray<string>,
  remoteCount: number,
  diff: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [...diff, ...localMigrations.slice(remoteCount + diff.length)];
}

/**
 * Go's `suggestRevertHistory` (`internal/migration/up/up.go:55-61`). `fmt.Sprintln`
 * appends a trailing newline to each line, so the suggestion ends with `\n`.
 */
export function legacySuggestRevertHistory(versions: ReadonlyArray<string>): string {
  return (
    "\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:\n" +
    `${legacyBold(`supabase migration repair --status reverted ${versions.join(" ")}`)}\n` +
    "\nAnd update local migrations to match remote database:\n" +
    `${legacyBold("supabase db pull")}\n`
  );
}

/** Go's `suggestIgnoreFlag` (`internal/migration/up/up.go:63-67`). */
export function legacySuggestIgnoreFlag(paths: ReadonlyArray<string>): string {
  return (
    "\nRerun the command with --include-all flag to apply these migrations:\n" +
    `${legacyBold(paths.join("\n"))}\n`
  );
}
