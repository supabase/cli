import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesCreate } from "./create.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const BRANCH_REGIONS = [
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
] as const;

const BRANCH_SIZES = [
  "large",
  "medium",
  "micro",
  "12xlarge",
  "16xlarge",
  "24xlarge",
  "24xlarge_high_memory",
  "24xlarge_optimized_cpu",
  "24xlarge_optimized_memory",
  "2xlarge",
  "48xlarge",
  "48xlarge_high_memory",
  "48xlarge_optimized_cpu",
  "48xlarge_optimized_memory",
  "4xlarge",
  "8xlarge",
  "small",
  "xlarge",
] as const;

const config = {
  name: cliArgument("name", Argument.String, {
    description: "Name for the new branch.",
    optional: true,
  }),
  ...projectTargetFlags({ parent: true }),
  region: cliFlag("region", (name) => Flag.Literals(name, BRANCH_REGIONS), {
    description: "Region to deploy the branch database in.",
    optional: true,
  }),
  size: cliFlag("size", (name) => Flag.Literals(name, BRANCH_SIZES), {
    description: "Instance size of the branch database.",
    optional: true,
  }),
  // Optional so the handler can distinguish "flag explicitly set false" from "flag absent":
  // `--persistent`/`--no-persistent` set `Option.some(true|false)`; absent stays `Option.none()`.
  persistent: cliFlag("persistent", Flag.Boolean, {
    description: "Create a persistent branch instead of an ephemeral one.",
    optional: true,
  }),
  withData: cliFlag("with-data", Flag.Boolean, {
    description: "Clone production data into the branch database.",
    optional: true,
  }),
  notifyUrl: cliFlag("notify-url", Flag.String, {
    description: "URL to notify when the branch is active and healthy.",
    optional: true,
  }),
  gitBranch: cliFlag("git-branch", Flag.String, {
    description: "Git branch to associate with the new preview branch.",
    optional: true,
  }),
} as const;

export type BranchesCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesCreateCommand = makeCommand("create", config).pipe(
  Command.withDescription(
    "Create a preview branch of the linked project, optionally tied to a git branch.\n\nPass `--with-data` to clone production data into the branch database.",
  ),
  Command.withShortDescription("Create a preview branch"),
  Command.withExamples([
    {
      command: "supabase branches create my-branch",
      description: "Create a preview branch",
    },
    {
      command: "supabase branches create my-branch --git-branch feature/login --persistent",
      description: "Create a persistent branch tied to a git branch",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          { operationId: "v1-create-a-branch", kind: "required" },
          {
            operationId: "v1-create-a-branch",
            kind: "required",
            when: [{ flag: "with-data" }],
            request: { body: { with_data: "true" } },
          },
        ],
        noApiEffectFlags: ["region", "size", "persistent", "notify-url", "git-branch"],
      },
      branchesParentTarget,
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesCreate(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "create"])),
  withTargetPolicy({ group: "hosted", consent: "yes" }),
);
