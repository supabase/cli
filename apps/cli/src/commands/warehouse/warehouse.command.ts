import { Command } from "effect/cli";
import { warehouseEnableCommand } from "./enable/enable.command.ts";

export const warehouseCommand = Command.make("warehouse").pipe(
  Command.withDescription("Manage Supabase Warehouse replication."),
  Command.withSubcommands([warehouseEnableCommand]),
);
