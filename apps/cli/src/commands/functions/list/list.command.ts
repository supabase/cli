import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type FunctionsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const functionsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all Functions in the linked Supabase project."),
  Command.withShortDescription("List all Functions in Supabase"),
  Command.withExamples([
    {
      command: "supabase functions list",
      description: "List all deployed functions in the linked project",
    },
    {
      command: "supabase functions list --remote=abcdefghijklmnopqrst",
      description: "List all deployed functions in a specific project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-functions", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    functionsList(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["functions", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
