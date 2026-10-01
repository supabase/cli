import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackLogs } from "./logs.handler.ts";

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
      "Read one service kind, instance ID, or gateway (shared API requests); repeat to select several. Defaults to composition members and gateway.",
    ),
    Flag.atLeast(0),
  ),
  follow: Flag.boolean("follow").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(
      "After the history, keep streaming new lines until interrupted; requires a running stack.",
    ),
    Flag.withDefault(false),
  ),
  tail: Flag.integer("tail").pipe(
    Flag.filter(
      (tail) => tail >= 0,
      (tail) => `Expected --tail to be 0 or more, got ${tail}`,
    ),
    Flag.withDescription(
      "Number of retained lines to print across the selected services (default 200); 0 prints none.",
    ),
    Flag.withDefault(200),
  ),
  since: Flag.string("since").pipe(
    Flag.withDescription(
      "Only print lines since a duration ago (10m, 1h30m), an ISO-8601 time, or start for each service's latest launch.",
    ),
    Flag.optional,
  ),
} as const;

export type StackLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription(
    "Print retained service logs and exit; with --follow, keep streaming new lines. History is readable while the stack is stopped.",
  ),
  Command.withShortDescription("Show managed local stack logs"),
  Command.withExamples([
    {
      command: "supabase stack logs --service database --since 10m",
      description: "Print database lines from the last ten minutes",
    },
    {
      command: "supabase stack logs -f --tail 0",
      description: "Stream only new lines until interrupted",
    },
    {
      command: "supabase stack logs --follow --output-format stream-json",
      description: "Stream history and new lines as structured events",
    },
  ]),
  Command.withHandler((flags) =>
    stackLogs(flags).pipe(
      withCommandTelemetry({ flags, config, aliases: { f: "follow" } }),
      withJsonErrorHandling,
    ),
  ),
);
