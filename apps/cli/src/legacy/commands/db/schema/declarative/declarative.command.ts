import { Command } from "effect/unstable/cli";
import { legacyDbSchemaDeclarativeSharedBase } from "./declarative.shared.ts";
import { legacyDbSchemaDeclarativeGenerateCommand } from "./generate/generate.command.ts";
import { legacyDbSchemaDeclarativeSyncCommand } from "./sync/sync.command.ts";

export const legacyDbSchemaDeclarativeCommand = legacyDbSchemaDeclarativeSharedBase.pipe(
  Command.withSubcommands([
    legacyDbSchemaDeclarativeSyncCommand,
    legacyDbSchemaDeclarativeGenerateCommand,
  ]),
);
