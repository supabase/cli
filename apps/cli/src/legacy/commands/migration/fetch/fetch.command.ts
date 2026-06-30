import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationDbRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationFetch } from "./fetch.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Fetches migrations from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Fetches migration history from the linked project."),
    // Go: `fetchFlags.Bool("linked", true, …)`.
    Flag.withDefault(true),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Fetches migration history from the local database."),
  ),
} as const;

export type LegacyMigrationFetchFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationFetchCommand = Command.make("fetch", config).pipe(
  Command.withDescription("Fetch migration files from history table."),
  Command.withShortDescription("Fetch migration files from history table"),
  Command.withHandler((flags) =>
    legacyMigrationFetch(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationDbRuntimeLayer(["migration", "fetch"])),
);
