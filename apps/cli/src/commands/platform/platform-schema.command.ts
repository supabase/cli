import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { showPlatformSchema } from "./platform-schema.handler.ts";

const config = {
  method: Argument.string("method"),
};

export const platformSchemaCommand = Command.make("schema", config).pipe(
  Command.withDescription(
    "Inspect the generated request and response schema for a platform method. Derive the method name from the command path by dropping `platform` and replacing spaces with dots.",
  ),
  Command.withShortDescription("Show method schema"),
  Command.withExamples([
    {
      command: "supabase platform schema projects.create",
      description: "Show the request and response schema for project creation",
    },
    {
      command: "supabase platform projects create --help",
      description:
        "Inspect the command help, then use the matching projects.create schema identifier",
    },
  ]),
  Command.withHandler(({ method }) =>
    showPlatformSchema(method).pipe(
      Effect.withSpan("command.platform.schema"),
      withJsonErrorHandling,
    ),
  ),
);
