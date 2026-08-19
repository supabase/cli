import { Effect, FileSystem, Layer, Path } from "effect";
import {
  classifySqlFiles,
  EXPORT_MANIFEST_FILE,
  readExportManifest,
  type SqlFileClassification,
} from "@supabase/pg-delta/frontends";
import {
  SCHEMA_CHECKPOINT_FILE_NAME,
  SCHEMA_CUSTOM_DIRECTORY_NAME,
  SCHEMA_DIRECTORY_NAME,
  SCHEMA_DRAFT_JOURNAL_FILE_NAME,
  SCHEMA_LOCK_FILE_NAME,
  MIGRATIONS_DIRECTORY_NAME,
} from "./schema-paths.ts";
import { SCHEMA_PULL_NO_MERGE_HELP } from "./schema-ecosystem.ts";
import {
  SchemaDeclarationsExistError,
  SchemaUnmanagedFilesError,
  SchemaWorkspaceIoError,
} from "./schema-errors.ts";
import type { SchemaSqlFile } from "./schema-types.ts";
import {
  SchemaWorkspace,
  type SchemaInstallInput,
  type SchemaInstallResult,
} from "./schema-workspace.service.ts";

const ioError = (detail: string, suggestion = "Check filesystem permissions and retry.") =>
  new SchemaWorkspaceIoError({ detail, suggestion });

function isCustomPath(relative: string): boolean {
  return relative.split("/")[0] === SCHEMA_CUSTOM_DIRECTORY_NAME;
}

function posixRel(path: Path.Path, value: string): string {
  return path.normalize(value.split("\\").join("/")).split("\\").join("/");
}

function parseSafeRelative(
  path: Path.Path,
  name: string,
): Effect.Effect<string, SchemaWorkspaceIoError> {
  const rel = posixRel(path, name);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return Effect.fail(ioError(`Unsafe declarative export path: ${name}`));
  }
  if (isCustomPath(rel)) {
    return Effect.fail(
      ioError(
        `Refusing to write into reserved path: ${name}`,
        "Keep hand-authored SQL in _custom/.",
      ),
    );
  }
  return Effect.succeed(rel);
}

function walkSqlFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  prefix = "",
): Effect.Effect<Array<SchemaSqlFile>, SchemaWorkspaceIoError> {
  return Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.mapError((error) => ioError(`Failed to read ${directory}: ${error.message}`)));
    const files: Array<SchemaSqlFile> = [];
    for (const name of names) {
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (prefix === "" && name === SCHEMA_CUSTOM_DIRECTORY_NAME) continue;
      const absolute = path.join(directory, name);
      const isSymlink = yield* fs.readLink(absolute).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isSymlink) continue;
      const info = yield* fs
        .stat(absolute)
        .pipe(Effect.mapError((error) => ioError(`Failed to stat ${absolute}: ${error.message}`)));
      if (info.type === "Directory") {
        files.push(...(yield* walkSqlFiles(fs, path, absolute, relative)));
      } else if (info.type === "File" && name.endsWith(".sql")) {
        files.push({
          name: relative.split("\\").join("/"),
          sql: yield* fs
            .readFileString(absolute)
            .pipe(
              Effect.mapError((error) => ioError(`Failed to read ${absolute}: ${error.message}`)),
            ),
        });
      }
    }
    return files;
  });
}

export type SchemaWorkspacePaths = {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly projectHomeDir: string;
};

