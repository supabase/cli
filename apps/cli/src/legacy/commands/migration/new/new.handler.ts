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

    yield* fs
      .makeDirectory(path.dirname(migrationPath), { recursive: true })
      .pipe(
        Effect.mapError((cause) => new LegacyMigrationNewWriteError({ message: cause.message })),
      );

    // Go's `CopyStdinIfExists` opens the migration file first, then streams stdin into it
    // with `io.Copy` (`internal/migration/new/new.go:19,28,41`) — a fixed-size buffer, so a
    // large `pg_dump | supabase migration new` runs in constant memory. Mirror that: create
    // the file (mode 0644, like Go's O_CREATE|O_TRUNC), then stream piped stdin into the open
    // handle rather than buffering the whole pipe. A TTY (char device) writes nothing → empty
    // file; an empty pipe streams nothing → empty file, both matching Go.
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Go fails with "failed to open migration file" if the open fails (`new.go:21`)...
        const handle = yield* fs.open(migrationPath, { flag: "w", mode: 0o644 }).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyMigrationNewWriteError({
                message: `failed to open migration file: ${cause.message}`,
              }),
          ),
        );
        // ...and with "failed to copy from stdin" if the copy fails (`new.go:42`). A piped
        // stdin read error must abort here, not silently leave a truncated/empty file.
        if (!stdin.isTTY) {
          yield* stdin.pipedBytesStream.pipe(
            Stream.runForEach((chunk) => handle.writeAll(chunk)),
            Effect.mapError(
              (cause) =>
                new LegacyMigrationNewWriteError({
                  message: `failed to copy from stdin: ${cause.message}`,
                }),
            ),
          );
        }
      }),
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
