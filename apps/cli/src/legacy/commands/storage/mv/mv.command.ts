import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyStorageMv } from "./mv.handler.ts";

const config = {
  src: Argument.string("src").pipe(Argument.withDescription("Source path to move from.")),
  dst: Argument.string("dst").pipe(Argument.withDescription("Destination path to move to.")),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively move a directory."),
  ),
} as const;

export type LegacyStorageMvFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStorageMvCommand = Command.make("mv", config).pipe(
  Command.withDescription("Move objects from src to dst path."),
  Command.withShortDescription("Move objects from src to dst path"),
  Command.withExamples([
    {
      command: "supabase storage mv -r ss:///bucket/docs ss:///bucket/www/docs",
      description: "Recursively move a directory within storage",
    },
  ]),
  Command.withHandler((flags) => legacyStorageMv(flags)),
);
