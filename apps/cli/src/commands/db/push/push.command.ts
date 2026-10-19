import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbPush } from "./push.handler.ts";
import { dbPushRuntimeLayer } from "./push.layers.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  includeAll: Flag.Boolean("include-all").pipe(
    Flag.withDescription("Include all migrations not found on remote history table."),
    Flag.withDefault(false),
  ),
  includeRoles: Flag.Boolean("include-roles").pipe(
    Flag.withDescription("Include custom roles from supabase/roles.sql."),
    Flag.withDefault(false),
  ),
  includeSeed: CliConfigKeys.db.seed.enabled.flag({
    name: "include-seed",
    description: "Include seed data from your config.",
  }),
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
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the linked project (--linked/--project-ref). Not used with --local or --db-url.",
  }),
} as const;

export type DbPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Push new migrations to the remote database. Vault secrets from config.toml are updated before migrations unless --skip-vault is set.",
  ),
  Command.withShortDescription("Push new migrations to the remote database"),
  withPermissions(
    withDbTarget(
      compose(
        {
          operations: [],
          noApiEffectFlags: [
            "include-all",
            "include-roles",
            "include-seed",
            "skip-vault",
            "dry-run",
          ],
        },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      ),
      { default: "local" },
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
          remote: flags.remote,
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
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
