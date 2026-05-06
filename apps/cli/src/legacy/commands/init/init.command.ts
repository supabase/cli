import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInit } from "./init.handler.ts";

const config = {
  interactive: Flag.boolean("interactive").pipe(
    Flag.withDescription("Enables interactive mode to configure IDE settings."),
    Flag.withAlias("i"),
  ),
  useOrioledb: Flag.boolean("use-orioledb").pipe(
    Flag.withDescription("Use OrioleDB storage engine for Postgres."),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Overwrite existing supabase/config.toml."),
  ),
  withVscodeWorkspace: Flag.boolean("with-vscode-workspace").pipe(
    Flag.withDescription("Generate VS Code workspace."),
  ),
  withVscodeSettings: Flag.boolean("with-vscode-settings").pipe(
    Flag.withDescription("Generate VS Code settings for Deno."),
  ),
  withIntellijSettings: Flag.boolean("with-intellij-settings").pipe(
    Flag.withDescription("Generate IntelliJ IDEA settings for Deno."),
  ),
} as const;

export type LegacyInitFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInitCommand = Command.make("init", config).pipe(
  Command.withDescription("Initialize a local project."),
  Command.withShortDescription("Initialize a local project"),
  Command.withHandler((flags) => legacyInit(flags)),
);