export const schemaWorkspaceLayer = (paths: SchemaWorkspacePaths) =>
  Layer.effect(
    SchemaWorkspace,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const schemasDir = path.join(paths.supabaseDir, SCHEMA_DIRECTORY_NAME);
      const migrationsDir = path.join(paths.supabaseDir, MIGRATIONS_DIRECTORY_NAME);
      const customDir = path.join(schemasDir, SCHEMA_CUSTOM_DIRECTORY_NAME);
      const checkpointPath = path.join(schemasDir, SCHEMA_CHECKPOINT_FILE_NAME);
      const journalPath = path.join(paths.projectHomeDir, SCHEMA_DRAFT_JOURNAL_FILE_NAME);
      const lockPath = path.join(paths.projectHomeDir, SCHEMA_LOCK_FILE_NAME);

      const readExistingSql = (directory = schemasDir) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false));
          if (!exists) return new Map<string, string>();
          const files = yield* walkSqlFiles(fs, path, directory);
          return new Map<string, string>(files.map((file) => [file.name, file.sql]));
        });

      const classifyProposed = (proposed: ReadonlyArray<SchemaSqlFile>, directory = schemasDir) =>
        Effect.gen(function* () {
          const existing = yield* readExistingSql(directory);
          const exists = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false));
          const previous = exists ? readExportManifest(directory) : undefined;
          return classifySqlFiles({
            proposed,
            existing,
            ...(previous?.files !== undefined ? { previouslyOwned: new Set(previous.files) } : {}),
          });
        });

      const writeTree = Effect.fnUntraced(function* (
        directory: string,
        files: ReadonlyArray<SchemaSqlFile>,
        classification: SqlFileClassification,
        pruneUnmanaged: boolean,
        manifest: Record<string, unknown>,
      ) {
        yield* fs
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.mapError((error) => ioError(`Failed to create ${directory}: ${error.message}`)),
          );

        const changed = new Set([...classification.created, ...classification.updated]);
        for (const file of files) {
          const rel = yield* parseSafeRelative(path, file.name);
          if (!changed.has(rel) && existingHas(classification, rel)) continue;
          const target = path.join(directory, rel);
          yield* fs
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(
              Effect.mapError((error) =>
                ioError(`Failed to create ${path.dirname(target)}: ${error.message}`),
              ),
            );
          yield* fs
            .writeFileString(target, file.sql)
            .pipe(
              Effect.mapError((error) => ioError(`Failed to write ${target}: ${error.message}`)),
            );
        }

        for (const name of classification.removed) {
          yield* fs
            .remove(path.join(directory, name))
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "NotFound"
                  ? Effect.void
                  : Effect.fail(ioError(`Failed to remove ${name}: ${error.message}`)),
              ),
            );
        }

        if (pruneUnmanaged) {
          for (const name of classification.unmanaged) {
            yield* fs
              .remove(path.join(directory, name))
              .pipe(
                Effect.mapError((error) => ioError(`Failed to prune ${name}: ${error.message}`)),
              );
          }
        }

        const owned: Array<string> = [];
        for (const file of files) {
          owned.push(yield* parseSafeRelative(path, file.name));
        }
        owned.sort();
        const serialized = `${JSON.stringify({ formatVersion: 1, ...manifest, files: owned }, null, 2)}\n`;
        yield* fs
          .writeFileString(path.join(directory, EXPORT_MANIFEST_FILE), serialized)
          .pipe(
            Effect.mapError((error) =>
              ioError(`Failed to write export manifest: ${error.message}`),
            ),
          );
      });

      function existingHas(classification: SqlFileClassification, rel: string): boolean {
        return (
          classification.unchanged.includes(rel) ||
          classification.updated.includes(rel) ||
          classification.created.includes(rel)
        );
      }

      const installExport = (input: SchemaInstallInput) =>
        Effect.gen(function* () {
          const directory = input.mode === "output" ? (input.outputDir ?? schemasDir) : schemasDir;
          const directoryDisplay =
            input.mode === "output"
              ? path.relative(paths.projectRoot, directory)
              : path.join("supabase", SCHEMA_DIRECTORY_NAME);

          const proposed: Array<SchemaSqlFile> = [];
          for (const file of input.files) {
            proposed.push({
              name: yield* parseSafeRelative(path, file.name),
              sql: file.sql,
            });
          }

          const destExists = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false));
          const existing = destExists
            ? yield* readExistingSql(directory)
            : new Map<string, string>();
          const hasSql = existing.size > 0;

          if (hasSql && input.mode === "init") {
            return yield* new SchemaDeclarationsExistError({
              detail: "Declarative schema already exists.",
              suggestion: SCHEMA_PULL_NO_MERGE_HELP,
            });
          }

          if (hasSql && input.mode === "output") {
            return yield* new SchemaDeclarationsExistError({
              detail: `Output directory already contains SQL: ${directoryDisplay}`,
              suggestion:
                "Choose an empty --output directory or pass --force to replace the primary tree.",
            });
          }

          const classification = yield* classifyProposed(proposed, directory);
          if (classification.unmanaged.length > 0 && !input.pruneUnmanaged) {
            return yield* new SchemaUnmanagedFilesError({
              detail: `Unmanaged declarative files would be left in place: ${classification.unmanaged.join(", ")}`,
              suggestion:
                "Delete them yourself or pass --prune-unmanaged. _custom/ is never modified.",
              paths: classification.unmanaged,
            });
          }

          yield* writeTree(
            directory,
            proposed,
            classification,
            input.pruneUnmanaged,
            input.manifest,
          );

          return {
            directory,
            directoryDisplay,
            classification,
            replaced: input.mode === "force",
            manifestPath: path.join(directory, EXPORT_MANIFEST_FILE),
          } satisfies SchemaInstallResult;
        });

      return SchemaWorkspace.of({
        schemasDir,
        schemasDirDisplay: path.join("supabase", SCHEMA_DIRECTORY_NAME),
        migrationsDir,
        migrationsDirDisplay: path.join("supabase", MIGRATIONS_DIRECTORY_NAME),
        customDir,
        checkpointPath,
        journalPath,
        lockPath,
        readDeclarationFiles: Effect.gen(function* () {
          const exists = yield* fs.exists(schemasDir).pipe(Effect.orElseSucceed(() => false));
          if (!exists) return [];
          return yield* walkSqlFiles(fs, path, schemasDir);
        }),
        readExistingSql,
        classifyProposed,
        installExport,
      });
    }),
  );
