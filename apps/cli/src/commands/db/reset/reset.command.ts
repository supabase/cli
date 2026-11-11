import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbReset } from "./reset.handler.ts";
import { dbResetRuntimeLayer } from "./reset.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  noSeed: CliConfigKeys.db.seed.enabled.flag({
    name: "no-seed",
    description: "Skip running the seed script after reset.",
    map: (skip) => (skip ? false : undefined),
  }),
  sqlPaths: CliConfigKeys.db.seed.sqlPaths.flag({
    name: "sql-paths",
    description:
      "Override [db.seed].sql_paths for this reset with SQL file paths or glob patterns relative to the supabase directory, which also enables seeding.",
    also: [[CliConfigKeys.db.seed.enabled, true]],
  }),
  version: cliFlag("version", Flag.String, {
    description: "Reset up to the specified migration version.",
    optional: true,
  }),
  last: cliFlag("last", Flag.Int, {
    description: "Reset up to the last n migration versions.",
    optional: true,
  }),
} as const;

export type DbResetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbResetCommand = makeCommand("reset", config).pipe(
  Command.withDescription(
    "Recreate a database from your local migrations and seed it, discarding any other data or schema changes. Use it to get a clean database during development.",
  ),
  Command.withShortDescription("Reset a database to the current migrations"),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["no-seed", "sql-paths", "version", "last"] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    dbReset(flags).pipe(
      withCommandTelemetry({
        flags: {
          "no-seed": flags.noSeed,
          "sql-paths": flags.sqlPaths,
          version: flags.version,
          last: flags.last,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbResetRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
