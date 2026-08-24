import { Effect, Schema, type FileSystem, type Path } from "effect";
import { classifySqlFiles } from "@supabase/pg-delta/frontends";

import { Output } from "../../../../shared/output/output.service.ts";
import { legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyWalkSqlFiles } from "../../../shared/legacy-glob.ts";
import type { LegacyDeclarativeOutput } from "../../../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeWriteError } from "./legacy-pgdelta.errors.ts";
import { LegacyReadPgDeltaExportManifest } from "./legacy-pgdelta-files.ts";
import type {
  LegacyPgDeltaDeclarativeExportResult,
  LegacyPgDeltaExportManifest,
} from "./legacy-pgdelta-engine.service.ts";

const EXPORT_MANIFEST_FILE = ".pgdelta-export.json";

type LegacyDeclarativeWriteOutput = LegacyDeclarativeOutput | LegacyPgDeltaDeclarativeExportResult;
type LegacyPgDeltaNextDeclarativeOutput = LegacyPgDeltaDeclarativeExportResult & {
  readonly manifest: LegacyPgDeltaExportManifest;
};

function legacyDeclarativeWriteError(message: string): LegacyDeclarativeWriteError {
  return new LegacyDeclarativeWriteError({ message });
}

/**
 * What a declarative write left behind, so the calling handler (which owns
 * {@link Output}) can tell the user about it.
 */
export interface LegacyDeclarativeWriteResult {
  /**
   * Pre-existing `.sql` files the next writer preserved because no export
   * manifest claimed ownership of them — see
   * {@link legacyPreservedUnmanagedDeclarativeFilesWarning}. Always empty for the
   * legacy writer, which wipes the directory outright.
   */
  readonly preservedUnmanagedFiles: ReadonlyArray<string>;
}

const NO_PRESERVED_FILES: LegacyDeclarativeWriteResult = { preservedUnmanagedFiles: [] };

function isNextDeclarativeOutput(
  output: LegacyDeclarativeWriteOutput,
): output is LegacyPgDeltaNextDeclarativeOutput {
  return "manifest" in output && output.manifest !== undefined;
}

function safeDeclarativeExportName(path: Path.Path, name: string): string {
  const rel = path.normalize(name.split("\\").join("/"));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw legacyDeclarativeWriteError(`unsafe declarative export path: ${name}`);
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
      const nested = yield* legacyWalkSqlFiles(fs, absolute, name);
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

const writeLegacyDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
  output: LegacyDeclarativeWriteOutput,
) {
  yield* fs
    .remove(declarativeDir, { recursive: true })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              legacyDeclarativeWriteError(
                `failed to clean declarative schema directory: ${error.message}`,
              ),
            ),
      ),
    );
  yield* fs.makeDirectory(declarativeDir, { recursive: true });

  for (const file of output.files) {
    const name = "name" in file ? file.name : file.path;
    const rel = yield* Effect.try({
      try: () => safeDeclarativeExportName(path, name),
      catch: (error) =>
        error instanceof LegacyDeclarativeWriteError
          ? error
          : legacyDeclarativeWriteError(String(error)),
    });
    const targetPath = path.join(declarativeDir, rel);
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.writeFileString(targetPath, file.sql);
  }
  return NO_PRESERVED_FILES;
});

const writeNextDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
  output: LegacyPgDeltaNextDeclarativeOutput,
) {
  const proposed = yield* Effect.forEach(output.files, (file) =>
    Effect.try({
      try: () => {
        const name = safeDeclarativeExportName(path, file.name);
        if (isCustomDeclarativePath(name)) {
          throw legacyDeclarativeWriteError(
            `refusing to write into reserved declarative schema path: ${file.name}`,
          );
        }
        return { name, sql: file.sql };
      },
      catch: (error) =>
        error instanceof LegacyDeclarativeWriteError
          ? error
          : legacyDeclarativeWriteError(String(error)),
    }),
  );

  const exists = yield* fs
    .exists(declarativeDir)
    .pipe(
      Effect.mapError((error) =>
        legacyDeclarativeWriteError(
          `failed to inspect declarative schema directory: ${error.message}`,
        ),
      ),
    );
  const existingFiles = exists
    ? yield* readManagedDeclarativeSqlFiles(fs, path, declarativeDir).pipe(
        Effect.mapError((error) =>
          legacyDeclarativeWriteError(
            `failed to read managed declarative schema files: ${error.message}`,
          ),
        ),
      )
    : [];
  const previousManifest = exists
    ? yield* LegacyReadPgDeltaExportManifest(fs, path, declarativeDir).pipe(
        Effect.mapError((error) => legacyDeclarativeWriteError(error.message)),
      )
    : undefined;
  const classification = classifySqlFiles({
    proposed,
    existing: new Map(existingFiles.map((file) => [file.name, file.sql])),
    ...(previousManifest?.files !== undefined
      ? { previouslyOwned: new Set(previousManifest.files) }
      : {}),
  });
  // With no manifest there is no ownership record, so nothing can be classified as
  // stale: every pre-existing file the export does not itself replace survives. The
  // typical producer of such a directory is the OLD legacy full-wipe exporter, whose
  // files still feed future plans (`LegacyLoadPgDeltaSqlFiles` walks the whole tree),
  // so the result is a silent partial merge behind an "overwrite existing files"
  // prompt. Report them and let the handler say so out loud.
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
          legacyDeclarativeWriteError(
            `failed to remove stale declarative schema file: ${error.message}`,
          ),
        ),
      );
  }

  const manifest: LegacyPgDeltaExportManifest & {
    readonly formatVersion: 1;
    readonly files: ReadonlyArray<string>;
  } = {
    formatVersion: 1,
    ...output.manifest,
    files: proposed.map((file) => file.name).sort(),
  };
  const serialized = `${yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Unknown, { space: 2 }),
  )(manifest)}\n`;
  const manifestPath = path.join(declarativeDir, EXPORT_MANIFEST_FILE);
  const manifestExists = yield* fs
    .exists(manifestPath)
    .pipe(
      Effect.mapError((error) =>
        legacyDeclarativeWriteError(`failed to inspect export manifest: ${error.message}`),
      ),
    );
  const previousSerialized = manifestExists
    ? yield* fs
        .readFileString(manifestPath)
        .pipe(
          Effect.mapError((error) =>
            legacyDeclarativeWriteError(`failed to read export manifest: ${error.message}`),
          ),
        )
    : undefined;
  if (previousSerialized !== serialized) {
    yield* fs.writeFileString(manifestPath, serialized);
  }
  return { preservedUnmanagedFiles } satisfies LegacyDeclarativeWriteResult;
});

/**
 * Go's `declarative.Generate` / `pull.go`'s written-to line, printed by all three
 * declarative write paths (`generate`, `pull --declarative`, `sync`'s bootstrap).
 * Every caller passes the relative `GetDeclarativeDir()` value, never the resolved
 * absolute dir (`generate` and `sync` route through this helper; `pull` still
 * inlines the same template) — this pins the shared message text in one place.
 */
export const legacyDeclarativeSchemaWrittenLine = (dir: string): string =>
  `Declarative schema written to ${legacyBold(dir)}\n`;

/**
 * The manifest-less-merge warning text. The next writer only prunes files an
 * existing `.pgdelta-export.json` claimed, so a directory produced by the old
 * legacy full-wipe exporter (no manifest) keeps every file the new export does not
 * itself replace — even though the prompt the user just answered said existing
 * files may be deleted. Name the survivors and give the one instruction that
 * actually produces a clean tree.
 */
export const legacyPreservedUnmanagedDeclarativeFilesWarning = (
  dir: string,
  files: ReadonlyArray<string>,
): string =>
  `${legacyYellow(
    `WARNING: ${files.length} existing declarative schema file(s) in ${dir} are not tracked by an export manifest and were preserved: ${files.join(
      ", ",
    )}`,
  )}\n${legacyYellow(
    `These files still contribute to future declarative plans. To regenerate the directory cleanly, remove ${dir} and re-run supabase db schema declarative generate.`,
  )}\n`;

/**
 * Emits {@link legacyPreservedUnmanagedDeclarativeFilesWarning} when a write
 * preserved unmanaged files. Lives next to the writer (which has no `Output`) so
 * all three declarative write callers share one warning, and is a no-op otherwise.
 */
export const legacyWarnPreservedUnmanagedDeclarativeFiles = Effect.fnUntraced(function* (
  dir: string,
  written: LegacyDeclarativeWriteResult,
) {
  if (written.preservedUnmanagedFiles.length === 0) return;
  const output = yield* Output;
  yield* output.raw(
    legacyPreservedUnmanagedDeclarativeFilesWarning(dir, written.preservedUnmanagedFiles),
    "stderr",
  );
});

