import { Layer, Option } from "effect";
import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../../config/project-ref.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { configPull } from "./pull.handler.ts";

const config = {
  // Accepts either a project ref or a branch name/UUID of the linked project; there's no
  // separate --target flag.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name (or UUID) of one of its branches. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Flag.optional,
  ),
  remoteLabel: Flag.string("remote-label").pipe(
    Flag.withDescription(
      "Name of the [remotes.*] block to write into, overriding the block config pull would otherwise reuse or create.",
    ),
    Flag.optional,
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Show what would be written without touching the config file."),
    // Without an explicit default, a boolean flag is required by the parser.
    Flag.withDefault(false),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Write even when supabase/config.toml has uncommitted changes in git."),
    Flag.withDefault(false),
  ),
} as const;

export type ConfigPullFlags = CliCommand.Command.Config.Infer<typeof config>;

const configPullHandler = (flags: ConfigPullFlags) =>
  configPull(flags).pipe(
    // --project-ref accepts branch names too, so it's only safe to log verbatim when
    // ref-shaped; a branch name must never reach PostHog. --remote-label is free-form user text
    // and is never safe to log.
    withCommandTelemetry({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
      // The handler rejects every -o/--output value itself, so the full global choice set is
      // declared "allowed" here rather than gated by this wrapper.
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const configPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Writes configuration from a remote project or branch into supabase/config.toml. Prompts for confirmation before writing on an interactive TTY, unless --yes is set; --output-format json|stream-json skips the prompt entirely and takes its default answer, while a non-interactive text run still prints the prompt to stderr and reads one line from piped stdin (y/n honored, default otherwise) — use --dry-run to preview first.",
  ),
  Command.withShortDescription("Pull remote config into supabase/config.toml"),
  Command.withExamples([
    {
      command: "supabase config pull",
      description: "Pull from the linked project into the config root",
    },
    {
      command: "supabase config pull --project-ref staging",
      description: "Pull from the 'staging' branch into [remotes.staging]",
    },
    {
      command: "supabase config pull --dry-run",
      description: "Preview the changes without writing the config file",
    },
  ]),
  Command.withHandler(configPullHandler),
  Command.provide(Layer.mergeAll(managementApiRuntimeLayer(["config", "pull"]), stdinLayer)),
);
