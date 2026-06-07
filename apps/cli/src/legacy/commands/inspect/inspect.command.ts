import { Command } from "effect/unstable/cli";
import { legacyInspectDbCommand } from "./db/db.command.ts";
import { legacyInspectReportCommand } from "./report/report.command.ts";

export const legacyInspectCommand = Command.make("inspect").pipe(
  Command.withDescription("Tools to inspect your Supabase project."),
  Command.withShortDescription("Inspect project tools"),
  Command.withSubcommands([legacyInspectReportCommand, legacyInspectDbCommand]),
);
