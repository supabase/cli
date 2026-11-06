import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationSquashRuntimeLayer } from "../migration.layers.ts";
import { migrationSquash } from "./squash.handler.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  version: cliFlag("version", Flag.String, {
    description: "Squash up to the specified migration version.",
    optional: true,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
} as const;

export type MigrationSquashFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationSquashCommand = makeCommand("squash", config).pipe(
  Command.withDescription(
    "Combine your local migrations into one file, which removes repeated changes to the same schema from your history. Data statements are not kept and must be re-added by hand.",
  ),
  Command.withShortDescription("Squash migrations into a single file"),
  Command.withExamples([
    {
      command: "supabase migration squash",
      description: "Squash all local migrations into the latest file",
    },
    {
      command: "supabase migration squash --version 20240101000000",
      description: "Squash migrations up to a given version",
    },
  ]),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["version"] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    migrationSquash(flags).pipe(
      withCommandTelemetry({
        flags: {
          version: flags.version,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        safeFlags: ["version"],
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationSquashRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
