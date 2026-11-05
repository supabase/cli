import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withDocs } from "../../../docs/command-docs.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import body from "./push.docs.md" with { type: "text" };
import { dbPush } from "./push.handler.ts";
import { dbPushRuntimeLayer } from "./push.layers.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  includeAll: cliFlag("include-all", Flag.Boolean, {
    description: "Include all migrations not found in the migration history table.",
    default: false,
  }),
  includeRoles: cliFlag("include-roles", Flag.Boolean, {
    description: "Include custom roles from supabase/roles.sql.",
    default: false,
  }),
  includeSeed: CliConfigKeys.db.seed.enabled.flag({
    name: "include-seed",
    description: "Include seed data from your config.",
  }),
  skipVault: cliFlag("skip-vault", Flag.Boolean, {
    description: "Skip updating vault secrets from config.toml.",
    default: false,
  }),
  dryRun: cliFlag("dry-run", Flag.Boolean, {
    description: "Print the migrations that would be applied, without applying them.",
    default: false,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
} as const;

export type DbPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbPushCommand = makeCommand("push", config).pipe(
  Command.withDescription(
    "Apply local migrations that are not yet in the migration history of a database. Vault secrets from config.toml are updated first unless --skip-vault is set.",
  ),
  Command.withShortDescription("Push new migrations to a database"),
  withDocs({
    category: "database",
    body,
    examples: [
      {
        id: "basic-usage",
        name: "Basic usage",
        code: "supabase db push --remote",
        response: `Linked project is up to date.
`,
      },
      {
        id: "self-hosted",
        name: "Self hosted",
        code: 'supabase db push --remote="postgres://user:pass@db.example.com:5432/postgres"',
        output: "recorded",
        scenario: "docker-self-hosted",
        response: `Target: custom Postgres (db.example.com:5432)
Applying migration 20240102000000_add_employee_email.sql...
Finished supabase db push.
`,
      },
      {
        id: "dry-run",
        name: "Dry run",
        code: "supabase db push --dry-run --remote",
        response: `DRY RUN: migrations will *not* be pushed to the database.
Would push migration 20230410135622_create_employees_table.sql...
Would push migration 20230425064254_my_table.sql...
Finished supabase db push.
`,
      },
    ],
  }),
  withPermissions(
    compose(
      {
        operations: [],
        noApiEffectFlags: ["include-all", "include-roles", "include-seed", "skip-vault", "dry-run"],
      },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    dbPush(flags).pipe(
      withCommandTelemetry({
        flags: {
          "include-all": flags.includeAll,
          "include-roles": flags.includeRoles,
          "include-seed": flags.includeSeed,
          "skip-vault": flags.skipVault,
          "dry-run": flags.dryRun,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbPushRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
