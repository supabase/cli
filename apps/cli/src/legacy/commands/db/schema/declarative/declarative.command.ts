import { Command } from "effect/unstable/cli";
import { legacyDbSchemaDeclarativeGenerateCommand } from "./generate/generate.command.ts";
import { legacyDbSchemaDeclarativeSyncCommand } from "./sync/sync.command.ts";

export const legacyDbSchemaDeclarativeCommand = Command.make("declarative").pipe(
  Command.withDescription("Manage declarative database schemas."),
  Command.withShortDescription("Manage declarative database schemas"),
  Command.withSubcommands([
    legacyDbSchemaDeclarativeSyncCommand,
    legacyDbSchemaDeclarativeGenerateCommand,
  ]),
);
