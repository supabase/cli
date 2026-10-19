import { Option } from "effect";
import type * as CliCommand from "effect/cli/Command";
import { Command, Flag } from "effect/cli";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../command-internal/command-permissions/model.ts";
import { configPullRun } from "../../command-internal/config-pull-run.ts";
import {
  dbConfigLinked,
  dbConfigPoolerFallbackLinked,
} from "../../command-internal/db-config.layer.ts";
import { configTarget } from "../../command-internal/project-target.ts";
import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { functionsDownload } from "../../shared/functions/download.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../command-internal/global-flags.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { pull } from "./pull.handler.ts";
import { pullRuntimeLayer } from "./pull.layers.ts";
import { cliConfigValuesLayer } from "../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../command-internal/target/target-flags.ts";

const config = {
  ...projectTargetFlags(),
  remoteLabel: Flag.String("remote-label").pipe(
    Flag.withDescription(
      "Name of the [remotes.*] block the config step writes into, overriding the block it would otherwise reuse or create.",
    ),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show what would be pulled without writing or changing anything."),
    Flag.withDefault(false),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription(
      "Write even when supabase/config.toml (or config.json), supabase/migrations, or supabase/functions has uncommitted or untracked changes in git.",
    ),
    Flag.withDefault(false),
  ),
  withMigrationHistory: Flag.Boolean("with-migration-history").pipe(
    Flag.withDescription(
      "Fetch the remote migration history table into supabase/migrations, even when it already has files. Runs automatically when supabase/migrations is missing or empty.",
    ),
    Flag.withDefault(false),
  ),
} as const;

// `--dry-run` returns after the target and config reads, so the database and function steps run
// only without it.
const stepsRun = { flag: "dry-run", is: false } as const;

export type PullFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-implementing the `safeFlags`/telemetry wrapper inline.
export const pullHandler = (flags: PullFlags) =>
  pull(flags).pipe(
    // `--project-ref` can carry a branch name, so its value is only safe to log verbatim when it's
    // actually ref-shaped — a user-created branch name must never reach PostHog.
    // `--remote-label` is a free-form, user-chosen string and is never safe to log verbatim.
    withCommandTelemetry({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
      // The handler rejects every `-o`/`--output` value with a message pointing at
      // `--output-format`, so the full global choice set is declared "allowed" here.
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const pullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Refreshes local project state from a linked Supabase project or branch in one step: pulls config into supabase/config.toml, optionally fetches the remote migration history table, pulls the database schema into supabase/migrations (also updating that database's migration history), and downloads every Edge Function's source. Asks for confirmation (default No) before writing, because the database step records the migration in the remote migration history table: an interactive terminal is prompted, and --output-format json|stream-json or a non-interactive run needs --yes (or SUPABASE_YES in the shell environment) — use --dry-run to preview first.",
  ),
  Command.withShortDescription("Pull remote project state into the local checkout"),
  Command.withExamples([
    {
      command: "supabase pull",
      description: "Pull config, schema, and functions from the linked project",
    },
    {
      command: "supabase pull --remote=staging",
      description: "Pull from the 'staging' branch of the linked project",
    },
    {
      command: "supabase pull --dry-run",
      description: "Preview what would be pulled without writing anything",
    },
  ]),
  withPermissions(
    compose(
      configTarget,
      configPullRun,
      linkedProjectCache,
      {
        operations: [
          {
            operationId: "v1-get-pooler-config",
            kind: "required",
            when: [stepsRun],
            context:
              "the direct database host is unreachable (IPv4-only network) and there is no usable saved supabase/.temp/pooler-url; the database steps get the resolved ref, so this needs no --remote",
          },
        ],
        noApiEffectFlags: ["remote-label", "force", "with-migration-history"],
      },
      withCondition(dbConfigLinked, stepsRun),
      withCondition(dbConfigPoolerFallbackLinked, stepsRun),
      withCondition(functionsDownload, stepsRun),
    ),
  ),
  Command.withHandler(pullHandler),
  Command.provide(pullRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
