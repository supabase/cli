import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoRemove } from "./remove.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  providerId: Argument.string("provider-id").pipe(
    Argument.withDescription("The ID of the SSO identity provider to remove."),
  ),
};
export type SsoRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription(
    "Remove a connection to an already added SSO identity provider. Removing the provider will prevent existing users from logging in. Please treat this command with care.",
  ),
  Command.withShortDescription("Remove an existing SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz",
      description: "Remove an SSO provider by ID",
    },
  ]),
  Command.withHandler((flags) =>
    ssoRemove(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "remove"])),
);
