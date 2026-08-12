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
  skipVault: Flag.boolean("skip-vault").pipe(
    Flag.withDescription("Skip updating vault secrets from config.toml."),
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
  // TS-only flag on every user-facing `db` subcommand (Go's user-facing `db`
  // commands never registered --project-ref; only the SUPABASE_PROJECT_ID env
  // var could override the linked ref). The one Go exception is a hidden seam,
  // not a user-facing flag: `db declarative __catalog --project-ref` exists
  // solely so the native TS declarative commands can forward the resolved
  // linked ref to the bundled Go binary (`apps/cli-go/cmd/pgdelta_catalog.go:44`).
  // Feeds LegacyProjectRefResolver.loadProjectRef, which keeps Go's precedence:
  // flag > SUPABASE_PROJECT_ID > supabase/.temp/project-ref. Unlike that env
  // var, this flag ONLY feeds ref resolution — it does not affect local
  // container ids or the pg-delta project id (see legacy-db-config.types.ts's
  // `linkedProjectRef` doc for the full non-overlap), and is rejected outright
  // on a non-linked target rather than silently ignored (see the handler's
  // guard).
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Push new migrations to the remote database. Vault secrets from config.toml are updated before migrations unless --skip-vault is set.",
  ),
  Command.withShortDescription("Push new migrations to the remote database"),
  Command.withHandler((flags) =>
    legacyDbPush(flags).pipe(
      withLegacyCommandInstrumentation({
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
        // TS-only flag with no Go telemetry-safety baseline; Go's nearest
        // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
        // others) are unmarked, so it stays redacted.
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbPushRuntimeLayer),
);
