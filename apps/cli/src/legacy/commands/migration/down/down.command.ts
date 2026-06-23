import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationDbRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationDown } from "./down.handler.ts";

const config = {
  // Go's `--last` is a `uint` (`down.go`), default 1. Effect has no uint, so reject
  // negatives explicitly to reproduce cobra's `ParseUint` rejection (the message
  // differs slightly — an accepted small divergence).
  last: Flag.integer("last").pipe(
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
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Resets applied migrations on the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Resets applied migrations on the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Resets applied migrations on the local database."),
    // Go: `downFlags.Bool("local", true, …)`.
    Flag.withDefault(true),
  ),
} as const;

export type LegacyMigrationDownFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationDownCommand = Command.make("down", config).pipe(
  Command.withDescription("Resets applied migrations up to the last n versions."),
  Command.withShortDescription("Resets applied migrations up to the last n versions"),
  Command.withHandler((flags) =>
    legacyMigrationDown(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          last: flags.last,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationDbRuntimeLayer(["migration", "down"])),
);
