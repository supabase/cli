import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import { unlink } from "./unlink.handler.ts";

const unlinkRuntimeLayer = Layer.mergeAll(projectLinkStateLayer, commandRuntimeLayer(["unlink"]));

export const unlinkCommand = Command.make("unlink").pipe(
  Command.withDescription(
    "Unlink the current local Supabase project.\n\n" +
      "Removes the cached remote project link metadata for this checkout from SUPABASE_HOME.",
  ),
  Command.withShortDescription("Unlink local project from Supabase"),
  Command.withHandler(() => unlink().pipe(withCommandInstrumentation(), withJsonErrorHandling)),
  Command.provide(unlinkRuntimeLayer),
);
