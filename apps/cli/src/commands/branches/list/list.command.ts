import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type BranchesListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all preview branches of the linked project."),
  Command.withShortDescription("List all preview branches"),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-branches", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesList(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
