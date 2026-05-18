import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacyFunctionsDeploy } from "./deploy.handler.ts";

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
  jobs: Flag.integer("jobs").pipe(
    Flag.withAlias("j"),
    Flag.withDescription("Maximum number of parallel jobs."),
    Flag.optional,
  ),
  importMap: Flag.string("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  prune: Flag.boolean("prune").pipe(
    Flag.withDescription("Delete Functions that exist in Supabase project but not locally."),
  ),
} as const;

export const legacyFunctionsDeployCommand = Command.make("deploy", config).pipe(
  Command.withDescription("Deploy a Function to the linked Supabase project."),
  Command.withShortDescription("Deploy a Function to Supabase"),
  Command.withHandler((flags) =>
    legacyFunctionsDeploy({
      functionNames: flags.functionNames.map(String),
      projectRef: flags.projectRef,
      noVerifyJwt: flags.noVerifyJwt,
      useApi: flags.useApi,
      jobs: flags.jobs,
      importMap: flags.importMap,
      prune: flags.prune,
    }),
  ),
);
