import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackRestart } from "./restart.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(Flag.withDescription("Restart a named stack."), Flag.optional),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Restart an existing stack by id."),
    Flag.optional,
  ),
} as const;

export type LegacyExperimentalStackRestartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyExperimentalStackRestartCommand = Command.make("restart", config).pipe(
  Command.withDescription("Restart an existing managed local Supabase stack."),
  Command.withShortDescription("Restart a managed local stack"),
  Command.withHandler((flags) =>
    legacyExperimentalStackRestart(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
