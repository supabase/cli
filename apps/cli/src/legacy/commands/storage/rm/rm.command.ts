import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacyStorageRm } from "./rm.handler.ts";

const config = {
  files: Argument.string("file").pipe(
    Argument.withDescription("File paths to remove."),
    Argument.variadic(),
  ),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively remove a directory."),
  ),
} as const;

export const legacyStorageRmCommand = Command.make("rm", config).pipe(
  Command.withDescription("Remove objects by file path."),
  Command.withShortDescription("Remove objects by file path"),
  Command.withExamples([
    {
      command: "supabase storage rm -r ss:///bucket/docs",
      description: "Recursively remove a directory from storage",
    },
    {
      command: "supabase storage rm ss:///bucket/docs/example.md ss:///bucket/readme.md",
      description: "Remove multiple files from storage",
    },
  ]),
  Command.withHandler((flags) =>
    legacyStorageRm({
      files: flags.files.map(String),
      recursive: flags.recursive,
    }),
  ),
);
