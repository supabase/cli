import { Clock, Effect, FileSystem, Path, Stream } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../../../shared/legacy-migration-file.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyMigrationNewFlags } from "./new.command.ts";
import { LegacyMigrationNewWriteError } from "./new.errors.ts";

/**
 * `supabase migration new`:
 * write `supabase/migrations/<UTC timestamp>_<name>.sql` (mode 0644), seeding it
 * from piped stdin when present, then print the created path. No DB / API / prompt.
 */
export const legacyMigrationNew = Effect.fn("legacy.migration.new")(function* (
  flags: LegacyMigrationNewFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const stdin = yield* Stdin;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.gen(function* () {
    const timestamp = legacyFormatMigrationTimestamp(yield* Clock.currentTimeMillis);
    const migrationPath = legacyGetMigrationPath(
      path,
      cliConfig.workdir,
      timestamp,
      flags.migrationName,
    );

    // The name is a positional CLI arg; `path.join` collapses `..` segments, so a
    // name like `../../../foo` resolves OUTSIDE the migrations directory and lets
    // `migration new` write an arbitrary file (CWE-22) — reachable when the name
    // comes from an agent/CI template rather than a human. Real names are simple
    // identifiers, so containing the write to `supabase/migrations` is
    // parity-neutral for legitimate input while closing the arbitrary-write
    // vector — the same TS-only hardening `migration fetch` applies to remote rows.
    const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");
    if (!migrationPath.startsWith(migrationsDir + path.sep)) {
      return yield* Effect.fail(
        new LegacyMigrationNewWriteError({
          message: `invalid migration name: "${flags.migrationName}" must not escape the ${path.join("supabase", "migrations")} directory`,
        }),
      );
    }

    yield* fs
      .makeDirectory(path.dirname(migrationPath), { recursive: true })
      .pipe(
        Effect.mapError((cause) => new LegacyMigrationNewWriteError({ message: cause.message })),
      );

    // The RELATIVE path prints: `supabase/migrations`
    // is workdir-independent regardless of the invoking cwd. Reproduce that exactly
    // while still writing to the absolute `migrationPath`.
    const relativePath = path.join(
      "supabase",
      "migrations",
      `${timestamp}_${flags.migrationName}.sql`,
    );
    // stdout-bound line, so the colour TTY gate must check stdout (see
    // `legacy-colors.ts`'s doc comment — the CLI-1546 bug class).
    const printCreated =
      output.format === "text"
        ? output.raw(`Created new migration at ${legacyBold(relativePath, process.stdout)}\n`)
        : Effect.void;

    // Materialize the empty migration before reporting success instead of relying on an
    // otherwise-unused open handle. This is the same create-then-append pattern used by
    // db dump and db pull.
    yield* fs.writeFile(migrationPath, new Uint8Array(0), { mode: 0o644 }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyMigrationNewWriteError({
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
                new LegacyMigrationNewWriteError({
                  message: `failed to open migration file: ${cause.message}`,
                }),
            ),
          );
          yield* stdin.pipedBytesStream.pipe(
            Stream.runForEach((chunk) => handle.writeAll(chunk)),
            Effect.mapError(
              (cause) =>
                new LegacyMigrationNewWriteError({
                  message: `failed to copy from stdin: ${cause.message}`,
                }),
            ),
            Effect.tapError(() => printCreated),
          );
        }),
      );
    }

    // Do not emit success solely because a runtime write reported success. This command's
    // contract is that the returned path exists when it exits zero.
    yield* fs.stat(migrationPath).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyMigrationNewWriteError({
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
