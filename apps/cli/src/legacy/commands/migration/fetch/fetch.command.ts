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
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
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
          "project-ref": flags.projectRef,
        },
        // TS-only flag with no Go telemetry-safety baseline; Go's nearest
        // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
        // others) are unmarked, so it stays redacted.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationDbRuntimeLayer(["migration", "fetch"])),
);
