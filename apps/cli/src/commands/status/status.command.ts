import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { status } from "./status.handler.ts";

const flags = {} as const;

export type StatusFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const statusCommand = Command.make("status", flags).pipe(
  Command.withDescription("Show status of local Supabase stacks."),
  Command.withShortDescription("Show local stack status"),
  Command.withHandler((flags) =>
    status(flags).pipe(Effect.withSpan("command.status"), withJsonErrorHandling),
  ),
);
