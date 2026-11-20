import { Command } from "effect/cli";
import { dbSchemaDeclarativeCommand } from "./declarative/declarative.command.ts";
import { STACK_SELECTOR_FLAGS } from "../../../command-internal/stack-target.ts";

export const dbSchemaCommand = Command.make("schema").pipe(
  Command.withDescription("Manage database schema."),
  Command.withShortDescription("Manage database schema"),
  Command.withSubcommands([dbSchemaDeclarativeCommand]),
  Command.withGlobalFlags(STACK_SELECTOR_FLAGS),
);