/**
 * Materializes pg-delta declarative export output under the declarative dir.
 * Legacy-engine output keeps Go's wipe-and-rewrite behavior. Next-engine output
 * uses pg-delta's manifest ownership and file classification: only stale files
 * owned by the previous export are removed, unchanged files are not rewritten,
 * unmanaged files are preserved, and the reserved root `_custom/` tree is never
 * read as managed output or deleted. Returns which unmanaged files that preservation
 * kept, so the caller can warn (see
 * {@link legacyWarnPreservedUnmanagedDeclarativeFiles}).
 *
 * Go also updates `[db.migrations] schema_paths` afterwards, but only when
 * pg-delta is *disabled* in config (`if utils.IsPgDeltaEnabled() { return nil }`).
 * `db schema declarative generate/sync` force-enable pg-delta, so that branch is
 * unreachable for them; `db pull --declarative` does NOT force-enable it, so the
 * pull caller invokes `legacyUpdateDeclarativeSchemaPathsConfig` (below) when
 * config pg-delta is disabled. Keeping the config edit at the caller leaves this
 * writer a pure file-materializer shared unchanged by generate/sync.
 */
export const legacyWriteDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
  output: LegacyDeclarativeWriteOutput,
) {
  return yield* isNextDeclarativeOutput(output)
    ? writeNextDeclarativeSchemas(fs, path, declarativeDir, output)
    : writeLegacyDeclarativeSchemas(fs, path, declarativeDir, output);
});

// Go's `schemaPathsPattern` (`internal/db/declarative/declarative.go:59`):
// `(?s)\nschema_paths = \[(.*?)\]\n`. The `(?s)` (dotall) maps to `[\s\S]`, and
// the capture group is unused (Go uses `ReplaceAllLiteral`).
const LEGACY_SCHEMA_PATHS_PATTERN = /\nschema_paths = \[[\s\S]*?\]\n/g;

/**
 * Ports Go's `updateDeclarativeSchemaPathsConfig` (`declarative.go:276-304`): a
 * raw-text replace-or-append of `[db.migrations] schema_paths` in
 * `supabase/config.toml`, pointing it at the `supabase/`-relative declarative dir.
 * This is a literal byte-edit (NOT a TOML re-serialize), so it preserves comments
 * and formatting exactly like Go — reproduce the regex and the literal block
 * rather than "doing the right TOML thing".
 *
 * `resolvedDeclarativeDir` is the resolved declarative dir (Go's
 * `GetDeclarativeDir()`, e.g. `supabase/schemas`); the leading `supabase/` is
 * trimmed for the written value (Go's `strings.TrimPrefix`).
 */
export const legacyUpdateDeclarativeSchemaPathsConfig = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  resolvedDeclarativeDir: string,
) {
  const normalized = resolvedDeclarativeDir.split("\\").join("/");
  const relative = normalized.startsWith("supabase/")
    ? normalized.slice("supabase/".length)
    : normalized;
  // Go's literal replacement block (`declarative.go:278-284`): leading newline,
  // two-space indent, trailing comma inside the array, trailing newline.
  const block = `\nschema_paths = [\n  "${relative}",\n]\n`;
  const configPath = path.join(workdir, "supabase", "config.toml");
  const existing = yield* fs.readFileString(configPath).pipe(
    Effect.catchTag("PlatformError", (error) =>
      // Go tolerates a missing config (`os.ErrNotExist`); other read errors abort.
      error.reason._tag === "NotFound"
        ? Effect.succeed("")
        : Effect.fail(
            new LegacyDeclarativeWriteError({
              message: `failed to read config: ${error.message}`,
            }),
          ),
    ),
  );
  // Use a replacer function so `$` in the path/value is never interpreted as a
  // replacement pattern (Go's `ReplaceAllLiteral` semantics).
  const replaced = existing.replace(LEGACY_SCHEMA_PATHS_PATTERN, () => block);
  const next = replaced.includes(block) ? replaced : `${existing}\n[db.migrations]${block}`;
  yield* fs
    .writeFileString(configPath, next)
    .pipe(
      Effect.mapError(
        (error) =>
          new LegacyDeclarativeWriteError({ message: `failed to save config: ${error.message}` }),
      ),
    );
});
