import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyProjectsList } from "./list.handler.ts";

const config = {};
export type LegacyProjectsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyProjectsListCommand = Command.make("list", config).pipe(
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
    legacyProjectsList(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: [] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["projects", "list"])),
);
