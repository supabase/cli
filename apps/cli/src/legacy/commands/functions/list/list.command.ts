import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyFunctionsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyFunctionsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyFunctionsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all Functions in the linked Supabase project."),
  Command.withShortDescription("List all Functions in Supabase"),
  Command.withExamples([
    {
      command: "supabase functions list",
      description: "List all deployed functions in the linked project",
    },
    {
      command: "supabase functions list --project-ref abcdefghijklmnopqrst",
      description: "List all deployed functions in a specific project",
    },
  ]),
  Command.withHandler((flags) =>
    legacyFunctionsList(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["functions", "list"])),
);
