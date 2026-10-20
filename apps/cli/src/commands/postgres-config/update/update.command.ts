import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/remote-target.layer.ts";
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

/**
 * CSV-splits each occurrence into config overrides, failing at parse time with a
 * diagnostic on malformed CSV — before the --experimental gate runs.
 */
export const postgresConfigUpdateConfigFlag = stringSliceFlag(
  "config",
  "Config overrides specified as a 'key=value' pair",
);

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  config: postgresConfigUpdateConfigFlag,
  replaceExistingOverrides: Flag.Boolean("replace-existing-overrides").pipe(
    Flag.withDescription(
      "If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.",
    ),
    Flag.withDefault(false),
  ),
  noRestart: Flag.Boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after updating config."),
    Flag.withDefault(false),
  ),
} as const;

export type PostgresConfigUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const postgresConfigUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update Postgres database config."),
  Command.withShortDescription("Update Postgres database config"),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["config", "no-restart"] },
      withCondition(postgresConfigRead, { flag: "replace-existing-overrides", is: false }),
      postgresConfigWrite,
      projectRefPicker,
      linkedProjectCache,
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
);
