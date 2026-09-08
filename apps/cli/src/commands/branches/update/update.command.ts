import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

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
  branchId: Argument.string("name").pipe(
    Argument.withDescription("Branch name or ID to update."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(Flag.withDescription("Rename the preview branch."), Flag.optional),
  gitBranch: Flag.string("git-branch").pipe(
    Flag.withDescription("Change the associated git branch."),
    Flag.optional,
  ),
  // Optional so the handler can distinguish "explicit false" (demote to
  // ephemeral) from "absent".
  persistent: Flag.boolean("persistent").pipe(
    Flag.withDescription("Switch between ephemeral and persistent branch."),
    Flag.optional,
  ),
  status: Flag.choice("status", BRANCH_STATUSES).pipe(
    Flag.withDescription("Override the current branch status."),
    Flag.optional,
  ),
  notifyUrl: Flag.string("notify-url").pipe(
    Flag.withDescription("URL to notify when branch is active healthy."),
    Flag.optional,
  ),
} as const;

export type BranchesUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update a preview branch by its name or ID."),
  Command.withShortDescription("Update a preview branch"),
  Command.withHandler((flags) =>
    branchesUpdate(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "update"])),
);
