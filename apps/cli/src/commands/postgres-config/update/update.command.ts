import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/go-output-flag.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { postgresConfigUpdate } from "./update.handler.ts";

/**
 * CSV-splits each occurrence into config overrides, failing at parse time with pflag's
 * diagnostic on malformed CSV — before the --experimental gate runs.
 */
export const postgresConfigUpdateConfigFlag = stringSliceFlag(
  "config",
  "Config overrides specified as a 'key=value' pair",
);

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  config: postgresConfigUpdateConfigFlag,
  replaceExistingOverrides: Flag.boolean("replace-existing-overrides").pipe(
    Flag.withDescription(
      "If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.",
    ),
    Flag.withDefault(false),
  ),
  noRestart: Flag.boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after updating config."),
    Flag.withDefault(false),
  ),
} as const;

export type PostgresConfigUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const postgresConfigUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update Postgres database config."),
  Command.withShortDescription("Update Postgres database config"),
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
