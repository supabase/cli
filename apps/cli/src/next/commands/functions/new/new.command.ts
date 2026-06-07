import { BunServices } from "@effect/platform-bun";
import { Argument, Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { functionsNew } from "./new.handler.ts";

const args = {
  slug: Argument.string("slug").pipe(
    Argument.withDescription("Edge Function slug to create."),
    Argument.optional,
  ),
} as const;

export const functionsNewCommand = Command.make("new", args).pipe(
  Command.withDescription("Create a new Edge Function locally."),
  Command.withShortDescription("Create a new Edge Function locally"),
  Command.withExamples([
    {
      command: "supabase functions new hello-world",
      description: "Create supabase/functions/hello-world",
    },
  ]),
  Command.withHandler(({ slug }) =>
    functionsNew(slug).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["functions", "new"])),
  Command.provide(BunServices.layer),
);
