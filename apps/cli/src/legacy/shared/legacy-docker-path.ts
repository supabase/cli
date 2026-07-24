/**
 * Translate an absolute host path to its in-container mount path. Mirrors Go's
 * `utils.ToDockerPath` (`apps/cli-go/internal/utils/deno.go:268-272`): strip a
 * Windows volume name (`C:`) and convert backslashes to forward slashes.
 *
 * Hoisted out of `db/test`'s `db.pg-prove-args.ts` (its original, single-command
 * home) once `start`'s pg-meta/Studio service builders needed the same
 * translation for their bind-mount paths — see `apps/cli/CLAUDE.md`'s "Hoist
 * Before You Duplicate" rule ("used by ≥2 commands across families").
 */
export function legacyToDockerPath(absHostPath: string): string {
  const slashed = absHostPath.replaceAll("\\", "/");
  const volumeMatch = /^[A-Za-z]:/.exec(absHostPath);
  return volumeMatch === null ? slashed : slashed.slice(volumeMatch[0].length);
}
