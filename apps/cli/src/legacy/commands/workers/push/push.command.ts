import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersPush } from "./push.handler.ts";

const config = {
  names: Argument.string("name").pipe(
    Argument.withDescription("Workers to deploy. Deploys every worker in the project if omitted."),
    Argument.variadic(),
  ),
  instances: Flag.integer("instances").pipe(
    Flag.withDescription("Number of instances to run."),
    Flag.withDefault(1),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyWorkersPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersPushCommand = Command.make("push", config).pipe(
  Command.withAlias("deploy"),
  Command.withDescription(
    "Build and deploy workers into the linked Supabase project. Reads each worker's runtime, size and source directory from supabase/config.toml.",
  ),
  Command.withShortDescription("Build and deploy workers"),
  Command.withExamples([
    {
      command: "supabase workers push",
      description: "Deploy every worker in the project",
    },
    {
      command: "supabase workers push api",
      description: "Deploy a single worker",
    },
    {
      command: "supabase workers push api web",
      description: "Deploy several workers by name",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersPush(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["workers", "push"])),
);
