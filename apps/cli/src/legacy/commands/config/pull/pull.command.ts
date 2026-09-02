import { Option } from "effect";
import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../../config/legacy-project-ref.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { LEGACY_GLOBAL_OUTPUT_FORMATS } from "../../../../shared/legacy/global-flags.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyConfigPull } from "./pull.handler.ts";

const config = {
  // `config diff`'s settled vocabulary (CLI-2167): one flag that accepts
  // either a project ref or a branch of the linked project — no separate
  // `--target`.
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
    // Without an explicit default a boolean flag is REQUIRED by the parser
    // (same rule pinned by `diff.e2e.test.ts` for `--exit-code`).
    Flag.withDefault(false),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Write even when supabase/config.toml has uncommitted changes in git."),
    Flag.withDefault(false),
  ),
} as const;

export type LegacyConfigPullFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring
// `Command.withHandler` uses below (same precedent as `legacyConfigDiffHandler`).
export const legacyConfigPullHandler = (flags: LegacyConfigPullFlags) =>
  legacyConfigPull(flags).pipe(
    // `--project-ref` accepts branch names here (CLI-2167 vocabulary), so its
    // value is only safe to log verbatim when it is actually ref-shaped — a
    // user-created branch name must never reach PostHog. Same guard as
    // `link`/`config diff`. `--remote-label` is a free-form, user-chosen
    // string and is NEVER safe to log verbatim.
    withLegacyCommandInstrumentation({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
      // Net-new TS command, no Go parity contract (CLI-2156): the handler
      // itself rejects every `-o/--output` value with a message pointing at
      // `--output-format`, so the full global choice set — single-sourced
      // from the flag's own definition — is declared "allowed" here.
      outputFormats: LEGACY_GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const legacyConfigPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Writes configuration from a remote project or branch into supabase/config.toml. Prompts for confirmation before writing on an interactive TTY, unless --yes is set; a non-interactive run (no TTY, or --output-format json|stream-json) never prompts and proceeds as if confirmed — use --dry-run to preview first.",
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
  Command.withHandler(legacyConfigPullHandler),
  Command.provide(legacyManagementApiRuntimeLayer(["config", "pull"])),
);
