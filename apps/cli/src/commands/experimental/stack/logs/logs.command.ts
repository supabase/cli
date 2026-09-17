import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackLogs } from "./logs.handler.ts";

const MAX_TAIL = 1000;

const config = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription(
      "Select an existing stack by name (defaults to the current project stack).",
    ),
    Flag.optional,
  ),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Read logs from an existing stack by id."),
    Flag.optional,
  ),
  service: Flag.string("service").pipe(
    Flag.withDescription(
      "Limit logs to one stack service; omit this flag to include supervisor and gateway diagnostics.",
    ),
    Flag.optional,
  ),
  tail: Flag.integer("tail").pipe(
    Flag.filter(
      (value) => value >= 0 && value <= MAX_TAIL,
      (value) => `Expected --tail between 0 and ${MAX_TAIL}, got ${value}`,
    ),
    Flag.withDescription(
      "Number of retained log entries to print. Use 0 with --follow to skip retained history.",
    ),
    Flag.withDefault(100),
  ),
  follow: Flag.boolean("follow").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Continue printing new log entries until interrupted."),
    Flag.withDefault(false),
  ),
} as const;

export type StackLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription("Read logs from a managed local Supabase stack."),
  Command.withShortDescription("Read managed local stack logs"),
  Command.withExamples([
    {
      command: "supabase stack logs --service <instance-id> --tail 50",
      description: "Print the latest database logs",
    },
    {
      command: "supabase stack logs --follow --output-format stream-json",
      description: "Stream new stack logs as structured events",
    },
  ]),
  Command.withHandler((flags) =>
    stackLogs(flags).pipe(
      withCommandTelemetry({ flags, config, aliases: { f: "follow" } }),
      withJsonErrorHandling,
    ),
  ),
);
