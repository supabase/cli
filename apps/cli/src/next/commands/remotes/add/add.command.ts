import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { projectCommandBaseLayer } from "../../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { add } from "./add.handler.ts";

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Name for the remote.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref the remote targets."),
  ),
} as const;

export type RemotesAddFlags = CliCommand.Command.Config.Infer<typeof config>;

export const remotesAddCommand = Command.make("add", config).pipe(
  Command.withDescription(
    "Register a named remote Supabase project in supabase/config.toml. Idempotent when the name already targets the same ref.",
  ),
  Command.withShortDescription("Register a remote"),
  Command.withHandler((flags) =>
    add(flags).pipe(withCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["remotes", "add"])),
  Command.provide(projectCommandBaseLayer),
);
