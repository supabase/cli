import { Command } from "effect/unstable/cli";
import { legacyDbDiffCommand } from "./diff/diff.command.ts";
import { legacyDbDumpCommand } from "./dump/dump.command.ts";
import { legacyDbPushCommand } from "./push/push.command.ts";
import { legacyDbPullCommand } from "./pull/pull.command.ts";
import { legacyDbResetCommand } from "./reset/reset.command.ts";
import { legacyDbLintCommand } from "./lint/lint.command.ts";
import { legacyDbStartCommand } from "./start/start.command.ts";
import { legacyDbQueryCommand } from "./query/query.command.ts";
import { legacyDbAdvisorsCommand } from "./advisors/advisors.command.ts";
import { legacyDbTestCommand } from "./test/test.command.ts";
import { legacyDbBranchCommand } from "./branch/branch.command.ts";
import { legacyDbRemoteCommand } from "./remote/remote.command.ts";

export const legacyDbCommand = Command.make("db").pipe(
  Command.withDescription("Manage Postgres databases."),
  Command.withShortDescription("Manage databases"),
  Command.withSubcommands([
    legacyDbDiffCommand,
    legacyDbDumpCommand,
    legacyDbPushCommand,
    legacyDbPullCommand,
    legacyDbResetCommand,
    legacyDbLintCommand,
    legacyDbStartCommand,
    legacyDbQueryCommand,
    legacyDbAdvisorsCommand,
    legacyDbTestCommand,
    legacyDbBranchCommand,
    legacyDbRemoteCommand,
  ]),
);
