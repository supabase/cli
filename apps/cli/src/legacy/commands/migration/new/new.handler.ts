import { Clock, Effect, FileSystem, Option, Path } from "effect";

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
 * Native port of `supabase migration new` (`internal/migration/new/new.go`):
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

    // Go's `CopyStdinIfExists` copies raw stdin bytes verbatim when stdin is NOT a
    // char device (piped/redirected). A TTY writes nothing → empty file. An empty
    // pipe (`readPipedBytes` → none) also yields an empty file, matching Go.
    const piped = stdin.isTTY ? Option.none<Uint8Array>() : yield* stdin.readPipedBytes;
    const content = Option.getOrElse(piped, () => new Uint8Array(0));

    yield* fs
      .makeDirectory(path.dirname(migrationPath), { recursive: true })
      .pipe(
        Effect.mapError((cause) => new LegacyMigrationNewWriteError({ message: cause.message })),
      );
    yield* fs.writeFile(migrationPath, content, { mode: 0o644 }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyMigrationNewWriteError({
            message: `failed to open migration file: ${cause.message}`,
          }),
      ),
    );

    // Go prints the RELATIVE path: `utils.MigrationsDir` is `supabase/migrations`
    // and Go chdir's into `--workdir` in its persistent pre-run, so the printed
    // path is workdir-independent. Reproduce that exactly while still writing to
    // the absolute `migrationPath`.
    const relativePath = path.join(
      "supabase",
      "migrations",
      `${timestamp}_${flags.migrationName}.sql`,
    );
    if (output.format === "text") {
      yield* output.raw(`Created new migration at ${legacyBold(relativePath)}\n`);
    } else {
      yield* output.success("Migration created", { path: migrationPath });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
