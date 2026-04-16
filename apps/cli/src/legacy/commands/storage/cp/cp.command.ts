import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyStorageCp } from "./cp.handler.ts";

const config = {
  src: Argument.string("src").pipe(Argument.withDescription("Source path to copy from.")),
  dst: Argument.string("dst").pipe(Argument.withDescription("Destination path to copy to.")),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively copy a directory."),
  ),
  cacheControl: Flag.string("cache-control").pipe(
    Flag.withDescription("Custom Cache-Control header for HTTP upload."),
    Flag.optional,
  ),
  contentType: Flag.string("content-type").pipe(
    Flag.withDescription("Custom Content-Type header for HTTP upload."),
    Flag.optional,
  ),
} as const;

export type LegacyStorageCpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStorageCpCommand = Command.make("cp", config).pipe(
  Command.withDescription("Copy objects from src to dst path."),
  Command.withShortDescription("Copy objects from src to dst path"),
  Command.withExamples([
    {
      command: "supabase storage cp readme.md ss:///bucket/readme.md",
      description: "Upload a local file to storage",
    },
    {
      command: "supabase storage cp -r docs ss:///bucket/docs",
      description: "Upload a directory recursively to storage",
    },
    {
      command: "supabase storage cp -r ss:///bucket/docs .",
      description: "Download a directory from storage",
    },
  ]),
  Command.withHandler((flags) => legacyStorageCp(flags)),
);
