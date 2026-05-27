import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withHidden, withHiddenFromConfig } from "../../../../shared/cli/hidden-flag.ts";
import { legacyFunctionsDownload } from "./download.handler.ts";

const config = {
  functionName: Argument.string("Function name").pipe(
    Argument.withDescription("Name of the Function to download. Downloads all if omitted."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  useApi: Flag.boolean("use-api").pipe(
    Flag.withDescription("Unbundle functions server-side without using Docker."),
  ),
  useDocker: withHidden(
    Flag.boolean("use-docker").pipe(
      Flag.withDescription("Use Docker to unbundle functions locally."),
    ),
  ),
  legacyBundle: withHidden(
    Flag.boolean("legacy-bundle").pipe(Flag.withDescription("Use legacy bundling.")),
  ),
} as const;

export type LegacyFunctionsDownloadFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyFunctionsDownloadCommand = Command.make("download", config).pipe(
  Command.withDescription(
    "Download the source code for a Function from the linked Supabase project. If no function name is provided, downloads all functions.",
  ),
  Command.withShortDescription("Download a Function from Supabase"),
  withHiddenFromConfig(config),
  Command.withHandler((flags) => legacyFunctionsDownload(flags)),
);
