import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesDisable } from "./disable.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget, branchesSafeFlags } from "../branches.target.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type BranchesDisableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesDisableCommand = Command.make("disable", config).pipe(
  Command.withDescription("Disable preview branching for the linked project."),
  Command.withShortDescription("Disable preview branching"),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-disable-preview-branching", kind: "required" }] },
      branchesParentTarget,
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesDisable(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: branchesSafeFlags(flags) }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "disable"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
