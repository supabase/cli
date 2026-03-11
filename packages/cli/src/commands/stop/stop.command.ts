import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { stop } from "./stop.handler.ts";

const flags = {} as const;

export type StopFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const stopCommand = Command.make("stop", flags).pipe(
  Command.withDescription("Stop the local Supabase development stack."),
  Command.withShortDescription("Stop local Supabase stack"),
  Command.withHandler((flags) =>
    stop(flags).pipe(Effect.withSpan("command.stop"), withJsonErrorHandling),
  ),
);
