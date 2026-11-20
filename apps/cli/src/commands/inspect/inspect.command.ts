import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { inspectDbCommand } from "./db/db.command.ts";
import { inspectReportCommand } from "./report/report.command.ts";
import { STACK_SELECTOR_FLAGS } from "../../command-internal/stack-target.ts";

export const inspectCommand = Command.make("inspect").pipe(
  withSidebar({ category: "inspect" }),
  Command.withDescription("Tools to inspect your Supabase project."),
  Command.withShortDescription("Inspect project tools"),
  Command.withSubcommands([inspectReportCommand, inspectDbCommand]),
  Command.withGlobalFlags(STACK_SELECTOR_FLAGS),
);
