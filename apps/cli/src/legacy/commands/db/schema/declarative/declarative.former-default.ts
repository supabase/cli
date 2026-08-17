import { Effect, type FileSystem, Option, type Path } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import { legacyYellow } from "../../../../shared/legacy-colors.ts";
import type { LegacyPgDeltaTomlConfig } from "../../../../shared/legacy-db-config.toml-read.ts";
import { legacyResolveDeclarativeDir } from "../../../../shared/legacy-db-config.toml-read.ts";
import { legacyWalkSqlFiles } from "../../../../shared/legacy-glob.ts";

/** The default declarative directory before it moved to `supabase/schemas`. */
const FORMER_DEFAULT_SEGMENTS = ["supabase", "database"] as const;

export const legacyFormerDeclarativeDefaultWarning = (
  formerDirRel: string,
  defaultDirRel: string,
): string =>
  `${legacyYellow(
    `WARNING: found declarative schema files in ${formerDirRel}, but the default declarative directory is now ${defaultDirRel}.`,
  )}\n${legacyYellow(
    `Set declarative_schema_path = "./database" under [experimental.pgdelta] in supabase/config.toml to keep using the existing tree, or move it to ${defaultDirRel}.`,
  )}\n`;

/**
 * Warns when a project still has a declarative tree at the former default
 * `supabase/database` while relying on the implicit default, which now resolves
 * to `supabase/schemas`. Without this, an upgraded project silently stops
 * reading its existing tree: non-interactive sync reports "no declarative
 * schema found" with no hint why, and `--yes` regenerates a fresh tree that
 * ignores edits present only under the old path. TS-only guidance (no Go
 * counterpart); recorded in docs/go-cli-divergences.md.
 *
 * Fires only when all three hold: `declarative_schema_path` is unset, the new
 * default directory has no entries, and the former default contains `.sql`
 * files or an export manifest. Probe failures read as "absent" so the warning
 * can never turn an unreadable directory into a command failure.
 */
export const legacyWarnFormerDeclarativeDefault = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pgDelta: LegacyPgDeltaTomlConfig,
) {
  if (Option.isSome(pgDelta.declarativeSchemaPath)) return;
  const defaultDirRel = legacyResolveDeclarativeDir(path, pgDelta);
  const defaultEntries = yield* fs
    .readDirectory(path.resolve(workdir, defaultDirRel))
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  if (defaultEntries.length > 0) return;

  const formerDirRel = path.join(...FORMER_DEFAULT_SEGMENTS);
  const formerDir = path.resolve(workdir, formerDirRel);
  const formerSqlFiles = yield* legacyWalkSqlFiles(fs, formerDir, "").pipe(
    Effect.orElseSucceed(() => [] as string[]),
  );
  const formerHasManifest = yield* fs
    .exists(path.join(formerDir, ".pgdelta-export.json"))
    .pipe(Effect.orElseSucceed(() => false));
  if (formerSqlFiles.length === 0 && !formerHasManifest) return;

  const output = yield* Output;
  yield* output.raw(legacyFormerDeclarativeDefaultWarning(formerDirRel, defaultDirRel), "stderr");
});
