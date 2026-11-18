import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  functionName: cliArgument("Function name", Argument.String, {
    description: "Name of the function to delete.",
    required: true,
  }),
  ...projectTargetFlags(),
} as const;

export type FunctionsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

const functionsDeleteHandler = (flags: FunctionsDeleteFlags) =>
  functionsDelete(flags).pipe(
    withCommandTelemetry({
      flags,
    }),
    withJsonErrorHandling,
  );

export const functionsDeleteCommand = makeCommand("delete", config).pipe(
  Command.withDescription(
    "Delete a deployed Edge Function from the linked project. Your local copy in `supabase/functions` is not removed.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Delete an Edge Function from a project"),
  Command.withExamples([
    {
      command: "supabase functions delete hello-world",
      description: "Delete a deployed function from the linked project",
    },
    {
      command: "supabase functions delete hello-world --remote=abcdefghijklmnopqrst",
      description: "Delete a deployed function from a specific project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-delete-a-function", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler(functionsDeleteHandler),
  Command.provide(managementApiRuntimeLayer(["functions", "delete"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
