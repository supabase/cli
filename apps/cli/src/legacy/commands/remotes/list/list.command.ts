import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyRemotesList } from "./list.handler.ts";
import { legacyRemotesRuntimeLayer } from "../remotes.layers.ts";

export const legacyRemotesListCommand = Command.make("list").pipe(
  Command.withDescription("List named remote Supabase projects from supabase/config.toml."),
  Command.withShortDescription("List configured remotes"),
  Command.withHandler(() =>
    legacyRemotesList().pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacyRemotesRuntimeLayer(["remotes", "list"])),
);
