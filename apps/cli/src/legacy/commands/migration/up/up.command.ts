import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationDbRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationUp } from "./up.handler.ts";

const config = {
  includeAll: Flag.boolean("include-all").pipe(
    Flag.withDescription("Include all migrations not found on remote history table."),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Applies migrations to the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Applies pending migrations to the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Applies pending migrations to the local database."),
    // Go: `upFlags.Bool("local", true, …)`.
    Flag.withDefault(true),
  ),
} as const;

export type LegacyMigrationUpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationUpCommand = Command.make("up", config).pipe(
  Command.withDescription("Apply pending migrations to local database."),
  Command.withShortDescription("Apply pending migrations to local database"),
  Command.withHandler((flags) =>
    legacyMigrationUp(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "include-all": flags.includeAll,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationDbRuntimeLayer(["migration", "up"])),
);
