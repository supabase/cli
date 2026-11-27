import { Clock, Effect, FileSystem, Path, Stream } from "effect";

import { CommandUX, ResolvedProject } from "../../../command-internal/command-executor.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import {
  formatMigrationTimestamp,
  getMigrationPath,
} from "../../../command-internal/migration-file.ts";
import type { MigrationNewFlags } from "./new.command.ts";
import { MigrationNewWriteError } from "./new.errors.ts";

export const createdMessage = (relativePath: string) =>
  `Created new migration at ${bold(relativePath, process.stdout)}`;

/** Creates and verifies a local migration file, preserving partial SQL if copying stdin fails. */
export const migrationNew = Effect.fn("migration.new")(function* (flags: MigrationNewFlags) {
  const ux = yield* CommandUX;
  yield* ResolvedProject.use((project) => project.record(undefined));
  const cliSettings = yield* CommandSettings;
  const stdin = yield* Stdin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.annotateCurrentSpan({ "migration.stdin_piped": !stdin.isTTY });
  const timestamp = formatMigrationTimestamp(yield* Clock.currentTimeMillis);
  const migrationPath = getMigrationPath(path, cliSettings.workdir, timestamp, flags.migrationName);

  // `path.join` collapses ".." segments, so a name like "../../../foo" would
  // resolve outside the migrations dir (CWE-22); reject it, since real names are
  // simple identifiers.
  const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
  if (!migrationPath.startsWith(migrationsDir + path.sep)) {
    return yield* new MigrationNewWriteError({
      message: `invalid migration name: "${flags.migrationName}" must not escape the ${path.join("supabase", "migrations")} directory`,
    });
  }

  yield* fs
    .makeDirectory(path.dirname(migrationPath), { recursive: true })
    .pipe(Effect.mapError((cause) => new MigrationNewWriteError({ message: cause.message })));

  // Materializes the empty migration up front rather than relying on an otherwise-unused
  // open handle; the same create-then-append pattern used by db dump and db pull.
  yield* fs.writeFile(migrationPath, new Uint8Array(0), { mode: 0o644 }).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationNewWriteError({
          message: `failed to open migration file: ${cause.message}`,
        }),
    ),
  );

  const displayPath = path.relative(cliSettings.workdir, migrationPath);

  // Keep the piped-stdin copy scoped and chunked so large dumps use constant memory.
  if (!stdin.isTTY) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(migrationPath, { flag: "a" }).pipe(
          Effect.mapError(
            (cause) =>
              new MigrationNewWriteError({
                message: `failed to open migration file: ${cause.message}`,
              }),
          ),
        );
        yield* stdin.pipedBytesStream.pipe(
          Stream.runForEach((chunk) => handle.writeAll(chunk)),
          Effect.mapError(
            (cause) =>
              new MigrationNewWriteError({
                message: `failed to copy from stdin: ${cause.message}`,
              }),
          ),
          Effect.tapError(() => ux.writeToStdout(createdMessage(displayPath))),
        );
      }),
    );
  }

  // The command's contract is that the returned path exists when it exits zero, not
  // merely that the write call reported success.
  yield* fs.stat(migrationPath).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationNewWriteError({
          message: `failed to verify migration file: ${cause.message}`,
        }),
    ),
  );

  return {
    output: { path: migrationPath, message: "Migration created" as const },
    hookData: { displayPath },
  };
});
