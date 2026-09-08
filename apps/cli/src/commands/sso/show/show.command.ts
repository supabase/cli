import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoShow } from "./show.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  metadata: Flag.boolean("metadata").pipe(
    Flag.withDescription("Show SAML 2.0 XML Metadata only"),
    Flag.withDefault(false),
  ),
  providerId: Argument.string("provider-id").pipe(
    Argument.withDescription("The ID of the SSO identity provider to show."),
  ),
};
export type SsoShowFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoShowCommand = Command.make("show", config).pipe(
  Command.withDescription(
    "Provides the information about an established connection to an identity provider. You can use --metadata to obtain the raw SAML 2.0 Metadata XML document stored in your project's configuration.",
  ),
  Command.withShortDescription("Show information about an SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso show b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz",
      description: "Show SSO provider details",
    },
  ]),
  Command.withHandler((flags) =>
    ssoShow(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "show"])),
);
