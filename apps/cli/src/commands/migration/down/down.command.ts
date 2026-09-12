import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationDown } from "./down.handler.ts";

const config = {
  // `--last` is conceptually a uint (default 1); Effect has no uint type, so negatives are
  // rejected explicitly.
  last: Flag.Int("last").pipe(
    Flag.withDescription("Reset up to the last n migration versions."),
    Flag.withDefault(1),
    Flag.mapTryCatch(
      (value) => {
        if (value < 0) {
          throw new Error(`invalid argument "${value}" for "--last" flag: must be greater than 0`);
        }
        return value;
      },
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Resets applied migrations on the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Resets applied migrations on the linked project."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Resets applied migrations on the local database."),
    Flag.withDefault(true),
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type MigrationDownFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationDownCommand = Command.make("down", config).pipe(
  Command.withDescription("Resets applied migrations up to the last n versions."),
  Command.withShortDescription("Resets applied migrations up to the last n versions"),
  Command.withHandler((flags) =>
    migrationDown(flags).pipe(
      withCommandTelemetry({
        flags: {
          last: flags.last,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
        },
        // `--project-ref` isn't marked safe here, so it stays redacted.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "down"])),
);
