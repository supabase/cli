import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withContext,
} from "../../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../../telemetry/linked-project-cache.layer.ts";
import { computeRead } from "../../../../shared/compute/compute-api.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { COMPUTE_EXPOSURES } from "../../../../shared/compute/compute-runtimes.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computePush } from "./push.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../../command-internal/target/target-flags.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../../shared/cli/cli-params.ts";

const config = {
  names: cliArgument("name", repeated(Argument.String), {
    description: "Compute to deploy. Deploys every compute in the project if omitted.",
  }),
  instances: cliFlag("instances", Flag.Int, {
    description:
      "Number of instances to run, overriding `instances` in supabase/config.toml for this deploy. Falls back to the recorded value, then 1.",
    parse: Flag.filter(
      (instances) => instances >= 0,
      (instances) => `--instances ${instances} is negative; pass zero or more.`,
    ),
    optional: true,
  }),
  exposure: cliFlag("exposure", (name) => Flag.Literals(name, COMPUTE_EXPOSURES), {
    description:
      "Whether the compute is reachable from the internet, overriding `exposure` in supabase/config.toml for this deploy. Falls back to the recorded value, then public.",
    optional: true,
  }),
  noWait: cliFlag("no-wait", Flag.Boolean, {
    description:
      "Return once the deploy is accepted, without waiting for the server-side build to finish.",
    default: false,
  }),
  ...projectTargetFlags(),
} as const;

export type ComputePushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computePushCommand = makeCommand("push", config).pipe(
  Command.withAlias("deploy"),
  Command.withDescription(
    "Build and deploy compute into the linked Supabase project. Reads each compute's runtime, size, exposure and source directory from supabase/config.toml.",
  ),
  Command.withShortDescription("Build and deploy compute"),
  Command.withExamples([
    {
      command: "supabase compute push",
      description: "Deploy every compute in the project",
    },
    {
      command: "supabase compute push api",
      description: "Deploy a single compute",
    },
    {
      command: "supabase compute push api web",
      description: "Deploy several compute by name",
    },
    {
      command: "supabase compute push api --exposure private",
      description: "Deploy without an internet-facing URL",
    },
    {
      command: "supabase compute push api --no-wait",
      description: "Deploy without blocking on the build",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          { operationId: "v2-create-compute-instance-upload", kind: "required" },
          { operationId: "v2-deploy-a-compute-instance", kind: "required" },
        ],
        noApiEffectFlags: ["instances", "exposure"],
      },
      withContext(
        withCondition(computeRead, { flag: "no-wait", is: false }),
        "the deploy response reports the build as still building",
      ),
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    computePush(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "push"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
