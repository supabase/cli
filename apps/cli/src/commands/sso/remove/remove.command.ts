import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectRefSafeFlags } from "../../../command-internal/target/project-ref-safe-flags.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { upgradeSuggestion } from "../../../command-internal/upgrade-suggest.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoRemove } from "./remove.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
  providerId: Argument.String("provider-id").pipe(
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
    ssoRemove(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: projectRefSafeFlags(flags) }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "remove"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
