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
import { branchesPause } from "./pause.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";

const config = {
  name: Argument.String("name").pipe(
    Argument.withDescription("Branch name or ID to pause."),
    Argument.optional,
  ),
  ...projectTargetFlags(),
} as const;

export type BranchesPauseFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesPauseCommand = Command.make("pause", config).pipe(
  Command.withDescription("Pause a preview branch."),
  Command.withShortDescription("Pause a preview branch"),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-pause-a-project", kind: "required" }] },
      branchesParentTarget,
      projectRefPicker,
      branchPrompt,
      branchRef,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesPause(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "pause"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
