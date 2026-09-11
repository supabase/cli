import { Argument, Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationRepair } from "./repair.handler.ts";

const config = {
  versions: Argument.String("version").pipe(
    Argument.withDescription("Migration version(s) to repair."),
    Argument.variadic(),
  ),
  status: Flag.Literals("status", ["applied", "reverted"] as const).pipe(
    Flag.withDescription("Version status to update."),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Repairs migrations of the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Repairs the migration history of the linked project."),
    Flag.withDefault(true),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Repairs the migration history of the local database."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  password: Flag.String("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export const migrationRepairCommand = Command.make("repair", config).pipe(
  Command.withDescription("Repair the migration history table."),
  Command.withShortDescription("Repair the migration history table"),
  Command.withHandler((flags) =>
    migrationRepair({
      versions: flags.versions.map(String),
      status: flags.status,
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
      projectRef: flags.projectRef,
      password: flags.password,
    }).pipe(
      withCommandTelemetry({
        flags: {
          status: flags.status,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // --status is auto-detected as safe via config below; password and
        // --project-ref stay redacted.
        config,
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "repair"])),
);
