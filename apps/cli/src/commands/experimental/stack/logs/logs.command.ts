import { Command, Flag } from "effect/unstable/cli";
import { CAPABILITY_NAMES } from "@supabase/stack/effect";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackLogs } from "./logs.handler.ts";

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
  service: Flag.choice("service", CAPABILITY_NAMES).pipe(
    Flag.withDescription("Limit logs to one stack service."),
    Flag.optional,
  ),
  tail: Flag.integer("tail").pipe(
    Flag.filter(
      (value) => value >= 0 && value <= 10_000,
      (value) => `Expected --tail between 0 and 10000, got ${value}`,
    ),
    Flag.withDescription("Number of retained log entries to print."),
    Flag.withDefault(100),
  ),
  follow: Flag.boolean("follow").pipe(
    Flag.withDescription("Continue printing new log entries until interrupted."),
    Flag.withDefault(false),
  ),
} as const;

export const legacyExperimentalStackLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription("Read logs from a managed local Supabase stack."),
  Command.withShortDescription("Read managed local stack logs"),
  Command.withExamples([
    {
      command: "supabase experimental stack logs --service database --tail 50",
      description: "Print the latest database logs",
    },
    {
      command: "supabase experimental stack logs --follow --output-format stream-json",
      description: "Stream new stack logs as structured events",
    },
  ]),
  Command.withHandler((flags) =>
    legacyExperimentalStackLogs(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
