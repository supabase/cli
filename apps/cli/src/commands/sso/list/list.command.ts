import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { upgradeSuggestion } from "../../../command-internal/upgrade-suggest.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { ssoList } from "./list.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
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
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-sso-provider", kind: "required" }] },
      upgradeSuggestion,
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    ssoList(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "list"])),
);
