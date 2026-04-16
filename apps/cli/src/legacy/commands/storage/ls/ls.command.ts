import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyStorageLs } from "./ls.handler.ts";

const config = {
  path: Argument.string("path").pipe(
    Argument.withDescription("Storage path to list (e.g. ss:///bucket/docs)."),
    Argument.optional,
  ),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively list a directory."),
  ),
} as const;

export type LegacyStorageLsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStorageLsCommand = Command.make("ls", config).pipe(
  Command.withDescription("List objects by path prefix."),
  Command.withShortDescription("List objects by path prefix"),
  Command.withExamples([
    {
      command: "supabase storage ls ss:///bucket/docs",
      description: "List objects at a storage path",
    },
  ]),
  Command.withHandler((flags) => legacyStorageLs(flags)),
);
