import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectRefSafeFlags } from "../../../command-internal/target/project-ref-safe-flags.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoShow } from "./show.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
  metadata: Flag.Boolean("metadata").pipe(
    Flag.withDescription("Show SAML 2.0 XML Metadata only"),
    Flag.withDefault(false),
  ),
  providerId: Argument.String("provider-id").pipe(
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
        "supabase sso show b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --remote=mwjylndxudmiehsxhmmz",
      description: "Show SSO provider details",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-get-a-sso-provider", kind: "required" }],
        noApiEffectFlags: ["metadata"],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    ssoShow(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: projectRefSafeFlags(flags) }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "show"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
