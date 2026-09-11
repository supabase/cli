import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbPush } from "./push.handler.ts";
import { dbPushRuntimeLayer } from "./push.layers.ts";

const config = {
  includeAll: Flag.Boolean("include-all").pipe(
    Flag.withDescription("Include all migrations not found on remote history table."),
    Flag.withDefault(false),
  ),
  includeRoles: Flag.Boolean("include-roles").pipe(
    Flag.withDescription("Include custom roles from supabase/roles.sql."),
    Flag.withDefault(false),
  ),
  includeSeed: Flag.Boolean("include-seed").pipe(
    Flag.withDescription("Include seed data from your config."),
    Flag.withDefault(false),
  ),
  skipVault: Flag.Boolean("skip-vault").pipe(
    Flag.withDescription("Skip updating vault secrets from config.toml."),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Print the migrations that would be applied, but don't actually apply them.",
    ),
    Flag.withDefault(false),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Pushes to the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Pushes to the linked project."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Pushes to the local database."),
    Flag.withDefault(false),
  ),
  // Feeds `ProjectRefResolver.loadProjectRef`: flag > `SUPABASE_PROJECT_ID` >
  // `supabase/.temp/project-ref`. Only feeds ref resolution — it does not affect local
  // container ids or the pg-delta project id (see `db-config.types.ts`'s
  // `linkedProjectRef` doc) — and is rejected outright on a non-linked target rather
  // than silently ignored (see the handler's guard).
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

export type DbPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Push new migrations to the remote database. Vault secrets from config.toml are updated before migrations unless --skip-vault is set.",
  ),
  Command.withShortDescription("Push new migrations to the remote database"),
  Command.withHandler((flags) =>
    dbPush(flags).pipe(
      withCommandTelemetry({
        flags: {
          "include-all": flags.includeAll,
          "include-roles": flags.includeRoles,
          "include-seed": flags.includeSeed,
          "skip-vault": flags.skipVault,
          "dry-run": flags.dryRun,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // Not on the established `--project-ref` safeFlags allowlist, so it stays redacted.
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbPushRuntimeLayer),
);
