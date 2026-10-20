import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { FUNCTIONS_PROJECT_REF_SAFE_FLAGS } from "../../../shared/functions/functions.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsDeploy } from "./deploy.handler.ts";

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

const dockerPath = [
  { flag: "use-api", is: false },
  { flag: "use-docker", is: true },
] as const;

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
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-deploy-a-function",
            kind: "required",
            when: [{ flag: "use-api", is: true }],
          },
          {
            operationId: "v1-deploy-a-function",
            kind: "required",
            when: [{ flag: "use-docker", is: false }],
          },
          {
            operationId: "v1-deploy-a-function",
            kind: "required",
            when: [...dockerPath],
            context: "Docker isn't running (deploy falls back to API bundling)",
          },
          {
            operationId: "v1-list-all-functions",
            kind: "required",
            when: [...dockerPath],
            context: "Docker is running",
          },
          {
            operationId: "v1-list-all-functions",
            kind: "required",
            when: [{ flag: "no-verify-jwt", is: false }],
            context:
              "on the API path (--use-api, --use-docker=false, or Docker not running), when an enabled function has no verify_jwt in config.toml",
          },
          {
            operationId: "v1-list-all-functions",
            kind: "required",
            when: [{ flag: "prune", is: true }],
          },
          {
            operationId: "v1-create-a-function",
            kind: "required",
            when: [...dockerPath],
            context:
              "Docker is running, a bundle differs from the deployed copy, and that function isn't deployed yet",
          },
          {
            operationId: "v1-update-a-function",
            kind: "required",
            when: [...dockerPath],
            context:
              "Docker is running, a bundle differs from the deployed copy, and that function is already deployed (or a create answered with a duplicated slug)",
          },
          {
            operationId: "v1-bulk-update-functions",
            kind: "required",
            context:
              "two or more functions change (API path: two or more enabled functions with at least one accepted upload; Docker path: two or more changed bundles)",
          },
          {
            operationId: "v1-delete-a-function",
            kind: "required",
            when: [{ flag: "prune", is: true }],
            context: "a deployed function has no local counterpart",
          },
        ],
        noApiEffectFlags: ["import-map", "jobs", "legacy-bundle"],
      },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    functionsDeploy(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: FUNCTIONS_PROJECT_REF_SAFE_FLAGS }),
      withJsonErrorHandling,
    ),
  ),
  // `stdinLayer`: the `--prune` confirmation reads piped stdin via `promptYesNo`
  // on a non-TTY stdin.
  Command.provide(Layer.mergeAll(managementApiRuntimeLayer(["functions", "deploy"]), stdinLayer)),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
);
