import { Argument, Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationDbRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationRepair } from "./repair.handler.ts";

const config = {
  versions: Argument.string("version").pipe(
    Argument.withDescription("Migration version(s) to repair."),
    Argument.variadic(),
  ),
  status: Flag.choice("status", ["applied", "reverted"] as const).pipe(
    Flag.withDescription("Version status to update."),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Repairs migrations of the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Repairs the migration history of the linked project."),
    // Go: `repairFlags.Bool("linked", true, …)`.
    Flag.withDefault(true),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Repairs the migration history of the local database."),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export const legacyMigrationRepairCommand = Command.make("repair", config).pipe(
  Command.withDescription("Repair the migration history table."),
  Command.withShortDescription("Repair the migration history table"),
  Command.withHandler((flags) =>
    legacyMigrationRepair({
      versions: flags.versions.map(String),
      status: flags.status,
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
      password: flags.password,
    }).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          status: flags.status,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // Go records `utils.EnumFlag` values verbatim (`--status`); password stays redacted.
        safeFlags: ["status"],
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationDbRuntimeLayer(["migration", "repair"])),
);
