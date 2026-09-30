import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { notebooksProjectRefSafeFlags } from "../notebooks.shared.ts";
import { notebooksPush } from "./push.handler.ts";

const config = {
  notebookName: Argument.string("Notebook name").pipe(
    Argument.withDescription("Name of the notebook to push. Pushes all if omitted."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type NotebooksPushFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const notebooksPushHandler = (flags: NotebooksPushFlags) =>
  notebooksPush(flags).pipe(
    withCommandTelemetry({ flags, safeFlags: notebooksProjectRefSafeFlags }),
    withJsonErrorHandling,
  );

export const notebooksPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Write supabase/notebooks into the linked Supabase project. If no notebook name is provided, pushes all of them and asks what to do about project notebooks the directory does not have.",
  ),
  Command.withShortDescription("Push notebooks to Supabase"),
  Command.withExamples([
    {
      command: "supabase notebooks push",
      description: "Push every notebook in supabase/notebooks to the linked project",
    },
    {
      command: "supabase notebooks push sales-dashboard",
      description: "Push a single notebook by name",
    },
  ]),
  Command.withHandler(notebooksPushHandler),
  Command.provide(managementApiRuntimeLayer(["notebooks", "push"])),
);
