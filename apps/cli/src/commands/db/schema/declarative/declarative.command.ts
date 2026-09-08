import { Command } from "effect/unstable/cli";
import { dbSchemaDeclarativeSharedBase } from "./declarative.shared.ts";
import { dbSchemaDeclarativeGenerateCommand } from "./generate/generate.command.ts";
import { dbSchemaDeclarativeSyncCommand } from "./sync/sync.command.ts";

export const dbSchemaDeclarativeCommand = dbSchemaDeclarativeSharedBase.pipe(
  Command.withSubcommands([dbSchemaDeclarativeSyncCommand, dbSchemaDeclarativeGenerateCommand]),
);
