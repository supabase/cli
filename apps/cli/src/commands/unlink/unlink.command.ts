import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { unlink } from "./unlink.handler.ts";

const unlinkRuntimeLayer = Layer.mergeAll(projectLinkStateLayer);

export const unlinkCommand = Command.make("unlink").pipe(
  Command.withDescription(
    "Unlink the current local Supabase project.\n\n" +
      "Removes the cached remote project link metadata for this checkout from SUPABASE_HOME.",
  ),
  Command.withShortDescription("Unlink local project from Supabase"),
  Command.withHandler(() =>
    unlink().pipe(Effect.withSpan("command.unlink"), withJsonErrorHandling),
  ),
  Command.provide(unlinkRuntimeLayer),
);
