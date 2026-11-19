import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { testDbCommand } from "./db/db.command.ts";
import { testNewCommand } from "./new/new.command.ts";

export const testCommand = Command.make("test").pipe(
  withSidebar({ category: "testing", title: "Run tests" }),
  Command.withDescription("Run tests on local Supabase containers."),
  Command.withShortDescription("Run tests on local Supabase containers"),
  Command.withSubcommands([testDbCommand, testNewCommand]),
);
