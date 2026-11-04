import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags({ parent: true }),
} as const;

export type BranchesListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesListCommand = makeCommand("list", config).pipe(
  Command.withDescription(
    "Show the preview branches of the linked project. Use it to find the name or ID that the other `branches` commands take.",
  ),
  Command.withShortDescription("List all preview branches"),
  Command.withExamples([
    {
      command: "supabase branches list",
      description: "List all preview branches of the linked project",
    },
    {
      command: "supabase branches list --output-format json",
      description: "List preview branches as JSON",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-branches", kind: "required" }] },
      branchesParentTarget,
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
