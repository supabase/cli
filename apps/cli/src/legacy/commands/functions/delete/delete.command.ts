import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
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
  Command.withHandler((flags) =>
    legacyFunctionsDelete(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["functions", "delete"])),
);
