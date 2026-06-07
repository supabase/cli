import { Command } from "effect/unstable/cli";
import { projectCommandBaseLayer } from "../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { list } from "./list.handler.ts";

export const listCommand = Command.make("list").pipe(
  Command.withDescription("List all known local Supabase stacks for this project."),
  Command.withShortDescription("List local stacks for this project"),
  Command.withExamples([
    {
      command: "supabase stack list",
      description: "Show all known local stacks for the current project",
    },
  ]),
  Command.withHandler(() => list().pipe(withCommandInstrumentation(), withJsonErrorHandling)),
  Command.provide(commandRuntimeLayer(["stack", "list"])),
  Command.provide(projectCommandBaseLayer),
);
