import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDomainsGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  includeRawOutput: Flag.boolean("include-raw-output").pipe(
    Flag.withDescription("(Deprecated) use -o json instead."),
  ),
} as const;

export type LegacyDomainsGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsGetCommand = Command.make("get", config).pipe(
  Command.withDescription(
    "Retrieve the custom hostname config for your project, as stored in the Supabase platform.",
  ),
  Command.withShortDescription("Get the current custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains get --project-ref abcdefghijklmnopqrst",
      description: "Get the custom hostname config for a project",
    },
  ]),
  Command.withHandler((flags) =>
    legacyDomainsGet(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["domains", "get"])),
);
