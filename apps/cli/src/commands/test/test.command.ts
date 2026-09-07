import { Command } from "effect/unstable/cli";
import { legacyTestDbCommand } from "./db/db.command.ts";
import { legacyTestNewCommand } from "./new/new.command.ts";

export const legacyTestCommand = Command.make("test").pipe(
  Command.withDescription("Run tests on local Supabase containers."),
  Command.withShortDescription("Run tests on local Supabase containers"),
  Command.withSubcommands([legacyTestDbCommand, legacyTestNewCommand]),
);
