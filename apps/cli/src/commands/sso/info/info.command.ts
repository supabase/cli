import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoInfo } from "./info.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type SsoInfoFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoInfoCommand = Command.make("info", config).pipe(
  Command.withDescription(
    "Returns all of the important SSO information necessary for your project to be registered with a SAML 2.0 compatible identity provider.",
  ),
  Command.withShortDescription("Returns the SAML SSO settings required for the identity provider"),
  Command.withExamples([
    {
      command: "supabase sso info --project-ref mwjylndxudmiehsxhmmz",
      description: "Get SSO info for a project",
    },
  ]),
  Command.withHandler((flags) =>
    ssoInfo(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "info"])),
);
