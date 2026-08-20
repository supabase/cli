import { Clock, Effect, FileSystem, Layer, Path } from "effect";
import { Output } from "../../shared/output/output.service.ts";
import {
  SchemaMigrationNameError,
  SchemaWorkspaceIoError,
} from "../../shared/schema/schema-errors.ts";
import { MIGRATION_NO_TRANSACTION_DIRECTIVE } from "../../shared/schema/schema-paths.ts";
import { SchemaWorkspace } from "../../shared/schema/schema-workspace.service.ts";
import type { MigrationFile } from "../../shared/migrations/migration-file.ts";
import { MigrationRepository } from "../../shared/migrations/migration-repository.service.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
  legacyParseMigrationContent,
} from "../shared/legacy-migration-file.ts";
import {
  legacyListLocalMigrationPaths,
  MIGRATE_FILE_PATTERN,
} from "../shared/legacy-migration-history.ts";

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_VERSION_COLLISION_ATTEMPTS = 100;

const ioError = (detail: string) =>
  new SchemaWorkspaceIoError({
    detail,
    suggestion: "Check permissions on supabase/migrations and retry.",
  });

export const legacyMigrationRepositoryLayer = Layer.effect(
  MigrationRepository,
  Effect.gen(function* () {
    const workspace = yield* SchemaWorkspace;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = yield* Output;
    const workdir = path.dirname(path.dirname(workspace.migrationsDir));

    const readLocal = Effect.gen(function* () {
      const paths = yield* legacyListLocalMigrationPaths(fs, path, workspace.migrationsDir).pipe(
        Effect.provideService(Output, output),
        Effect.mapError((error) => ioError(error.message)),
      );
      const files: Array<MigrationFile> = [];
      for (const absolutePath of paths) {
        const fileName = path.basename(absolutePath);
        const parsed = MIGRATE_FILE_PATTERN.exec(fileName);
        const version = parsed?.[1];
        const name = parsed?.[2];
        if (version === undefined || name === undefined) continue;
        const content = yield* fs
          .readFileString(absolutePath)
          .pipe(
            Effect.mapError((error) => ioError(`Failed to read ${fileName}: ${error.message}`)),
          );
        files.push({
          version,
          name,
          fileName,
          absolutePath,
          content,
          transactional: legacyParseMigrationContent(content).transactionMode === "transactional",
        });
      }
      return files.sort((left, right) => left.version.localeCompare(right.version));
    });

    const assertName = (name: string) => {
      if (!NAME_PATTERN.test(name)) {
        return Effect.fail(
          new SchemaMigrationNameError({
            detail: `Invalid migration name "${name}".`,
            suggestion: "Use only letters, numbers, underscores, and hyphens.",
          }),
        );
      }
      return Effect.void;
    };

    const assertInsideMigrations = (absolutePath: string, name: string) => {
      if (!absolutePath.startsWith(workspace.migrationsDir + path.sep)) {
        return Effect.fail(
          new SchemaMigrationNameError({
            detail: `Migration name "${name}" escapes supabase/migrations.`,
            suggestion: "Use a simple identifier without path separators.",
          }),
        );
      }
      return Effect.void;
    };

    return MigrationRepository.of({
      listLocal: readLocal,
      createEmpty: (name, content = "") =>
        Effect.gen(function* () {
          yield* assertName(name);
          const version = legacyFormatMigrationTimestamp(yield* Clock.currentTimeMillis);
          const absolutePath = legacyGetMigrationPath(path, workdir, version, name);
          const fileName = path.basename(absolutePath);
          yield* assertInsideMigrations(absolutePath, name);
          yield* fs
            .makeDirectory(workspace.migrationsDir, { recursive: true })
            .pipe(Effect.mapError((error) => ioError(error.message)));
          yield* fs
            .writeFileString(absolutePath, content)
            .pipe(Effect.mapError((error) => ioError(error.message)));
          return {
            version,
            name,
            fileName,
            absolutePath,
            content,
            transactional: true,
          } satisfies MigrationFile;
        }),
      writeGenerated: (input) =>
        Effect.gen(function* () {
          yield* assertName(input.name);
          yield* fs
            .makeDirectory(workspace.migrationsDir, { recursive: true })
            .pipe(Effect.mapError((error) => ioError(error.message)));
          const existing = yield* readLocal;
          const usedVersions = new Set(existing.map((file) => file.version));
          const unitName = (suffix: string | null) =>
            suffix !== null && suffix !== "" ? `${input.name}_${suffix}` : input.name;

          const build = (baseMillis: number) =>
            input.files.map((file, index) => {
              const version = legacyFormatMigrationTimestamp(baseMillis + index * 1000);
              const name = unitName(file.suffix);
              const absolutePath = legacyGetMigrationPath(path, workdir, version, name);
              return {
                version,
                name,
                fileName: path.basename(absolutePath),
                absolutePath,
                body: file.transactional
                  ? file.sql
                  : `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\n${file.sql}`,
                transactional: file.transactional,
              };
            });

          let planned = build(input.baseMillis);
          for (let attempt = 0; attempt < MAX_VERSION_COLLISION_ATTEMPTS; attempt++) {
            if (!planned.some((file) => usedVersions.has(file.version))) break;
            planned = build(input.baseMillis + (attempt + 1) * 1000);
          }
          if (planned.some((file) => usedVersions.has(file.version))) {
            return yield* new SchemaMigrationNameError({
              detail: "Could not allocate unique migration versions.",
              suggestion: "Retry schema generate in a moment.",
            });
          }

          const written: Array<MigrationFile> = [];
          for (const file of planned) {
            yield* assertInsideMigrations(file.absolutePath, file.name);
            yield* fs.writeFileString(file.absolutePath, file.body).pipe(
              Effect.mapError((error) =>
                ioError(`Failed to write ${file.fileName}: ${error.message}`),
              ),
              Effect.tapError(() =>
                Effect.forEach(written, (created) =>
                  fs.remove(created.absolutePath).pipe(Effect.ignore),
                ),
              ),
            );
            written.push({
              version: file.version,
              name: file.name,
              fileName: file.fileName,
              absolutePath: file.absolutePath,
              content: file.body,
              transactional: file.transactional,
            });
          }
          return written;
        }),
      remove: (files) =>
        Effect.gen(function* () {
          for (const file of files) {
            yield* fs
              .remove(file.absolutePath)
              .pipe(
                Effect.catchTag("PlatformError", (error) =>
                  error.reason._tag === "NotFound"
                    ? Effect.void
                    : Effect.fail(ioError(`Failed to remove ${file.fileName}: ${error.message}`)),
                ),
              );
          }
        }),
    });
  }),
);
