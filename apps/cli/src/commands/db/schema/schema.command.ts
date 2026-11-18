import { Command } from "effect/cli";
import { dbSchemaDeclarativeCommand } from "./declarative/declarative.command.ts";

export const dbSchemaCommand = Command.make("schema").pipe(
  Command.withDescription(
    "Work with your database schema as declarative SQL files instead of hand-written migrations.",
  ),
  Command.withShortDescription("Manage database schema"),
  Command.withSubcommands([dbSchemaDeclarativeCommand]),
);
