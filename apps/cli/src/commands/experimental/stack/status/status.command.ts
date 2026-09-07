import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackStatus } from "./status.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(Flag.withDescription("Inspect a named stack."), Flag.optional),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Inspect an existing stack by id."),
    Flag.optional,
  ),
} as const;

export type LegacyExperimentalStackStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyExperimentalStackStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show the state of a managed local Supabase stack."),
  Command.withShortDescription("Show stack status"),
  Command.withHandler((flags) =>
    legacyExperimentalStackStatus(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
