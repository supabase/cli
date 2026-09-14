import { Effect, type FileSystem, type Path } from "effect";
import { classifySqlFiles } from "@supabase/pg-delta/frontends";

import { Output } from "../../../shared/output/output.service.ts";
import { bold, yellow } from "../../../command-internal/colors.ts";
import { walkSqlFiles } from "../../../command-internal/glob.ts";
import { DeclarativeWriteError } from "./pgdelta.errors.ts";
import { ReadPgDeltaExportManifest } from "./pgdelta-files.ts";
import type {
  PgDeltaDeclarativeExportResult,
  PgDeltaExportManifest,
} from "./pgdelta-engine.service.ts";

const EXPORT_MANIFEST_FILE = ".pgdelta-export.json";

function declarativeWriteError(message: string): DeclarativeWriteError {
  return new DeclarativeWriteError({ message });
}

/**
 * What a declarative write left behind, so the calling handler (which owns
 * {@link Output}) can tell the user about it.
 */
export interface DeclarativeWriteResult {
  /**
   * Pre-existing `.sql` files the writer preserved because no export manifest
   * claimed ownership of them — see
   * {@link preservedUnmanagedDeclarativeFilesWarning}.
   */
  readonly preservedUnmanagedFiles: ReadonlyArray<string>;
}

function safeDeclarativeExportName(path: Path.Path, name: string): string {
  const rel = path.normalize(name.split("\\").join("/"));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw declarativeWriteError(`unsafe declarative export path: ${name}`);
  }
  return rel.split("\\").join("/");
}

function isCustomDeclarativePath(name: string): boolean {
  return name.split("/")[0] === "_custom";
}

const readManagedDeclarativeSqlFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
) {
  const names = yield* fs.readDirectory(declarativeDir);
  const files: Array<{ readonly name: string; readonly sql: string }> = [];
  for (const name of names) {
    if (name === "_custom") continue;
    const absolute = path.join(declarativeDir, name);
    const isSymlink = yield* fs.readLink(absolute).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isSymlink) continue;
    const info = yield* fs.stat(absolute);
    if (info.type === "Directory") {
      const nested = yield* walkSqlFiles(fs, absolute, name);
      for (const relative of nested) {
        files.push({
          name: relative,
          sql: yield* fs.readFileString(path.join(declarativeDir, relative)),
        });
      }
    } else if (info.type === "File" && name.endsWith(".sql")) {
      files.push({ name, sql: yield* fs.readFileString(absolute) });
    }
  }
  return files;
});

/**
 * Materializes pg-delta declarative export output under the declarative dir: only stale files
 * owned by the previous export are removed, unchanged files are untouched, unmanaged files are
 * preserved, and `_custom/` is never read as managed output or deleted. Returns which unmanaged
 * files were preserved (see {@link warnPreservedUnmanagedDeclarativeFiles}). Never touches
 * `[db.migrations] schema_paths`; `db pull --declarative` handles that separately.
 */
export const writeDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
  output: PgDeltaDeclarativeExportResult,
) {
  const proposed = yield* Effect.forEach(output.files, (file) =>
    Effect.try({
      try: () => {
        const name = safeDeclarativeExportName(path, file.name);
        if (isCustomDeclarativePath(name)) {
          throw declarativeWriteError(
            `refusing to write into reserved declarative schema path: ${file.name}`,
          );
        }
        return { name, sql: file.sql };
      },
      catch: (error) =>
        error instanceof DeclarativeWriteError ? error : declarativeWriteError(String(error)),
    }),
  );

  const exists = yield* fs
    .exists(declarativeDir)
    .pipe(
      Effect.mapError((error) =>
        declarativeWriteError(`failed to inspect declarative schema directory: ${error.message}`),
      ),
    );
  const existingFiles = exists
    ? yield* readManagedDeclarativeSqlFiles(fs, path, declarativeDir).pipe(
        Effect.mapError((error) =>
          declarativeWriteError(
            `failed to read managed declarative schema files: ${error.message}`,
          ),
        ),
      )
    : [];
  const previousManifest = exists
    ? yield* ReadPgDeltaExportManifest(fs, path, declarativeDir).pipe(
        Effect.mapError((error) => declarativeWriteError(error.message)),
      )
    : undefined;
  const classification = classifySqlFiles({
    proposed,
    existing: new Map(existingFiles.map((file) => [file.name, file.sql])),
    ...(previousManifest?.files !== undefined
      ? { previouslyOwned: new Set(previousManifest.files) }
      : {}),
  });
  // With no manifest there is no ownership record, so nothing can be classified as stale:
  // every pre-existing file the export doesn't itself replace survives, producing a silent
  // partial merge behind an "overwrite existing files" prompt. Report them so the handler
  // can say so out loud.
  const proposedNames = new Set(proposed.map((file) => file.name));
  const preservedUnmanagedFiles =
    previousManifest?.files === undefined
      ? existingFiles
          .map((file) => file.name)
          .filter((name) => !proposedNames.has(name))
          .sort()
      : [];

  yield* fs.makeDirectory(declarativeDir, { recursive: true });
  const changed = new Set([...classification.created, ...classification.updated]);
  for (const file of proposed) {
    if (!changed.has(file.name)) continue;
    const targetPath = path.join(declarativeDir, file.name);
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.writeFileString(targetPath, file.sql);
  }

  for (const name of classification.removed) {
    yield* fs
      .remove(path.join(declarativeDir, name))
      .pipe(
        Effect.mapError((error) =>
          declarativeWriteError(`failed to remove stale declarative schema file: ${error.message}`),
        ),
      );
  }

  const manifest: PgDeltaExportManifest & {
    readonly formatVersion: 1;
    readonly files: ReadonlyArray<string>;
  } = {
    formatVersion: 1,
    ...output.manifest,
    files: proposed.map((file) => file.name).sort(),
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(declarativeDir, EXPORT_MANIFEST_FILE);
  const manifestExists = yield* fs
    .exists(manifestPath)
    .pipe(
      Effect.mapError((error) =>
        declarativeWriteError(`failed to inspect export manifest: ${error.message}`),
      ),
    );
  const previousSerialized = manifestExists
    ? yield* fs
        .readFileString(manifestPath)
        .pipe(
          Effect.mapError((error) =>
            declarativeWriteError(`failed to read export manifest: ${error.message}`),
          ),
        )
    : undefined;
  if (previousSerialized !== serialized) {
    yield* fs.writeFileString(manifestPath, serialized);
  }
  return { preservedUnmanagedFiles } satisfies DeclarativeWriteResult;
});

