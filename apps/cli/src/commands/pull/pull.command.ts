import type * as CliCommand from "effect/cli/Command";
import { Command, Flag } from "effect/cli";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../command-internal/command-permissions/model.ts";
import { configPullRun } from "../../command-internal/config-pull-run.ts";
import {
  dbConfigLinked,
  dbConfigPoolerFallbackLinked,
} from "../../command-internal/db-config.layer.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
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
import { cliFlag, makeCommand } from "../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  remoteLabel: cliFlag("remote-label", Flag.String, {
    description: "Name of the [remotes.*] block the config step writes into.",
    optional: true,
  }),
  dryRun: cliFlag("dry-run", Flag.Boolean, {
    description: "Show what would be pulled without writing or changing anything.",
    default: false,
  }),
  force: cliFlag("force", Flag.Boolean, {
    description:
      "Write even when the project config file, supabase/migrations, or supabase/functions has uncommitted or untracked changes in git.",
    default: false,
  }),
  withMigrationHistory: cliFlag("with-migration-history", Flag.Boolean, {
    description:
      "Fetch the remote migration history into supabase/migrations even when it already has files.",
    default: false,
  }),
} as const;

// `--dry-run` returns after the target and config reads, so the database and function steps run
// only without it.
const stepsRun = { flag: "dry-run", is: false } as const;

export type PullFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-implementing the `safeFlags`/telemetry wrapper inline.
export const pullHandler = (flags: PullFlags) =>
  pull(flags).pipe(
    // `--remote-label` is a free-form, user-chosen string and is never safe to log verbatim.
    withCommandTelemetry({
      flags,
      // The handler rejects every `-o`/`--output` value with a message pointing at
      // `--output-format`, so the full global choice set is declared "allowed" here.
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const pullCommand = makeCommand("pull", config).pipe(
  Command.withDescription(
    "Refresh your local project from a linked Supabase project or branch in one step. " +
      "It pulls the config, the database schema, and every Edge Function's source, and fetches the remote migration history on a fresh checkout.\n\n" +
      "The database step also updates the migration history table on the remote project, so the command asks for confirmation (default No) before writing. " +
      "Pass --yes, or run with --dry-run to preview first.",
  ),
  Command.withShortDescription("Pull remote project state locally"),
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
      branchResolution,
      projectRefPicker,
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
