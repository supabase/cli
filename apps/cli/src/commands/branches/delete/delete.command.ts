import { Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { branchRef } from "../../../command-internal/branch-ref.resolver.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withManagedHandler } from "../../../command-internal/command-executor.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { branchesDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";

const config = {
  name: Argument.String("name").pipe(
    Argument.withDescription("Branch name or ID to delete."),
    Argument.optional,
  ),
  ...projectTargetFlags({ parent: true }),
} as const;
export type BranchesDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const BranchesDeleteResult = Schema.Struct({
  project_ref: Schema.String,
  message: Schema.Literal("Deleted preview branch"),
});

export const branchesDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete a preview branch by its name or ID."),
  Command.withShortDescription("Delete a preview branch"),
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
  withManagedHandler({ output: BranchesDeleteResult, handler: branchesDelete }),
  Command.provide(managementApiRuntimeLayer(["branches", "delete"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
