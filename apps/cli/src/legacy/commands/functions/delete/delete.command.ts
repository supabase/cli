import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyFunctionsDelete } from "./delete.handler.ts";

const config = {
  functionName: Argument.string("Function name").pipe(
    Argument.withDescription("Name of the Function to delete."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyFunctionsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyFunctionsDeleteHandler = (flags: LegacyFunctionsDeleteFlags) =>
  legacyFunctionsDelete(flags).pipe(
    withLegacyCommandInstrumentation({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
    withJsonErrorHandling,
  );

export const legacyFunctionsDeleteCommand = Command.make("delete", config).pipe(
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
      command: "supabase functions delete hello-world --project-ref abcdefghijklmnopqrst",
      description: "Delete a deployed function from a specific project",
    },
  ]),
  Command.withHandler(legacyFunctionsDeleteHandler),
  Command.provide(legacyManagementApiRuntimeLayer(["functions", "delete"])),
);
