import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { functionsDeploy } from "./deploy.handler.ts";

const config = {
  functionNames: Argument.string("Function name").pipe(
    Argument.withDescription("Names of Functions to deploy. Deploys all if omitted."),
    Argument.variadic(),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  noVerifyJwt: Flag.boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for the Function."),
  ),
  useApi: Flag.boolean("use-api").pipe(
    Flag.withDescription("Bundle functions server-side without using Docker."),
  ),
  importMap: Flag.string("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  prune: Flag.boolean("prune").pipe(
    Flag.withDescription("Delete Functions that exist in Supabase project but not locally."),
  ),
  yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip the confirmation prompt.")),
  jobs: Flag.integer("jobs").pipe(
    Flag.withAlias("j"),
    Flag.filter(
      (jobs) => jobs >= 0,
      (jobs) => `Expected --jobs to be non-negative, got ${jobs}`,
    ),
    Flag.withDescription("Maximum number of parallel jobs."),
    Flag.optional,
  ),
  useDocker: Flag.boolean("use-docker").pipe(
    Flag.withDescription("Use Docker to bundle functions."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
  legacyBundle: Flag.boolean("legacy-bundle").pipe(
    Flag.withDescription("Use legacy bundling mechanism."),
    Flag.withHidden,
  ),
} as const;

export type FunctionsDeployFlags = CliCommand.Command.Config.Infer<typeof config>;

const functionsDeployCommandRuntimeLayer = commandRuntimeLayer(["functions", "deploy"]);
const functionsDeployPlatformApiLayer = platformApiLayer.pipe(
  Layer.provide(Layer.mergeAll(credentialsLayer, functionsDeployCommandRuntimeLayer)),
);

const functionsDeployRuntimeLayer = Layer.mergeAll(
  BunServices.layer,
  functionsDeployPlatformApiLayer,
  projectLinkStateLayer,
  functionsDeployCommandRuntimeLayer,
);

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
    functionsDeploy(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(functionsDeployRuntimeLayer),
);
