import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationSquashRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationSquash } from "./squash.handler.ts";

const config = {
  version: Flag.string("version").pipe(
    Flag.withDescription("Squash up to the specified version."),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Squashes migrations of the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Squashes the migration history of the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Squashes the migration history of the local database."),
    // Go: `squashFlags.Bool("local", true, …)`.
    Flag.withDefault(true),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationSquashFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationSquashCommand = Command.make("squash", config).pipe(
  Command.withDescription("Squash migrations to a single file."),
  Command.withShortDescription("Squash migrations to a single file"),
  Command.withHandler((flags) =>
    legacyMigrationSquash(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          version: flags.version,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // Go's `markFlagTelemetrySafe(migration.go:134)` — only `--version`'s value is
        // recorded verbatim.
        safeFlags: ["version"],
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyMigrationSquashRuntimeLayer),
);
