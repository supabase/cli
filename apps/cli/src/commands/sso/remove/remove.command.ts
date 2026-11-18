import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { upgradeSuggestion } from "../../../command-internal/upgrade-suggest.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoRemove } from "./remove.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  providerId: cliArgument("provider-id", Argument.String, {
    description: "The ID of the SSO identity provider to remove.",
    required: true,
  }),
};
export type SsoRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoRemoveCommand = makeCommand("remove", config).pipe(
  Command.withDescription(
    "Disconnects an identity provider from your project. Existing users of that provider can no longer sign in, so use it with care.",
  ),
  Command.withShortDescription("Remove an existing SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --remote=mwjylndxudmiehsxhmmz",
      description: "Remove an SSO provider by ID",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-delete-a-sso-provider", kind: "required" }] },
      upgradeSuggestion,
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    ssoRemove(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "remove"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
