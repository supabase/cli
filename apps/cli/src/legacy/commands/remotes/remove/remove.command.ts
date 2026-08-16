import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyRemotesRemove } from "./remove.handler.ts";
import { legacyRemotesRuntimeLayer } from "../remotes.layers.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name of the remote to remove.")),
} as const;

export type LegacyRemotesRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyRemotesRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription(
    "Remove a named remote from supabase/config.toml. Refuses when the block declares config beyond project_id.",
  ),
  Command.withShortDescription("Remove a remote"),
  Command.withHandler((flags) =>
    legacyRemotesRemove(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyRemotesRuntimeLayer(["remotes", "remove"])),
);
