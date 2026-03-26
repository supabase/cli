import { projectConfigStoreLayer } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { init } from "./init.handler.ts";

export const initCommand = Command.make("init").pipe(
  Command.withDescription(
    "Initialize a local Supabase project.\n\nCreates supabase/config.json with a minimal $schema reference so editor autocomplete works immediately.",
  ),
  Command.withShortDescription("Initialize local Supabase project"),
  Command.withExamples([
    {
      command: "supabase init",
      description: "Create a minimal supabase/config.json in the current directory",
    },
  ]),
  Command.withHandler(() => init().pipe(Effect.withSpan("command.init"), withJsonErrorHandling)),
  Command.provide(
    Layer.mergeAll(
      BunServices.layer,
      projectConfigStoreLayer.pipe(Layer.provide(BunServices.layer)),
    ),
  ),
);
