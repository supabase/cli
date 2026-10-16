import { Argument, Command, Flag } from "effect/cli";
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

const config = {
  name: Argument.String("name").pipe(
    Argument.withDescription("Branch name or ID to pause."),
    Argument.optional,
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type BranchesPauseFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesPauseCommand = Command.make("pause", config).pipe(
  Command.withDescription("Pause a preview branch."),
  Command.withShortDescription("Pause a preview branch"),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-pause-a-project", kind: "required" }] },
      projectRefPicker,
      branchPrompt,
      branchRef,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesPause(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "pause"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
