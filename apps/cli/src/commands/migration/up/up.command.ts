import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationUp } from "./up.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  includeAll: cliFlag("include-all", Flag.Boolean, {
    description: "Include all migrations not found in the migration history table.",
    default: false,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
} as const;

export type MigrationUpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationUpCommand = makeCommand("up", config).pipe(
  Command.withDescription(
    "Apply local migrations that are not yet in the migration history of a database. Unlike db push, it only runs migrations and does not push roles, seeds, or vault secrets.",
  ),
  Command.withShortDescription("Apply pending migrations to a database"),
  Command.withExamples([
    {
      command: "supabase migration up",
      description: "Apply pending migrations to the local database",
    },
    {
      command: "supabase migration up --remote --include-all",
      description: "Apply all missing migrations to the linked project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["include-all"] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    migrationUp(flags).pipe(
      withCommandTelemetry({
        flags: {
          "include-all": flags.includeAll,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "up"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
