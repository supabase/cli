import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoShow } from "./show.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  metadata: cliFlag("metadata", Flag.Boolean, {
    description: "Print only the SAML 2.0 Metadata XML.",
    default: false,
  }),
  providerId: cliArgument("provider-id", Argument.String, {
    description: "The ID of the SSO identity provider to show.",
    required: true,
  }),
};
export type SsoShowFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoShowCommand = makeCommand("show", config).pipe(
  Command.withDescription(
    "Shows the settings of a connected identity provider. Use `--metadata` to print the raw SAML 2.0 Metadata XML stored in your project instead.",
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
    ssoShow(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "show"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
