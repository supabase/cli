import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbPush } from "./push.handler.ts";
import { legacyDbPushRuntimeLayer } from "./push.layers.ts";

const config = {
  includeAll: Flag.boolean("include-all").pipe(
    Flag.withDescription("Include all migrations not found on remote history table."),
  ),
  includeRoles: Flag.boolean("include-roles").pipe(
    Flag.withDescription("Include custom roles from supabase/roles.sql."),
  ),
  includeSeed: Flag.boolean("include-seed").pipe(
    Flag.withDescription("Include seed data from your config."),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription(
      "Print the migrations that would be applied, but don't actually apply them.",
    ),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Pushes to the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Pushes to the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Pushes to the local database.")),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbPushCommand = Command.make("push", config).pipe(
  Command.withDescription("Push new migrations to the remote database."),
  Command.withShortDescription("Push new migrations to the remote database"),
  Command.withHandler((flags) =>
    legacyDbPush(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "include-all": flags.includeAll,
          "include-roles": flags.includeRoles,
          "include-seed": flags.includeSeed,
          "dry-run": flags.dryRun,
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
  Command.provide(legacyDbPushRuntimeLayer),
);
