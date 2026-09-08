import { Command } from "effect/unstable/cli";
import { dbDiffCommand } from "./diff/diff.command.ts";
import { dbDumpCommand } from "./dump/dump.command.ts";
import { dbPushCommand } from "./push/push.command.ts";
import { dbPullCommand } from "./pull/pull.command.ts";
import { dbResetCommand } from "./reset/reset.command.ts";
import { dbLintCommand } from "./lint/lint.command.ts";
import { dbStartCommand } from "./start/start.command.ts";
import { dbQueryCommand } from "./query/query.command.ts";
import { dbAdvisorsCommand } from "./advisors/advisors.command.ts";
import { dbTestCommand } from "./test/test.command.ts";
import { dbBranchCommand } from "./branch/branch.command.ts";
import { dbRemoteCommand } from "./remote/remote.command.ts";
import { dbSchemaCommand } from "./schema/schema.command.ts";

export const dbCommand = Command.make("db").pipe(
  Command.withDescription("Manage Postgres databases."),
  Command.withShortDescription("Manage databases"),
  Command.withSubcommands([
    dbDiffCommand,
    dbDumpCommand,
    dbPushCommand,
    dbPullCommand,
    dbResetCommand,
    dbLintCommand,
    dbStartCommand,
    dbQueryCommand,
    dbAdvisorsCommand,
    dbTestCommand.pipe(Command.unlisted),
    dbBranchCommand.pipe(Command.unlisted),
    dbRemoteCommand.pipe(Command.unlisted),
    dbSchemaCommand,
  ]),
);
