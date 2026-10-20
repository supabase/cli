import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/remote-target.layer.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { branchRef } from "../../../command-internal/branch-ref.resolver.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesDelete } from "./delete.handler.ts";

const config = {
  name: Argument.String("name").pipe(
    Argument.withDescription("Branch name or ID to delete."),
    Argument.optional,
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;
export type BranchesDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete a preview branch by its name or ID."),
  Command.withShortDescription("Delete a preview branch"),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-delete-a-branch", kind: "required" }] },
      projectRefPicker,
      branchPrompt,
      branchRef,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesDelete(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "delete"])),
);
