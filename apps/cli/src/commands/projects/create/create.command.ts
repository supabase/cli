import { V1CreateAProjectInput } from "@supabase/api/effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsCreate } from "./create.handler.ts";

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

// Read from the generated schema so these choices track the `release_channel`/`postgres_engine`
// fields on regen.
const RELEASE_CHANNELS = V1CreateAProjectInput.fields.release_channel.schema.literals;
const POSTGRES_ENGINES = V1CreateAProjectInput.fields.postgres_engine.schema.literals;

const INSTANCE_SIZES = [
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
  highAvailability: Flag.boolean("high-availability").pipe(
    Flag.withDescription("Enable high availability for the project."),
    Flag.optional,
  ),
  // Hidden and `--experimental`-gated: the upstream OpenAPI spec marks these fields deprecated
  // even though the API accepts them, restored via `packages/api/scripts/openapi-overrides.json`.
  releaseChannel: Flag.choice("release-channel", RELEASE_CHANNELS).pipe(
    Flag.withDescription("Select a release channel for the project."),
    Flag.optional,
    Flag.withHidden,
  ),
  postgresEngine: Flag.choice("postgres-engine", POSTGRES_ENGINES).pipe(
    Flag.withDescription("Select the Postgres engine for the project."),
    Flag.optional,
    Flag.withHidden,
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
export type ProjectsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create a project on Supabase."),
  Command.withShortDescription("Create a project"),
  Command.withExamples([
    {
      command:
        "supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1",
      description: "Create a new project",
    },
  ]),
  Command.withHandler((flags) =>
    projectsCreate(flags).pipe(
      // `high-availability` is omitted from `safeFlags` since boolean flags are always logged
      // verbatim regardless of that list. `config` auto-detects `region`/`size`/`release-channel`/
      // `postgres-engine` as safe since they're `Flag.choice`.
      withCommandTelemetry({ flags, safeFlags: ["org-id"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "create"])),
);
