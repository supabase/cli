import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withKind } from "../../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../../telemetry/linked-project-cache.layer.ts";
import { computeRead } from "../../../../shared/compute/compute-api.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computeDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../../command-internal/target/target-flags.ts";

// No local `--yes`: it is a root persistent flag every other confirming command
// reads through `resolveYes`, so redeclaring it here would shadow the
// global, list `--yes` twice in `--help`, and quietly ignore `SUPABASE_YES`.
const config = {
  name: Argument.String("name").pipe(Argument.withDescription("Compute to delete.")),
  ...projectTargetFlags(),
} as const;

export type ComputeDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computeDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a compute from the linked Supabase project. Irreversible; its local directory and supabase/config.toml entry are kept.",
  ),
  Command.withShortDescription("Delete a compute from Supabase"),
  Command.withExamples([
    {
      command: "supabase compute delete api",
      description: "Delete a compute, confirming by typing its name",
    },
    {
      command: "supabase compute delete api --yes",
      description: "Skip the confirmation prompt (scripts and CI)",
    },
  ]),
  withPermissions(
    compose(
      withKind(computeRead, "best-effort"),
      { operations: [{ operationId: "v2-delete-a-compute-instance", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    computeDelete(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "delete"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
