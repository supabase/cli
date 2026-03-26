import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { projectCommandBaseLayer } from "../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
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
  Command.withHandler(() =>
    list().pipe(Effect.withSpan("command.stack.list"), withJsonErrorHandling),
  ),
  Command.provide(projectCommandBaseLayer),
);
