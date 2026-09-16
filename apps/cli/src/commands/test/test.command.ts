import { Command } from "effect/unstable/cli";
import { testDbCommand } from "./db/db.command.ts";
import { testNewCommand } from "./new/new.command.ts";

export const testCommand = Command.make("test").pipe(
  Command.withDescription("Run tests on local Supabase containers."),
  Command.withShortDescription("Run tests on local Supabase containers"),
  Command.withSubcommands([testDbCommand, testNewCommand]),
);
