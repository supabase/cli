import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { branchRef } from "../../../command-internal/branch-ref.resolver.ts";
import { upgradeSuggestion } from "../../../command-internal/upgrade-suggest.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesUpdate } from "./update.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const BRANCH_STATUSES = [
  "RUNNING_MIGRATIONS",
  "MIGRATIONS_PASSED",
  "MIGRATIONS_FAILED",
  "FUNCTIONS_DEPLOYED",
  "FUNCTIONS_FAILED",
] as const;

const config = {
  branchId: cliArgument("name", Argument.String, {
    description: "Name or ID of the branch to update.",
    optional: true,
  }),
  ...projectTargetFlags({ parent: true }),
  name: cliFlag("name", Flag.String, {
    description: "New name for the preview branch.",
    optional: true,
  }),
  gitBranch: cliFlag("git-branch", Flag.String, {
    description: "New git branch to associate with the preview branch.",
    optional: true,
  }),
  // Optional so the handler can distinguish "explicit false" (demote to
  // ephemeral) from "absent".
  persistent: cliFlag("persistent", Flag.Boolean, {
    description: "Switch the branch between ephemeral and persistent.",
    optional: true,
  }),
  status: cliFlag("status", (name) => Flag.Literals(name, BRANCH_STATUSES), {
    description: "Override the current branch status.",
    optional: true,
  }),
  notifyUrl: cliFlag("notify-url", Flag.String, {
    description: "URL to notify when the branch is active and healthy.",
    optional: true,
  }),
} as const;

export type BranchesUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesUpdateCommand = makeCommand("update", config).pipe(
  Command.withDescription(
    "Rename a preview branch, change its git branch or notify URL, or switch it between ephemeral and persistent.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Update a preview branch"),
  Command.withExamples([
    {
      command: "supabase branches update my-branch --name renamed-branch",
      description: "Rename a preview branch",
    },
    {
      command: "supabase branches update my-branch --persistent",
      description: "Switch a branch between ephemeral and persistent",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-update-a-branch-config", kind: "required" }],
        noApiEffectFlags: ["name", "git-branch", "persistent", "status", "notify-url"],
      },
      branchesParentTarget,
      projectRefPicker,
      branchPrompt,
      branchRef,
      upgradeSuggestion,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesUpdate(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "update"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
