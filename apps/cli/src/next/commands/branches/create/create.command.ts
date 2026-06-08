import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { create } from "./create.handler.ts";

const branchesPlatformApiLayer = platformApiLayer.pipe(Layer.provide(credentialsLayer));
const branchesRuntimeLayer = Layer.mergeAll(
  branchesPlatformApiLayer,
  projectLinkStateLayer,
  commandRuntimeLayer(["branches", "create"]),
);

const BRANCH_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-east-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-2",
  "ap-south-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-central-1",
  "eu-central-2",
  "ca-central-1",
  "sa-east-1",
] as const;

const BRANCH_SIZES = [
  "pico",
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
  "24xlarge_optimized_memory",
  "24xlarge_optimized_cpu",
  "24xlarge_high_memory",
  "48xlarge",
  "48xlarge_optimized_memory",
  "48xlarge_optimized_cpu",
  "48xlarge_high_memory",
] as const;

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription(
      "Name for the new branch. If omitted, the current git branch name is used.",
    ),
    Argument.optional,
  ),
  region: Flag.choice("region", BRANCH_REGIONS).pipe(
    Flag.withDescription("Region to deploy the branch database."),
    Flag.optional,
  ),
  size: Flag.choice("size", BRANCH_SIZES).pipe(
    Flag.withDescription("Instance size for the branch database."),
    Flag.optional,
  ),
  persistent: Flag.boolean("persistent").pipe(
    Flag.withDescription("Create a persistent branch (default: ephemeral)."),
  ),
  withData: Flag.boolean("with-data").pipe(
    Flag.withDescription("Clone production data to the branch database."),
  ),
  notifyUrl: Flag.string("notify-url").pipe(
    Flag.withDescription("HTTP endpoint to notify when the branch becomes active and healthy."),
    Flag.optional,
  ),
  gitBranch: Flag.string("git-branch").pipe(
    Flag.withDescription(
      "Git branch to associate with the new branch. Defaults to the current local git branch when the branch name is auto-detected.",
    ),
    Flag.optional,
  ),
  switchAfter: Flag.boolean("switch").pipe(
    Flag.withDescription("Switch to the new branch after creation. Pass --no-switch to skip."),
    Flag.withDefault(true),
  ),
} as const;

export type CreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const createBranchesCommand = Command.make("create", config).pipe(
  Command.withDescription(
    "Create a new branch from the linked project.\n\n" +
      "Requires the project to be linked (`supabase link`). " +
      "If no name is provided and you are in a git repository, the current branch name is used. " +
      "Use --switch to set the new branch as active immediately, or confirm the prompt in interactive mode.",
  ),
  Command.withShortDescription("Create a new branch for the linked project"),
  Command.withExamples([
    {
      command: "supabase branches create my-feature",
      description: "Create a branch named my-feature",
    },
    {
      command: "supabase branches create",
      description: "Create a branch using the current git branch name (interactive confirmation)",
    },
    {
      command: "supabase branches create my-feature --region us-east-1",
      description: "Create a branch in a specific region",
    },
    {
      command: "supabase branches create my-feature --with-data",
      description: "Create a branch and clone production data into it",
    },
    {
      command: "supabase branches create my-feature --git-branch feature/login-page",
      description: "Associate a specific git branch with the new branch",
    },
  ]),
  Command.withHandler((flags) =>
    create(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(branchesRuntimeLayer),
);
