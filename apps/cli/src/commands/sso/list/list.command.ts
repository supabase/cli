import { Command } from "effect/cli";
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
import { ssoList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
};
export type SsoListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all SSO identity providers for a project."),
  Command.withShortDescription("List all SSO identity providers"),
  Command.withExamples([
    {
      command: "supabase sso list --remote=mwjylndxudmiehsxhmmz",
      description: "List all SSO providers for a project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-sso-provider", kind: "required" }] },
      upgradeSuggestion,
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    ssoList(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: projectRefSafeFlags(flags) }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
