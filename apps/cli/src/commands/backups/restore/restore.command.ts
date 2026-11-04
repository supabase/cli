import type * as CliCommand from "effect/cli/Command";
import { Command, Flag } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { backupsRestore } from "./restore.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  timestamp: cliFlag("timestamp", Flag.Int, {
    description: "Recovery target time, as a Unix timestamp in seconds.",
    alias: "t",
    optional: true,
  }),
} as const;

export type BackupsRestoreFlags = CliCommand.Command.Config.Infer<typeof config>;

export const backupsRestoreCommand = makeCommand("restore", config).pipe(
  Command.withDescription(
    "Restore the project database to a point in time using PITR. Changes made after that time are lost.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Restore a project to a point in time"),
  Command.withExamples([
    {
      command: "supabase backups restore --timestamp 1707407047",
      description: "Restore to the given Unix epoch timestamp",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-restore-pitr-backup", kind: "required" }],
        noApiEffectFlags: ["timestamp"],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    backupsRestore(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["backups", "restore"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
