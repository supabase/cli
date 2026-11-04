import { Layer } from "effect";
import type * as CliCommand from "effect/cli/Command";
import { Command, Flag } from "effect/cli";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { configPullRun } from "../../../command-internal/config-pull-run.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { configPull } from "./pull.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  remoteLabel: cliFlag("remote-label", Flag.String, {
    description:
      "Name of the `[remotes.*]` block to write into, overriding the block that would otherwise be reused or created.",
    optional: true,
  }),
  dryRun: cliFlag("dry-run", Flag.Boolean, {
    description: "Show what would be written without touching the config file.",
    default: false,
  }),
  force: cliFlag("force", Flag.Boolean, {
    description: "Write even when `supabase/config.toml` has uncommitted changes in git.",
    default: false,
  }),
} as const;

export type ConfigPullFlags = CliCommand.Command.Config.Infer<typeof config>;

const configPullHandler = (flags: ConfigPullFlags) =>
  configPull(flags).pipe(
    // --remote-label is free-form user text and is never safe to log.
    withCommandTelemetry({
      flags,
      // The handler rejects every -o/--output value itself, so the full global choice set is
      // declared "allowed" here rather than gated by this wrapper.
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const configPullCommand = makeCommand("pull", config).pipe(
  Command.withDescription(
    "Write the configuration of a remote project or branch into `supabase/config.toml`, so the file reflects what is deployed. Use `--dry-run` to preview first.\n\nOn an interactive terminal it asks for confirmation before writing, unless you pass `--yes`.",
  ),
  Command.withShortDescription("Pull remote config into config.toml"),
  Command.withExamples([
    {
      command: "supabase config pull",
      description: "Pull from the linked project into the config root",
    },
    {
      command: "supabase config pull --remote=staging",
      description: "Pull from the 'staging' branch into [remotes.staging]",
    },
    {
      command: "supabase config pull --dry-run",
      description: "Preview the changes without writing the config file",
    },
  ]),
  withPermissions(
    compose(
      branchResolution,
      projectRefPicker,
      configPullRun,
      { operations: [], noApiEffectFlags: ["remote-label", "dry-run", "force"] },
      linkedProjectCache,
    ),
  ),
  Command.withHandler(configPullHandler),
  // `stdinLayer`: the apply confirmation reads piped stdin via `promptYesNo`
  // on a non-TTY stdin.
  Command.provide(Layer.mergeAll(managementApiRuntimeLayer(["config", "pull"]), stdinLayer)),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
