import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationSquashRuntimeLayer } from "../migration.layers.ts";
import { migrationSquash } from "./squash.handler.ts";

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
    Flag.withDefault(false),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Squashes the migration history of the local database."),
    Flag.withDefault(true),
  ),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Password to your remote Postgres database.",
  }),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type MigrationSquashFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationSquashCommand = Command.make("squash", config).pipe(
  Command.withDescription("Squash migrations to a single file."),
  Command.withShortDescription("Squash migrations to a single file"),
  Command.withHandler((flags) =>
    migrationSquash(flags).pipe(
      withCommandTelemetry({
        flags: {
          version: flags.version,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
          "project-ref": flags.projectRef,
        },
        // Only `--version`'s value is recorded verbatim. `--project-ref` has no
        // established telemetry-safety baseline, so it stays redacted.
        safeFlags: ["version"],
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationSquashRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
);
