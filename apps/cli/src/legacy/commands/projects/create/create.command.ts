import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyProjectsCreate } from "./create.handler.ts";

const AWS_REGIONS = [
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

const INSTANCE_SIZES = [
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "xlarge",
  "2xlarge",
  "4xlarge",
  "8xlarge",
  "12xlarge",
  "16xlarge",
  "24xlarge",
  "24xlarge_high_memory",
  "24xlarge_optimized_cpu",
  "24xlarge_optimized_memory",
  "48xlarge",
  "48xlarge_high_memory",
  "48xlarge_optimized_cpu",
  "48xlarge_optimized_memory",
] as const;

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Name of the project to create."),
    Argument.optional,
  ),
  orgId: Flag.string("org-id").pipe(
    Flag.withDescription("Organization ID to create the project in."),
    Flag.optional,
  ),
  dbPassword: Flag.string("db-password").pipe(
    Flag.withDescription("Database password of the project."),
    Flag.optional,
  ),
  region: Flag.choice("region", AWS_REGIONS).pipe(
    Flag.withDescription("Select a region close to you for the best performance."),
    Flag.optional,
  ),
  size: Flag.choice("size", INSTANCE_SIZES).pipe(
    Flag.withDescription("Select a desired instance size for your project."),
    Flag.optional,
  ),
  interactive: Flag.boolean("interactive").pipe(
    Flag.withDescription("Enables interactive mode."),
    Flag.withAlias("i"),
    Flag.optional,
    Flag.withHidden,
  ),
  plan: Flag.string("plan").pipe(
    Flag.withDescription("Select a plan that suits your needs."),
    Flag.optional,
    Flag.withHidden,
  ),
};
export type LegacyProjectsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyProjectsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create a project on Supabase."),
  Command.withShortDescription("Create a project"),
  Command.withExamples([
    {
      command:
        "supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1",
      description: "Create a new project",
    },
  ]),
  Command.withHandler((flags) => legacyProjectsCreate(flags)),
);
