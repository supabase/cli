import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { postgresConfigRead, postgresConfigWrite } from "../postgres-config.shared.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { postgresConfigUpdate } from "./update.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

/**
 * CSV-splits each occurrence into config overrides, failing at parse time with a
 * diagnostic on malformed CSV — before the --experimental gate runs.
 */
export const postgresConfigUpdateConfigFlag = stringSliceFlag(
  "config",
  "Config override as a `key=value` pair, comma-separated or repeated.",
);

const config = {
  ...projectTargetFlags(),
  config: postgresConfigUpdateConfigFlag,
  replaceExistingOverrides: cliFlag("replace-existing-overrides", Flag.Boolean, {
    description: "Replace all existing overrides with the ones provided instead of merging them.",
    default: false,
  }),
  noRestart: cliFlag("no-restart", Flag.Boolean, {
    description: "Do not restart the database after updating config.",
    default: false,
  }),
} as const;

export type PostgresConfigUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const postgresConfigUpdateCommand = makeCommand("update", config).pipe(
  Command.withDescription(
    "Sets Postgres setting overrides for your project. By default they merge with existing overrides, and the database restarts afterwards unless you pass `--no-restart`.",
  ),
  Command.withShortDescription("Update Postgres database config"),
  Command.withExamples([
    {
      command:
        "supabase postgres-config update --config work_mem=100MB --experimental --remote=<project-ref>",
      description: "Set a Postgres config override",
    },
    {
      command:
        "supabase postgres-config update --config work_mem=100MB --replace-existing-overrides --no-restart --experimental --remote=<project-ref>",
      description: "Replace all overrides without restarting",
    },
  ]),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["config", "no-restart"] },
      withCondition(postgresConfigRead, { flag: "replace-existing-overrides", is: false }),
      postgresConfigWrite,
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Validate the -o value before the --experimental gate, so an invalid value is
      // reported even without --experimental set.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // managementApiRuntimeLayer eagerly resolves an access token, so it's provided here
      // (after the gate) rather than via Command.provide, which would build it — and fail
      // on a missing token — before this generator's first yield* runs.
      yield* requireExperimental;
      return yield* postgresConfigUpdate(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["postgres-config", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
