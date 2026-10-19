import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { upgradeSuggestion } from "../../../command-internal/upgrade-suggest.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { branchesCreate } from "./create.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefSafeFlags } from "../../../command-internal/target/project-ref-safe-flags.ts";
import { branchesParentTarget } from "../branches.target.ts";

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
  name: Argument.String("name").pipe(
    Argument.withDescription("Name for the new branch."),
    Argument.optional,
  ),
  ...projectTargetFlags(),
  region: Flag.Literals("region", BRANCH_REGIONS).pipe(
    Flag.withDescription("Select a region to deploy the branch database."),
    Flag.optional,
  ),
  size: Flag.Literals("size", BRANCH_SIZES).pipe(
    Flag.withDescription("Select a desired instance size for the branch database."),
    Flag.optional,
  ),
  // Optional so the handler can distinguish "flag explicitly set false" from "flag absent":
  // `--persistent`/`--no-persistent` set `Option.some(true|false)`; absent stays `Option.none()`.
  persistent: Flag.Boolean("persistent").pipe(
    Flag.withDescription("Whether to create a persistent branch."),
    Flag.optional,
  ),
  withData: Flag.Boolean("with-data").pipe(
    Flag.withDescription("Whether to clone production data to the branch database."),
    Flag.optional,
  ),
  notifyUrl: Flag.String("notify-url").pipe(
    Flag.withDescription("URL to notify when branch is active healthy."),
    Flag.optional,
  ),
  gitBranch: Flag.String("git-branch").pipe(
    Flag.withDescription("Associate a git branch with the new preview branch."),
    Flag.optional,
  ),
} as const;

export type BranchesCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const branchesCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create a preview branch for the linked project."),
  Command.withShortDescription("Create a preview branch"),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-create-a-branch", kind: "required" }],
        noApiEffectFlags: ["region", "size", "persistent", "with-data", "notify-url", "git-branch"],
      },
      branchesParentTarget,
      projectRefPicker,
      upgradeSuggestion,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesCreate(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: projectRefSafeFlags(flags), config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "create"])),
  withTargetPolicy({ group: "hosted", consent: "yes" }),
);
