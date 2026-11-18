import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { branchRef } from "../../../command-internal/branch-ref.resolver.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  name: cliArgument("name", Argument.String, {
    description: "Name or ID of the branch to delete.",
    optional: true,
  }),
  ...projectTargetFlags({ parent: true }),
} as const;
export type BranchesDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesDeleteCommand = makeCommand("delete", config).pipe(
  Command.withDescription(
    "Remove a preview branch you no longer need from the linked project.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Delete a preview branch"),
  Command.withExamples([
    {
      command: "supabase branches delete my-branch",
      description: "Delete a preview branch",
    },
    {
      command: "supabase branches delete my-branch --yes",
      description: "Delete a preview branch without the confirmation prompt",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-delete-a-branch", kind: "required" }] },
      branchesParentTarget,
      projectRefPicker,
      branchPrompt,
      branchRef,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesDelete(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "delete"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
