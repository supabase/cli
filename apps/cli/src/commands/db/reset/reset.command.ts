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
      "Override [db.seed].sql_paths for this reset. May be repeated; each value accepts a SQL file path or glob pattern relative to the supabase directory and force-enables seeding.",
    also: [[CliConfigKeys.db.seed.enabled, true]],
  }),
  version: Flag.String("version").pipe(
    Flag.withDescription("Reset up to the specified version."),
    Flag.optional,
  ),
  last: Flag.Int("last").pipe(
    Flag.withDescription("Reset up to the last n migration versions."),
    Flag.optional,
  ),
} as const;

export type DbResetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbResetCommand = Command.make("reset", config).pipe(
  Command.withDescription("Resets a database to current migrations."),
  Command.withShortDescription("Resets a database to current migrations"),
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
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
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
