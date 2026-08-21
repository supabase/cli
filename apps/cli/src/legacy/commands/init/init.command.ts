import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyInit } from "./init.handler.ts";

const config = {
  interactive: Flag.boolean("interactive").pipe(
    Flag.withDescription("Enables interactive mode to configure IDE settings."),
    Flag.withAlias("i"),
    Flag.withDefault(false),
  ),
  useOrioledb: Flag.boolean("use-orioledb").pipe(
    Flag.withDescription("Use OrioleDB storage engine for Postgres."),
    Flag.withDefault(false),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Overwrite existing supabase/config.toml."),
    Flag.withDefault(false),
  ),
  withVscodeWorkspace: Flag.boolean("with-vscode-workspace").pipe(
    Flag.withDescription("Generate VS Code workspace."),
    Flag.withHidden,
    Flag.withDefault(false),
  ),
  withVscodeSettings: Flag.boolean("with-vscode-settings").pipe(
    Flag.withDescription("Generate VS Code settings for Deno."),
    Flag.withHidden,
    Flag.withDefault(false),
  ),
  withIntellijSettings: Flag.boolean("with-intellij-settings").pipe(
    Flag.withDescription("Generate IntelliJ IDEA settings for Deno."),
    Flag.withHidden,
    Flag.withDefault(false),
  ),
} as const;

export type LegacyInitFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInitCommand = Command.make("init", config).pipe(
  Command.withDescription("Initialize a local project."),
  Command.withShortDescription("Initialize a local project"),
  Command.withHandler((flags) =>
    legacyInit(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  // `stdinLayer` satisfies `legacyPromptYesNo`'s `Stdin` requirement (via the
  // shared `initProject` IDE prompts). The prompts are gated on a TTY stdin, so
  // init never actually reads a piped line at runtime — the layer is here for
  // the effect's type requirements only.
  Command.provide(Layer.mergeAll(commandRuntimeLayer(["init"]), stdinLayer)),
);
