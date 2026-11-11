import { V1CreateAProjectInput } from "@supabase/api/effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withDocs } from "../../../docs/command-docs.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withContext,
} from "../../../command-internal/command-permissions/model.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { organizationPicker } from "../../../command-internal/organization-picker.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsCreate } from "./create.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

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
  name: cliArgument("name", Argument.String, {
    description: "Name of the project to create.",
    optional: true,
  }),
  orgId: cliFlag("org-id", Flag.String, {
    description: "Organization ID to create the project in.",
    optional: true,
  }),
  dbPassword: cliFlag("db-password", Flag.String, {
    description: "Database password for the project.",
    optional: true,
  }),
  region: cliFlag("region", (name) => Flag.Literals(name, AWS_REGIONS), {
    description: "Region to host the project in, ideally close to your users.",
    optional: true,
  }),
  size: cliFlag("size", (name) => Flag.Literals(name, INSTANCE_SIZES), {
    description: "Instance size of the project.",
    optional: true,
  }),
  highAvailability: cliFlag("high-availability", Flag.Boolean, {
    description: "Enable high availability for the project.",
    optional: true,
  }),
  // Hidden and `--experimental`-gated: the upstream OpenAPI spec marks these fields deprecated
  // even though the API accepts them, restored via `packages/api/scripts/openapi-overrides.json`.
  releaseChannel: cliFlag("release-channel", (name) => Flag.Literals(name, RELEASE_CHANNELS), {
    description: "Release channel of the project.",
    optional: true,
    hidden: true,
  }),
  postgresEngine: cliFlag("postgres-engine", (name) => Flag.Literals(name, POSTGRES_ENGINES), {
    description: "Postgres engine of the project.",
    optional: true,
    hidden: true,
  }),
  interactive: cliFlag("interactive", Flag.Boolean, {
    description: "Prompt for missing values in an interactive terminal.",
    alias: "i",
    optional: true,
    hidden: true,
  }),
  plan: cliFlag("plan", Flag.String, {
    description: "Plan to create the project on.",
    optional: true,
    hidden: true,
  }),
};
// `--interactive` is read as `interactive ?? true`: absent and `true` can prompt, `false` cannot;
// an optional boolean can't be tested with `is`, so the present entry names the value in its context.
const interactivePicker = withContext(
  organizationPicker,
  "an interactive terminal (stdin TTY and text output)",
);

export type ProjectsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsCreateCommand = makeCommand("create", config).pipe(
  Command.withDescription(
    "Create a new Supabase project in an organization.\n\nIn an interactive terminal the command prompts for missing values. Without one, you must pass the project name, `--org-id`, `--db-password` and `--region`.",
  ),
  Command.withShortDescription("Create a project"),
  withDocs({ category: "projects" }),
  Command.withExamples([
    {
      command:
        "supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1",
      description: "Create a new project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-create-a-project", kind: "required" }],
        noApiEffectFlags: [
          "db-password",
          "region",
          "size",
          "high-availability",
          "release-channel",
          "postgres-engine",
          "plan",
        ],
      },
      withCondition(interactivePicker, { flag: "interactive", present: false }),
      withCondition(withContext(interactivePicker, "--interactive is true, not false"), {
        flag: "interactive",
        present: true,
      }),
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    projectsCreate(flags).pipe(
      // `high-availability` is omitted from `safeFlags` since boolean flags are always logged
      // verbatim regardless of that list. `config` auto-detects `region`/`size`/`release-channel`/
      // `postgres-engine` as safe since they're `Flag.Literals`.
      withCommandTelemetry({ flags, safeFlags: ["org-id"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "create"])),
  withTargetPolicy({ group: "account", consent: "yes" }),
);
