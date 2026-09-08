import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsList } from "./list.handler.ts";

const config = {};
export type ProjectsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all Supabase projects the logged-in user can access."),
  Command.withShortDescription("List all projects"),
  Command.withExamples([
    {
      command: "supabase projects list",
      description: "List all projects",
    },
    {
      command: "supabase projects list --output-format json",
      description: "Machine-readable JSON output",
    },
  ]),
  Command.withHandler((flags) =>
    projectsList(flags).pipe(withCommandTelemetry({ flags, safeFlags: [] }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "list"])),
);
