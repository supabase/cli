import { Command } from "effect/unstable/cli";
import { legacyDbSchemaDeclarativeCommand } from "./declarative/declarative.command.ts";

export const legacyDbSchemaCommand = Command.make("schema").pipe(
  Command.withDescription("Manage database schema."),
  Command.withShortDescription("Manage database schema"),
  Command.withSubcommands([legacyDbSchemaDeclarativeCommand]),
);
