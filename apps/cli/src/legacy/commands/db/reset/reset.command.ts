import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbReset } from "./reset.handler.ts";
import { legacyDbResetRuntimeLayer } from "./reset.layers.ts";

const noSqlPaths: ReadonlyArray<string> = [];

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Resets the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Resets the linked project with local migrations."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Resets the local database with local migrations."),
  ),
  // TS-only override of the linked project ref — see push.command.ts.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  noSeed: Flag.boolean("no-seed").pipe(
    Flag.withDescription("Skip running the seed script after reset."),
  ),
  sqlPaths: Flag.string("sql-paths").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Override [db.seed].sql_paths for this reset. May be repeated; each value accepts a SQL file path or glob pattern relative to the supabase directory and force-enables seeding.",
    ),
    Flag.withDefault(noSqlPaths),
  ),
  version: Flag.string("version").pipe(
    Flag.withDescription("Reset up to the specified version."),
    Flag.optional,
  ),
  last: Flag.integer("last").pipe(
    Flag.withDescription("Reset up to the last n migration versions."),
    Flag.optional,
  ),
} as const;

export type LegacyDbResetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbResetCommand = Command.make("reset", config).pipe(
  Command.withDescription("Resets the local database to current migrations."),
  Command.withShortDescription("Resets the local database to current migrations"),
  Command.withHandler((flags) =>
    legacyDbReset(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          "no-seed": flags.noSeed,
          "sql-paths": flags.sqlPaths,
          version: flags.version,
          last: flags.last,
        },
        // NO safeFlags: `markFlagTelemetrySafe` is per flag INSTANCE, and Go only
        // marks migration squash's `--version` (cmd/migration.go:134). db reset's
        // `--version` (cmd/db.go) is unmarked, so Go redacts it — match that.
        // `--project-ref` is TS-only with no Go telemetry-safety baseline either
        // (Go's nearest registrations, cmd/pgdelta_catalog.go:44 and most others,
        // are unmarked too), so it stays redacted as well.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbResetRuntimeLayer),
);
