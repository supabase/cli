import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationDown } from "./down.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  // `--last` is conceptually a uint (default 1); Effect has no uint type, so negatives are
  // rejected explicitly.
  last: cliFlag("last", Flag.Int, {
    description: "Number of most recent migrations to revert.",
    parse: Flag.mapTryCatch(
      (value) => {
        if (value < 0) {
          throw new Error(`invalid argument "${value}" for "--last" flag: must be greater than 0`);
        }
        return value;
      },
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    default: 1,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
} as const;

export type MigrationDownFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationDownCommand = makeCommand("down", config).pipe(
  Command.withDescription(
    "Revert the most recent migrations by dropping the user schemas of a database and re-applying the migrations before them. This discards all data in the database, so use it with care.",
  ),
  Command.withShortDescription("Revert the last applied migrations"),
  Command.withExamples([
    {
      command: "supabase migration down --last 1",
      description: "Revert the most recent migration on the local database",
    },
  ]),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["last"] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    migrationDown(flags).pipe(
      withCommandTelemetry({
        flags: {
          last: flags.last,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "down"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
