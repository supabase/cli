import type * as CliCommand from "effect/cli/Command";
import { Command } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { backupsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type BackupsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const backupsListCommand = Command.make("list", config).pipe(
  Command.withDescription("Lists available physical backups"),
  Command.withShortDescription("Lists available physical backups"),
  Command.withExamples([
    {
      command: "supabase backups list",
      description: "List all physical backups",
    },
    {
      command: "supabase backups list --remote=<ref>",
      description: "List backups for a specific project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-backups", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    backupsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["backups", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
