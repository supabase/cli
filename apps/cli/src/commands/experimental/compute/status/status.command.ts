import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../../telemetry/linked-project-cache.layer.ts";
import { computeRead } from "../../../../shared/compute/compute-api.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computeStatus } from "./status.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";

const config = {
  name: Argument.String("name").pipe(Argument.withDescription("Compute to inspect.")),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type ComputeStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computeStatusCommand = Command.make("status", config).pipe(
  Command.withDescription(
    "Show one compute in detail: build state, size, access, image, live instance tally and source directory.",
  ),
  Command.withShortDescription("Show a compute in detail"),
  Command.withExamples([
    {
      command: "supabase compute status api",
      description: "Inspect a specific compute",
    },
  ]),
  withPermissions(compose(computeRead, projectRefPicker, linkedProjectCache)),
  Command.withHandler((flags) =>
    computeStatus(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "status"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
