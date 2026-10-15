import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsDeploy } from "./deploy.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  functionNames: Argument.String("Function name").pipe(
    Argument.withDescription("Names of Functions to deploy. Deploys all if omitted."),
    Argument.variadic(),
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  noVerifyJwt: Flag.Boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for the Function."),
    Flag.withDefault(false),
  ),
  useApi: Flag.Boolean("use-api").pipe(
    Flag.withDescription("Bundle functions server-side without using Docker."),
    Flag.withDefault(false),
  ),
  importMap: Flag.String("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  prune: Flag.Boolean("prune").pipe(
    Flag.withDescription("Delete Functions that exist in Supabase project but not locally."),
    Flag.withDefault(false),
  ),
  jobs: Flag.Int("jobs").pipe(
    Flag.withAlias("j"),
    Flag.filter(
      (jobs) => jobs >= 0,
      (jobs) => `Expected --jobs to be non-negative, got ${jobs}`,
    ),
    Flag.withDescription("Maximum number of parallel jobs."),
    Flag.optional,
  ),
  useDocker: Flag.Boolean("use-docker").pipe(
    Flag.withDescription("Use Docker to bundle functions locally."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  legacyBundle: Flag.Boolean("legacy-bundle").pipe(
    Flag.withDescription("Use legacy bundling."),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
} as const;

export type FunctionsDeployFlags = CliCommand.Command.Config.Infer<typeof config>;

export const functionsDeployCommand = Command.make("deploy", config).pipe(
  Command.withDescription("Deploy a Function to the linked Supabase project."),
  Command.withShortDescription("Deploy a Function to Supabase"),
  Command.withExamples([
    {
      command: "supabase functions deploy hello-world",
      description: "Deploy a single function to the linked project",
    },
    {
      command: "supabase functions deploy --project-ref abcdefghijklmnopqrst",
      description: "Deploy all local functions to a specific project",
    },
  ]),
  Command.withHandler((flags) =>
    functionsDeploy(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["functions", "deploy"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
