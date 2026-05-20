import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbSchemaDeclarativeSync } from "./sync.handler.ts";

const config = {
  noCache: Flag.boolean("no-cache").pipe(
    Flag.withDescription("Disable catalog cache and force fresh shadow database setup."),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves schema diff to a new migration file."),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the generated migration file."),
    Flag.optional,
  ),
  apply: Flag.boolean("apply").pipe(
    Flag.withDescription("Apply the generated migration to the local database without prompting."),
  ),
  noApply: Flag.boolean("no-apply").pipe(
    Flag.withDescription(
      "Generate the migration file without prompting or applying it to the local database.",
    ),
  ),
} as const;

export type LegacyDbSchemaDeclarativeSyncFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbSchemaDeclarativeSyncCommand = Command.make("sync", config).pipe(
  Command.withDescription("Generate a new migration from declarative schema."),
  Command.withShortDescription("Generate a new migration from declarative schema"),
  Command.withHandler((flags) => legacyDbSchemaDeclarativeSync(flags)),
);
