import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { logs } from "./logs.handler.ts";

const flags = {} as const;

export type LogsFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const logsCommand = Command.make("logs", flags).pipe(
  Command.withDescription("Stream logs from the local Supabase stack."),
  Command.withShortDescription("Stream local stack logs"),
  Command.withHandler((flags) =>
    logs(flags).pipe(Effect.withSpan("command.logs"), withJsonErrorHandling),
  ),
);
