import { Option } from "effect";
import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { PROJECT_REF_PATTERN } from "../../../config/project-ref.service.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";

const config = {
  ...projectTargetFlags(),
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
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    functionsList(flags).pipe(
      withCommandTelemetry({
        flags,
        safeFlags:
          Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
            ? FUNCTIONS_PROJECT_REF_SAFE_FLAGS
            : [],
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["functions", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
