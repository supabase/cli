import { Command } from "effect/cli";
import { inspectDbCommand } from "./db/db.command.ts";
import { inspectReportCommand } from "./report/report.command.ts";

export const inspectCommand = Command.make("inspect").pipe(
  Command.withDescription(
    "Diagnose the health and performance of a project's Postgres database, or export every inspection result as CSV.",
  ),
  Command.withShortDescription("Inspect project tools"),
  Command.withSubcommands([inspectReportCommand, inspectDbCommand]),
);
