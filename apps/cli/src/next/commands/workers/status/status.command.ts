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
import { workersStatus } from "./status.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Worker to inspect. Inferred when run from inside its directory."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const workersStatusCommand = Command.make("status", config).pipe(
  Command.withDescription(
    "Show one worker in detail: build state, size, access, image, live instance tally and source directory.",
  ),
  Command.withShortDescription("Show a worker in detail"),
  Command.withExamples([
    {
      command: "supabase workers status api",
      description: "Inspect a specific worker",
    },
    {
      command: "supabase workers status",
      description: "Inspect the worker whose directory you are inside",
    },
  ]),
  Command.withHandler((flags) =>
    workersStatus(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(
    Layer.mergeAll(
      platformApiLayer.pipe(Layer.provide(credentialsLayer)),
      projectLinkStateLayer,
      commandRuntimeLayer(["workers", "status"]),
    ),
  ),
  Command.provide(BunServices.layer),
);
