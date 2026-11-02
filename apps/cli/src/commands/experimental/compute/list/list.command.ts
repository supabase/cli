import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computeList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../../command-internal/target/target-flags.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type ComputeListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computeListCommand = Command.make("list", config).pipe(
  Command.withDescription(
    "List this project's compute, deployed or not: the union of supabase/config.toml's entries and what the Compute API reports.",
  ),
  Command.withShortDescription("List this project's compute"),
  Command.withExamples([
    {
      command: "supabase compute list",
      description: "See every compute in the linked project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v2-list-all-compute-instances", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    computeList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "list"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
