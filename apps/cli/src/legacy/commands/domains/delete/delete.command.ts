import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDomainsDelete } from "./delete.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  includeRawOutput: Flag.boolean("include-raw-output").pipe(
    Flag.withDescription("(Deprecated) use -o json instead."),
  ),
} as const;

export type LegacyDomainsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Deletes the custom hostname config for your project."),
  Command.withShortDescription("Delete the custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains delete --project-ref abcdefghijklmnopqrst",
      description: "Delete the custom hostname config for a project",
    },
  ]),
  Command.withHandler((flags) =>
    legacyDomainsDelete(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["domains", "delete"])),
);
