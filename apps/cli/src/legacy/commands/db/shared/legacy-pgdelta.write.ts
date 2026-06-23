import { Effect, type FileSystem, type Path } from "effect";

import { LegacyDeclarativeWriteError } from "./legacy-pgdelta.errors.ts";
import type { LegacyDeclarativeOutput } from "./legacy-pgdelta.ts";

/**
 * Materializes pg-delta declarative export output under the declarative dir.
 * Mirrors Go's `WriteDeclarativeSchemas` (`declarative.go:239`): wipe the dir,
 * recreate it, and write each file at its (path-safe) relative path.
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
  output: LegacyDeclarativeOutput,
) {
  yield* fs.remove(declarativeDir, { recursive: true }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      // Go wraps any failure; a missing dir is fine (we recreate it next).
      error.reason._tag === "NotFound"
        ? Effect.void
        : Effect.fail(
            new LegacyDeclarativeWriteError({
              message: `failed to clean declarative schema directory: ${error.message}`,
            }),
          ),
    ),
  );
  yield* fs.makeDirectory(declarativeDir, { recursive: true });

  for (const file of output.files) {
    const rel = path.normalize(file.path);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return yield* Effect.fail(
        new LegacyDeclarativeWriteError({
          message: `unsafe declarative export path: ${file.path}`,
        }),
      );
    }
    const targetPath = path.join(declarativeDir, rel);
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.writeFileString(targetPath, file.sql);
  }
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
 * `GetDeclarativeDir()`, e.g. `supabase/database`); the leading `supabase/` is
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