/**
 * The written-to line, printed by all three declarative write paths (`generate`,
 * `pull --declarative`, `sync`'s bootstrap). Every caller passes the relative declarative
 * dir, never the resolved absolute path, so this pins the shared message text in one place.
 */
export const declarativeSchemaWrittenLine = (dir: string): string =>
  `Declarative schema written to ${bold(dir)}\n`;

/**
 * The manifest-less-merge warning text: without an export manifest, nothing can be classified
 * as stale, so a pre-existing declarative directory keeps every file the new export doesn't
 * itself replace — even though the "overwrite existing files" prompt implied a clean rewrite.
 * Names the survivors and gives the one instruction that produces a clean tree.
 */
const preservedUnmanagedDeclarativeFilesWarning = (
  dir: string,
  files: ReadonlyArray<string>,
): string =>
  `${yellow(
    `WARNING: ${files.length} existing declarative schema file(s) in ${dir} are not tracked by an export manifest and were preserved: ${files.join(
      ", ",
    )}`,
  )}\n${yellow(
    `These files still contribute to future declarative plans. To regenerate the directory cleanly, remove ${dir} and re-run supabase db schema declarative generate.`,
  )}\n`;

/**
 * Emits {@link preservedUnmanagedDeclarativeFilesWarning} when a write
 * preserved unmanaged files. Lives next to the writer (which has no `Output`) so
 * all three declarative write callers share one warning, and is a no-op otherwise.
 */
export const warnPreservedUnmanagedDeclarativeFiles = Effect.fnUntraced(function* (
  dir: string,
  written: DeclarativeWriteResult,
) {
  if (written.preservedUnmanagedFiles.length === 0) return;
  const output = yield* Output;
  yield* output.raw(
    preservedUnmanagedDeclarativeFilesWarning(dir, written.preservedUnmanagedFiles),
    "stderr",
  );
});

// `(?s)` (dotall) is equivalent to `[\s\S]`; the capture group is unused.
const SCHEMA_PATHS_PATTERN = /\nschema_paths = \[[\s\S]*?\]\n/g;

/**
 * A raw-text replace-or-append of `[db.migrations] schema_paths` in `supabase/config.toml`,
 * pointing it at `resolvedDeclarativeDir` with its leading `supabase/` trimmed. This is a
 * literal byte-edit, not a TOML re-serialize, so the rest of the file's comments and
 * formatting are preserved exactly.
 */
export const updateDeclarativeSchemaPathsConfig = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  resolvedDeclarativeDir: string,
) {
  const normalized = resolvedDeclarativeDir.split("\\").join("/");
  const relative = normalized.startsWith("supabase/")
    ? normalized.slice("supabase/".length)
    : normalized;
  const block = `\nschema_paths = [\n  "${relative}",\n]\n`;
  const configPath = path.join(workdir, "supabase", "config.toml");
  const existing = yield* fs.readFileString(configPath).pipe(
    Effect.catchTag("PlatformError", (error) =>
      // A missing config file is tolerated; other read errors abort.
      error.reason._tag === "NotFound"
        ? Effect.succeed("")
        : Effect.fail(
            new DeclarativeWriteError({
              message: `failed to read config: ${error.message}`,
            }),
          ),
    ),
  );
  // A replacer function, not a string, so a literal "$" in the path/value can't be
  // misread as a replacement pattern.
  const replaced = existing.replace(SCHEMA_PATHS_PATTERN, () => block);
  const next = replaced.includes(block) ? replaced : `${existing}\n[db.migrations]${block}`;
  yield* fs
    .writeFileString(configPath, next)
    .pipe(
      Effect.mapError(
        (error) =>
          new DeclarativeWriteError({ message: `failed to save config: ${error.message}` }),
      ),
    );
});
