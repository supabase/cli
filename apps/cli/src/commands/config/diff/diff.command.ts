import type * as CliCommand from "effect/cli/Command";
import { Command, Flag } from "effect/cli";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { configDiff } from "./diff.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  exitCode: cliFlag("exit-code", Flag.Boolean, {
    description: "Exit with status 2 when any difference is found (errors keep exiting 1).",
    default: false,
  }),
} as const;

export type ConfigDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const configDiffHandler = (flags: ConfigDiffFlags) =>
  configDiff(flags).pipe(
    withCommandTelemetry({
      flags,
      // This command rejects every `-o/--output` value itself with a message pointing at
      // `--output-format`, so the wrapper must allow the full choice set through — otherwise its
      // own generic enum-check message would fire first and the handler would never run.
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const configDiffCommand = makeCommand("diff", config).pipe(
  Command.withDescription(
    "Compare `supabase/config.toml` with the configuration of a remote project or branch, to see what `config push` would change. Read-only: it never modifies local or remote configuration.",
  ),
  Command.withShortDescription("Diff local config against a project"),
  Command.withExamples([
    {
      command: "supabase config diff",
      description: "Diff against the linked project",
    },
    {
      command: "supabase config diff --exit-code --remote=staging",
      description: "Diff against the 'staging' branch, exiting 2 on drift",
    },
  ]),
  withPermissions(
    compose(
      branchResolution,
      projectRefPicker,
      {
        operations: [{ operationId: "v2-get-project-config", kind: "required" }],
        noApiEffectFlags: ["exit-code"],
      },
      linkedProjectCache,
    ),
  ),
  Command.withHandler(configDiffHandler),
  Command.provide(managementApiRuntimeLayer(["config", "diff"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
