import { Command } from "effect/unstable/cli";
import { experimentsDisableCommand } from "./disable/disable.command.ts";
import { experimentsEnableCommand } from "./enable/enable.command.ts";

export const experimentsCommand = Command.make("experiments").pipe(
  Command.withDescription(
    "Manage this project's experimental feature opt-ins, recorded under [experimental] in supabase/config.toml.",
  ),
  Command.withShortDescription("Manage experiment opt-ins"),
  Command.withSubcommands([experimentsEnableCommand, experimentsDisableCommand]),
);
