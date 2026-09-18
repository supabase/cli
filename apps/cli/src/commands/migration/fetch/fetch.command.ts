import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationFetch } from "./fetch.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Fetches migrations from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Fetches migration history from the linked project."),
    Flag.withDefault(true),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Fetches migration history from the local database."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type MigrationFetchFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationFetchCommand = Command.make("fetch", config).pipe(
  Command.withDescription("Fetch migration files from history table."),
  Command.withShortDescription("Fetch migration files from history table"),
  Command.withHandler((flags) =>
    migrationFetch(flags).pipe(
      withCommandTelemetry({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
        },
        // `--project-ref` has no telemetry-safety baseline, so it stays redacted.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "fetch"])),
);
