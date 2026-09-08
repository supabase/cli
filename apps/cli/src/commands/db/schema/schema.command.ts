import { Command } from "effect/unstable/cli";
import { dbSchemaDeclarativeCommand } from "./declarative/declarative.command.ts";

export const dbSchemaCommand = Command.make("schema").pipe(
  Command.withDescription("Manage database schema."),
  Command.withShortDescription("Manage database schema"),
  Command.withSubcommands([dbSchemaDeclarativeCommand]),
);
