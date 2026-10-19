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
import { migrationDown } from "./down.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  // `--last` is conceptually a uint (default 1); Effect has no uint type, so negatives are
  // rejected explicitly.
  last: Flag.Int("last").pipe(
    Flag.withDescription("Reset up to the last n migration versions."),
    Flag.withDefault(1),
    Flag.mapTryCatch(
      (value) => {
        if (value < 0) {
          throw new Error(`invalid argument "${value}" for "--last" flag: must be greater than 0`);
        }
        return value;
      },
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  ...targetFlags({ subject: "database", dbUrl: true }),
} as const;

export type MigrationDownFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationDownCommand = Command.make("down", config).pipe(
  Command.withDescription("Resets applied migrations up to the last n versions."),
  Command.withShortDescription("Resets applied migrations up to the last n versions"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: ["last"] },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
        branchResolution,
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    migrationDown(flags).pipe(
      withCommandTelemetry({
        flags: {
          last: flags.last,
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
        },
        // `--project-ref` isn't marked safe here, so it stays redacted.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "down"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
