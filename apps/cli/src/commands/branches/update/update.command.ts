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

const BRANCH_STATUSES = [
  "RUNNING_MIGRATIONS",
  "MIGRATIONS_PASSED",
  "MIGRATIONS_FAILED",
  "FUNCTIONS_DEPLOYED",
  "FUNCTIONS_FAILED",
] as const;

const config = {
  branchId: Argument.String("name").pipe(
    Argument.withDescription("Branch name or ID to update."),
    Argument.optional,
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(Flag.withDescription("Rename the preview branch."), Flag.optional),
  gitBranch: Flag.String("git-branch").pipe(
    Flag.withDescription("Change the associated git branch."),
    Flag.optional,
  ),
  // Optional so the handler can distinguish "explicit false" (demote to
  // ephemeral) from "absent".
  persistent: Flag.Boolean("persistent").pipe(
    Flag.withDescription("Switch between ephemeral and persistent branch."),
    Flag.optional,
  ),
  status: Flag.Literals("status", BRANCH_STATUSES).pipe(
    Flag.withDescription("Override the current branch status."),
    Flag.optional,
  ),
  notifyUrl: Flag.String("notify-url").pipe(
    Flag.withDescription("URL to notify when branch is active healthy."),
    Flag.optional,
  ),
} as const;

export type BranchesUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update a preview branch by its name or ID."),
  Command.withShortDescription("Update a preview branch"),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-update-a-branch-config", kind: "required" }],
        noApiEffectFlags: ["name", "git-branch", "persistent", "status", "notify-url"],
      },
      projectRefPicker,
      branchPrompt,
      branchRef,
      upgradeSuggestion,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesUpdate(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "update"])),
);
