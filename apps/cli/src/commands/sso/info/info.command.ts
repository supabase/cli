import { Command } from "effect/cli";
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
import { ssoInfo } from "./info.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
};
export type SsoInfoFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoInfoCommand = Command.make("info", config).pipe(
  Command.withDescription(
    "Returns all of the important SSO information necessary for your project to be registered with a SAML 2.0 compatible identity provider.",
  ),
  Command.withShortDescription("Returns the SAML SSO settings required for the identity provider"),
  Command.withExamples([
    {
      command: "supabase sso info --remote=mwjylndxudmiehsxhmmz",
      description: "Get SSO info for a project",
    },
  ]),
  withPermissions(
    compose({ operations: [] }, projectRefPicker, linkedProjectCache, branchResolution),
  ),
  Command.withHandler((flags) =>
    ssoInfo(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: projectRefSafeFlags(flags.projectRef) }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "info"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
