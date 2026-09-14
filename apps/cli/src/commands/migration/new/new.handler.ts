import { Clock, Effect, FileSystem, Path, Stream } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import {
  formatMigrationTimestamp,
  getMigrationPath,
} from "../../../command-internal/migration-file.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { MigrationNewFlags } from "./new.command.ts";
import { MigrationNewWriteError } from "./new.errors.ts";

/**
 * `supabase migration new`:
 * write `supabase/migrations/<UTC timestamp>_<name>.sql` (mode 0644), seeding it
 * from piped stdin when present, then print the created path. No DB / API / prompt.
 */
export const migrationNew = Effect.fn("migration.new")(function* (flags: MigrationNewFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const stdin = yield* Stdin;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.gen(function* () {
    const timestamp = formatMigrationTimestamp(yield* Clock.currentTimeMillis);
    const migrationPath = getMigrationPath(
      path,
      cliSettings.workdir,
      timestamp,
      flags.migrationName,
    );

    // `path.join` collapses ".." segments, so a name like "../../../foo" would
    // resolve outside the migrations dir (CWE-22); reject it, since real names are
    // simple identifiers.
    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
    if (!migrationPath.startsWith(migrationsDir + path.sep)) {
      return yield* Effect.fail(
        new MigrationNewWriteError({
          message: `invalid migration name: "${flags.migrationName}" must not escape the ${path.join("supabase", "migrations")} directory`,
        }),
      );
    }

    yield* fs
      .makeDirectory(path.dirname(migrationPath), { recursive: true })
      .pipe(Effect.mapError((cause) => new MigrationNewWriteError({ message: cause.message })));

    // The printed path is workdir-relative, independent of the invoking cwd, while
    // the write itself uses the absolute `migrationPath`.
    const relativePath = path.join(
      "supabase",
      "migrations",
      `${timestamp}_${flags.migrationName}.sql`,
    );
    // This line prints to stdout, so the color gate must check stdout; see
    // `colors.ts`'s doc comment.
    const printCreated =
      output.format === "text"
        ? output.raw(`Created new migration at ${bold(relativePath, process.stdout)}\n`)
        : Effect.void;

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
            Effect.tapError(() => printCreated),
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

    if (output.format === "text") {
      yield* printCreated;
    } else {
      yield* output.success("Migration created", { path: migrationPath });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
