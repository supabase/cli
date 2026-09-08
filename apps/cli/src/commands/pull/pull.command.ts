import { Option } from "effect";
import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../config/legacy-project-ref.service.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { LEGACY_GLOBAL_OUTPUT_FORMATS } from "../../shared/legacy/global-flags.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyPull } from "./pull.handler.ts";
import { legacyPullRuntimeLayer } from "./pull.layers.ts";

const config = {
  // `config pull`'s settled vocabulary (CLI-2167): one flag that accepts
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
      "Name of the [remotes.*] block the config step writes into, overriding the block it would otherwise reuse or create.",
    ),
    Flag.optional,
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Show what would be pulled without writing or changing anything."),
    Flag.withDefault(false),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription(
      "Write even when supabase/config.toml (or config.json) has uncommitted changes in git.",
    ),
    Flag.withDefault(false),
  ),
  withMigrationHistory: Flag.boolean("with-migration-history").pipe(
    Flag.withDescription(
      "Fetch the remote migration history table into supabase/migrations, even when it already has files. Runs automatically when supabase/migrations is missing or empty.",
    ),
    Flag.withDefault(false),
  ),
} as const;

export type LegacyPullFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-implementing the `safeFlags`/telemetry wrapper inline.
export const legacyPullHandler = (flags: LegacyPullFlags) =>
  legacyPull(flags).pipe(
    // `--project-ref` accepts branch names here (CLI-2167 vocabulary), so its
    // value is only safe to log verbatim when it is actually ref-shaped — a
    // user-created branch name must never reach PostHog. Same guard as
    // `link`/`config diff`/`config pull`. `--remote-label` is a free-form,
    // user-chosen string and is NEVER safe to log verbatim (mirrors
    // `config pull`).
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

export const legacyPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Refreshes local project state from a linked Supabase project or branch in one step: pulls config into supabase/config.toml, optionally fetches the remote migration history table, pulls the database schema into supabase/migrations (also updating that database's migration history), and downloads every Edge Function's source. Prompts for confirmation before writing on an interactive TTY, unless --yes is set; --output-format json|stream-json skips the prompt entirely and takes its default answer, while a non-interactive text run still prints the prompt to stderr and reads one line from piped stdin (y/n honored, default otherwise) — use --dry-run to preview first.",
  ),
  Command.withShortDescription("Pull remote project state into the local checkout"),
  Command.withExamples([
    {
      command: "supabase pull",
      description: "Pull config, schema, and functions from the linked project",
    },
    {
      command: "supabase pull --project-ref staging",
      description: "Pull from the 'staging' branch of the linked project",
    },
    {
      command: "supabase pull --dry-run",
      description: "Preview what would be pulled without writing anything",
    },
  ]),
  Command.withHandler(legacyPullHandler),
  Command.provide(legacyPullRuntimeLayer),
);
