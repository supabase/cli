import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsDeploy } from "./deploy.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  functionNames: cliArgument("Function name", repeated(Argument.String), {
    description: "Names of the functions to deploy; deploys all when omitted.",
  }),
  ...projectTargetFlags(),
  noVerifyJwt: cliFlag("no-verify-jwt", Flag.Boolean, {
    description: "Disable JWT verification for the function.",
    default: false,
  }),
  useApi: cliFlag("use-api", Flag.Boolean, {
    description: "Bundle functions server-side without using Docker.",
    default: false,
  }),
  importMap: cliFlag("import-map", Flag.String, {
    description: "Path to an import map file.",
    optional: true,
  }),
  prune: cliFlag("prune", Flag.Boolean, {
    description: "Delete functions that exist in the project but not locally.",
    default: false,
  }),
  jobs: cliFlag("jobs", Flag.Int, {
    description: "Maximum number of parallel jobs.",
    alias: "j",
    parse: Flag.filter(
      (jobs) => jobs >= 0,
      (jobs) => `Expected --jobs to be non-negative, got ${jobs}`,
    ),
    optional: true,
    docs: { default: "1" },
  }),
  useDocker: cliFlag("use-docker", Flag.Boolean, {
    description: "Bundle functions locally using Docker.",
    default: true,
    hidden: true,
  }),
  legacyBundle: cliFlag("legacy-bundle", Flag.Boolean, {
    description: "Use legacy bundling.",
    default: false,
    hidden: true,
  }),
} as const;

export type FunctionsDeployFlags = CliCommand.Command.Config.Infer<typeof config>;

const dockerPath = [
  { flag: "use-api", is: false },
  { flag: "use-docker", is: true },
] as const;

export const functionsDeployCommand = makeCommand("deploy", config).pipe(
  Command.withDescription(
    "Deploy local Edge Functions to the linked project. Deploys every function in `supabase/functions` unless you name specific ones.\n\nWith `--prune`, functions that exist in the project but not locally are deleted. Asks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Deploy Edge Functions to a project"),
  Command.withExamples([
    {
      command: "supabase functions deploy hello-world",
      description: "Deploy a single function to the linked project",
    },
    {
      command: "supabase functions deploy --remote=abcdefghijklmnopqrst",
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
              "on the API path (--use-api, --use-docker=false, or Docker not running), when an enabled function has no verify_jwt in the config file",
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
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    functionsDeploy(flags).pipe(
      withCommandTelemetry({
        flags,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["functions", "deploy"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
