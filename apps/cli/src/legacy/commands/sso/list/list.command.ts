import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySsoList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type LegacySsoListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySsoListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all SSO identity providers for a project."),
  Command.withShortDescription("List all SSO identity providers"),
  Command.withExamples([
    {
      command: "supabase sso list --project-ref mwjylndxudmiehsxhmmz",
      description: "List all SSO providers for a project",
    },
  ]),
  Command.withHandler((flags) =>
    legacySsoList(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["sso", "list"])),
);
