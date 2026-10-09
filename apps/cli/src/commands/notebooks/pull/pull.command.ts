import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { notebooksProjectRefSafeFlags } from "../notebooks.shared.ts";
import { notebooksPull } from "./pull.handler.ts";

const config = {
  notebookId: Argument.String("Notebook id").pipe(
    Argument.withDescription(
      "UUID of the notebook to replace locally. Pulls only locally missing notebooks if omitted.",
    ),
    Argument.optional,
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type NotebooksPullFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const notebooksPullHandler = (flags: NotebooksPullFlags) =>
  notebooksPull(flags).pipe(
    withCommandTelemetry({ flags, safeFlags: notebooksProjectRefSafeFlags }),
    withJsonErrorHandling,
  );

export const notebooksPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Write the linked Supabase project's notebooks into supabase/notebooks. Without a notebook id, existing local files are preserved and only missing notebooks are written.",
  ),
  Command.withShortDescription("Pull notebooks from Supabase"),
  Command.withExamples([
    {
      command: "supabase notebooks pull",
      description: "Pull every notebook from the linked project",
    },
    {
      command: "supabase notebooks pull 44444444-4444-4444-8444-444444444444",
      description: "Replace the local copy of one notebook by id",
    },
  ]),
  Command.withHandler(notebooksPullHandler),
  Command.provide(managementApiRuntimeLayer(["notebooks", "pull"])),
);
