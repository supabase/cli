import { DEFAULT_MANAGED_STACK_NAME } from "@supabase/stack/effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import { stop } from "./stop.handler.ts";

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
  noBackup: Flag.boolean("no-backup").pipe(
    Flag.withDescription("Delete the local persisted stack data after stopping."),
    Flag.withDefault(false),
  ),
} as const;

export type StopFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const stopCommand = Command.make("stop", flags).pipe(
  Command.withDescription(
    "Stop the local Supabase development stack.\n\nUse --no-backup to delete the persisted data for the selected stack under .supabase/stacks/<name>/ after stopping.",
  ),
  Command.withShortDescription("Stop local Supabase stack"),
  Command.withHandler((flags) =>
    stop(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["stop"])),
);
