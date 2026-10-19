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

const config = {
  functionName: Argument.String("Function name").pipe(
    Argument.withDescription("Name of the Function to delete."),
  ),
  ...projectTargetFlags(),
} as const;

export type FunctionsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const functionsDeleteHandler = (flags: FunctionsDeleteFlags) =>
  functionsDelete(flags).pipe(
    withCommandTelemetry({
      flags,
    }),
    withJsonErrorHandling,
  );

export const functionsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
  ),
  Command.withShortDescription("Delete a Function from Supabase"),
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
