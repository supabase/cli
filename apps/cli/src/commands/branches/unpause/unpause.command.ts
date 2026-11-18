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
import { branchesUnpause } from "./unpause.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  name: cliArgument("name", Argument.String, {
    description: "Name or ID of the branch to unpause.",
    optional: true,
  }),
  ...projectTargetFlags({ parent: true }),
} as const;

export type BranchesUnpauseFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesUnpauseCommand = makeCommand("unpause", config).pipe(
  Command.withDescription(
    "Resume a paused preview branch so you can use it again.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Unpause a preview branch"),
  Command.withExamples([
    {
      command: "supabase branches unpause my-branch",
      description: "Resume a paused preview branch",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-restore-a-project", kind: "required" }] },
      branchesParentTarget,
      projectRefPicker,
      branchPrompt,
      branchRef,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesUnpause(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "unpause"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
