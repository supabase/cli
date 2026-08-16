import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { projectCommandBaseLayer } from "../../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { remove } from "./remove.handler.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name of the remote to remove.")),
} as const;

export type RemotesRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const remotesRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription(
    "Remove a named remote from supabase/config.toml. Refuses when the block declares config beyond project_id.",
  ),
  Command.withShortDescription("Remove a remote"),
  Command.withHandler((flags) =>
    remove(flags).pipe(withCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["remotes", "remove"])),
  Command.provide(projectCommandBaseLayer),
);
