import { DEFAULT_MANAGED_STACK_NAME } from "@supabase/stack/effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import { logs } from "./logs.handler.ts";

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
  tail: Flag.integer("tail").pipe(
    Flag.filter(
      (tail) => tail >= 0,
      (tail) => `Expected --tail to be non-negative, got ${tail}`,
    ),
    Flag.withDescription(
      "Number of buffered log lines to print before following. Use 0 to skip history.",
    ),
    Flag.withDefault(100),
  ),
  service: Flag.string("service").pipe(
    Flag.atMost(4),
    Flag.withDescription(
      "Filter by service name. Repeat the flag for multiple services (for example: --service postgres --service auth)",
    ),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
  noFollow: Flag.boolean("no-follow").pipe(
    Flag.withDescription("Print buffered history only and exit without following live logs."),
  ),
} as const;

export type LogsFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const logsCommand = Command.make("logs", flags).pipe(
  Command.withDescription(
    "Print recent logs from the local Supabase stack and optionally continue following live output.\n\n" +
      "By default this prints the last 100 lines across all services, then keeps streaming new lines.\n\n" +
      "Use --service to focus on one or more services, --tail 0 to skip backlog, and --no-follow to print a bounded snapshot and exit.",
  ),
  Command.withShortDescription("Tail and follow local stack logs"),
  Command.withExamples([
    {
      command: "supabase logs",
      description: "Print recent logs across all services, then continue following live output",
    },
    {
      command: "supabase logs --service postgres --no-follow",
      description: "Print a recent Postgres-only snapshot and exit",
    },
    {
      command: "supabase logs --service postgres --service auth --tail 20",
      description: "Focus on a small recent backlog for two services, then follow live logs",
    },
  ]),
  Command.withHandler((flags) =>
    logs(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["logs"])),
);
