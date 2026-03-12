import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { stop } from "./stop.handler.ts";

const flags = {
  noBackup: Flag.boolean("no-backup").pipe(
    Flag.withDescription("Delete the local persisted stack data after stopping."),
    Flag.withDefault(false),
  ),
} as const;

export type StopFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const stopCommand = Command.make("stop", flags).pipe(
  Command.withDescription(
    "Stop the local Supabase development stack.\n\nUse --no-backup to delete the persisted stack data under SUPABASE_HOME/stacks/<name>/ after stopping.",
  ),
  Command.withShortDescription("Stop local Supabase stack"),
  Command.withHandler((flags) =>
    stop(flags).pipe(Effect.withSpan("command.stop"), withJsonErrorHandling),
  ),
);
