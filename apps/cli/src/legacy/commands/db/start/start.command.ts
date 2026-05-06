import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbStart } from "./start.handler.ts";

const config = {
  fromBackup: Flag.string("from-backup").pipe(
    Flag.withDescription("Path to a logical backup file."),
    Flag.optional,
  ),
} as const;

export type LegacyDbStartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbStartCommand = Command.make("start", config).pipe(
  Command.withDescription("Starts local Postgres database."),
  Command.withShortDescription("Starts local Postgres database"),
  Command.withHandler((flags) => legacyDbStart(flags)),
);
