import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacyBranchesUpdate } from "./update.handler.ts";

const BRANCH_STATUSES = [
  "RUNNING_MIGRATIONS",
  "MIGRATIONS_PASSED",
  "MIGRATIONS_FAILED",
  "FUNCTIONS_DEPLOYED",
  "FUNCTIONS_FAILED",
] as const;

const config = {
  branchId: Argument.string("branch-id").pipe(
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
  persistent: Flag.boolean("persistent").pipe(
    Flag.withDescription("Switch between ephemeral and persistent branch."),
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

export const legacyBranchesUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update a preview branch by its name or ID."),
  Command.withShortDescription("Update a preview branch"),
  Command.withHandler((flags) => legacyBranchesUpdate(flags)),
);
