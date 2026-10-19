import { Command } from "effect/cli";
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
import { migrationFetch } from "./fetch.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = targetFlags({ subject: "database", dbUrl: true });

export type MigrationFetchFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationFetchCommand = Command.make("fetch", config).pipe(
  Command.withDescription("Fetch migration files from history table."),
  Command.withShortDescription("Fetch migration files from history table"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: [] },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
        branchResolution,
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    migrationFetch(flags).pipe(
      withCommandTelemetry({
        flags: {
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
        },
        // `--project-ref` has no telemetry-safety baseline, so it stays redacted.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "fetch"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the remote migration history and writes only local migration files",
  }),
);
