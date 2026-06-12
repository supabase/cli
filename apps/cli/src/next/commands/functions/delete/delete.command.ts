import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { functionsDelete } from "./delete.handler.ts";

const config = {
  slug: Argument.string("slug").pipe(Argument.withDescription("Edge Function slug to delete.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type FunctionsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

const functionsDeleteRuntimeLayer = Layer.mergeAll(
  platformApiLayer.pipe(Layer.provide(credentialsLayer)),
  projectLinkStateLayer,
  commandRuntimeLayer(["functions", "delete"]),
);

export const functionsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
  ),
  Command.withShortDescription("Delete a Function from Supabase"),
  Command.withExamples([
    {
      command: "supabase functions delete hello-world",
      description: "Delete a deployed function from the linked project",
    },
    {
      command: "supabase functions delete hello-world --project-ref abcdefghijklmnopqrst",
      description: "Delete a deployed function from a specific project",
    },
  ]),
  Command.withHandler((flags) =>
    functionsDelete(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(functionsDeleteRuntimeLayer),
);
