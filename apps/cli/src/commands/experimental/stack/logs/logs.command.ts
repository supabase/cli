import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackLogs } from "./logs.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand, repeated } from "../../../../shared/cli/cli-params.ts";

const config = {
  stack: cliFlag("stack", Flag.String, {
    description: "Select an existing stack by name (defaults to the current project stack).",
    optional: true,
  }),
  stackId: cliFlag("stack-id", Flag.String, {
    description: "Read logs from an existing stack by id or unique id prefix.",
    optional: true,
  }),
  service: cliFlag("service", repeated(Flag.String, { min: 0 }), {
    description:
      "Read one service kind, instance ID, or gateway (shared API requests); repeat to select several. Defaults to composition members and gateway.",
  }),
  follow: cliFlag("follow", Flag.Boolean, {
    description:
      "After the history, keep streaming new lines until interrupted; requires a running stack.",
    alias: "f",
    default: false,
  }),
  tail: cliFlag("tail", Flag.Int, {
    description:
      "Number of retained lines to print across the selected services (default 200); 0 prints none.",
    parse: Flag.filter(
      (tail) => tail >= 0,
      (tail) => `Expected --tail to be 0 or more, got ${tail}`,
    ),
    default: 200,
  }),
  since: cliFlag("since", Flag.String, {
    description:
      "Only print lines since a duration ago (10m, 1h30m), an ISO-8601 time, or start for each service's latest launch.",
    optional: true,
  }),
} as const;

export type StackLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackLogsCommand = makeCommand("logs", config).pipe(
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
  withPermissions({
    operations: [],
    noApiEffectFlags: ["stack", "stack-id", "service", "follow", "tail", "since"],
  }),
  Command.withHandler((flags) =>
    stackLogs(flags).pipe(
      withCommandTelemetry({ flags, config, aliases: { f: "follow" } }),
      withJsonErrorHandling,
    ),
  ),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
