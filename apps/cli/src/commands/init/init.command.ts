import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { cliConfigProviderLayer } from "../../shared/config/cli-config-provider.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { init } from "./init.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../shared/cli/cli-params.ts";

const config = {
  interactive: cliFlag("interactive", Flag.Boolean, {
    description: "Prompt to generate IDE settings for Deno.",
    alias: "i",
    default: false,
  }),
  useOrioledb: cliFlag("use-orioledb", Flag.Boolean, {
    description: "Use the OrioleDB storage engine for Postgres.",
    default: false,
  }),
  force: cliFlag("force", Flag.Boolean, {
    description: "Overwrite an existing supabase/config.toml.",
    default: false,
  }),
  withVscodeWorkspace: cliFlag("with-vscode-workspace", Flag.Boolean, {
    description: "Generate a VS Code workspace.",
    default: false,
    hidden: true,
  }),
  withVscodeSettings: cliFlag("with-vscode-settings", Flag.Boolean, {
    description: "Generate VS Code settings for Deno.",
    default: false,
    hidden: true,
  }),
  withIntellijSettings: cliFlag("with-intellij-settings", Flag.Boolean, {
    description: "Generate IntelliJ IDEA settings for Deno.",
    default: false,
    hidden: true,
  }),
} as const;

export type InitFlags = CliCommand.Command.Config.Infer<typeof config>;

export const initCommand = makeCommand("init", config).pipe(
  Command.withDescription("Create a `supabase/config.toml` in the current directory to set up local development."),
  Command.withShortDescription("Set up a project for local development"),
  withPermissions({
    operations: [],
    noApiEffectFlags: [
      "interactive",
      "use-orioledb",
      "force",
      "with-vscode-workspace",
      "with-vscode-settings",
      "with-intellij-settings",
    ],
  }),
  Command.withHandler((flags) =>
    init(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  // `stdinLayer` satisfies `promptYesNo`'s `Stdin` requirement (via the
  // shared `initProject` IDE prompts). The prompts are gated on a TTY stdin, so
  // init never actually reads a piped line at runtime — the layer is here for
  // the effect's type requirements only. `cliConfigProviderLayer` satisfies
  // experimental-stack env reads so ConfigProvider does not leak to the root.
  Command.provide(
    Layer.mergeAll(commandRuntimeLayer(["init"]), stdinLayer, cliConfigProviderLayer),
  ),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
