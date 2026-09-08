import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type FunctionsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const functionsListCommand = Command.make("list", config).pipe(
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
    functionsList(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["functions", "list"])),
);
