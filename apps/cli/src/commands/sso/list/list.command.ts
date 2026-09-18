import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type SsoListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all SSO identity providers for a project."),
  Command.withShortDescription("List all SSO identity providers"),
  Command.withExamples([
    {
      command: "supabase sso list --project-ref mwjylndxudmiehsxhmmz",
      description: "List all SSO providers for a project",
    },
  ]),
  Command.withHandler((flags) =>
    ssoList(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "list"])),
);
