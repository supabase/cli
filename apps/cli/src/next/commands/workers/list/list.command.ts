import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { workersList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const workersListCommand = Command.make("list", config).pipe(
  Command.withDescription(
    "List this project's workers, deployed or not — the union of supabase/config.toml's entries and what the Workers API reports.",
  ),
  Command.withShortDescription("List this project's workers"),
  Command.withExamples([
    {
      command: "supabase workers list",
      description: "See every worker in the linked project",
    },
  ]),
  Command.withHandler((flags) =>
    workersList(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(
    Layer.mergeAll(
      platformApiLayer.pipe(Layer.provide(credentialsLayer)),
      projectLinkStateLayer,
      commandRuntimeLayer(["workers", "list"]),
    ),
  ),
  Command.provide(BunServices.layer),
);
