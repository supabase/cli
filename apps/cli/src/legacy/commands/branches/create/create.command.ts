import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyBranchesCreate } from "./create.handler.ts";

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
  "nano",
  "small",
  "xlarge",
] as const;

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Name for the new branch."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  region: Flag.choice("region", BRANCH_REGIONS).pipe(
    Flag.withDescription("Select a region to deploy the branch database."),
    Flag.optional,
  ),
  size: Flag.choice("size", BRANCH_SIZES).pipe(
    Flag.withDescription("Select a desired instance size for the branch database."),
    Flag.optional,
  ),
  persistent: Flag.boolean("persistent").pipe(
    Flag.withDescription("Whether to create a persistent branch."),
  ),
  withData: Flag.boolean("with-data").pipe(
    Flag.withDescription("Whether to clone production data to the branch database."),
  ),
  notifyUrl: Flag.string("notify-url").pipe(
    Flag.withDescription("URL to notify when branch is active healthy."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create a preview branch for the linked project."),
  Command.withShortDescription("Create a preview branch"),
  Command.withHandler((flags) => legacyBranchesCreate(flags)),
);
