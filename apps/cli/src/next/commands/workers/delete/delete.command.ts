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
import { workersDelete } from "./delete.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Worker to delete. Inferred when run from inside its directory."),
    Argument.optional,
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Skip the confirmation prompt."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const workersDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a worker from the linked Supabase project. Irreversible; its local directory and supabase/config.toml entry are kept.",
  ),
  Command.withShortDescription("Delete a worker from Supabase"),
  Command.withExamples([
    {
      command: "supabase workers delete api",
      description: "Delete a worker, confirming by typing its name",
    },
    {
      command: "supabase workers delete api --yes",
      description: "Skip the confirmation prompt (scripts and CI)",
    },
  ]),
  Command.withHandler((flags) =>
    workersDelete(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(
    Layer.mergeAll(
      platformApiLayer.pipe(Layer.provide(credentialsLayer)),
      projectLinkStateLayer,
      commandRuntimeLayer(["workers", "delete"]),
    ),
  ),
  Command.provide(BunServices.layer),
);
