import { Command } from "effect/cli";
import { testDbCommand } from "./db/db.command.ts";
import { testNewCommand } from "./new/new.command.ts";

export const testCommand = Command.make("test").pipe(
  Command.withDescription(
    "Run pgTAP tests against your database and scaffold new test files in supabase/tests.",
  ),
  Command.withShortDescription("Run database tests"),
  Command.withSubcommands([testDbCommand, testNewCommand]),
);
