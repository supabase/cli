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
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationUp } from "./up.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  includeAll: Flag.Boolean("include-all").pipe(
    Flag.withDescription("Include all migrations not found in the migration history table."),
    Flag.withDefault(false),
  ),
  ...targetFlags({ subject: "database", dbUrl: true }),
} as const;

export type MigrationUpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationUpCommand = Command.make("up", config).pipe(
  Command.withDescription("Apply pending migrations to a database."),
  Command.withShortDescription("Apply pending migrations to a database"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: ["include-all"] },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
        branchResolution,
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    migrationUp(flags).pipe(
      withCommandTelemetry({
        flags: {
          "include-all": flags.includeAll,
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
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
