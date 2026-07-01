import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationDbRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationList } from "./list.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Lists migrations of the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Lists migrations applied to the linked project."),
    // Go: `listFlags.Bool("linked", true, …)`.
    Flag.withDefault(true),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Lists migrations applied to the local database."),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationListCommand = Command.make("list", config).pipe(
  Command.withDescription("List local and remote migrations."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((flags) =>
    legacyMigrationList(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationDbRuntimeLayer(["migration", "list"])),
);
