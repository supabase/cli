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
import { postgresConfigDelete } from "./delete.handler.ts";

/**
 * CSV-splits each occurrence into config keys, failing at parse time with pflag's diagnostic
 * on malformed CSV — before the --experimental gate runs.
 */
export const postgresConfigDeleteConfigFlag = stringSliceFlag(
  "config",
  "Config keys to delete (comma-separated)",
);

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  config: postgresConfigDeleteConfigFlag,
  noRestart: Flag.Boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after deleting config."),
    Flag.withDefault(false),
  ),
} as const;

export type PostgresConfigDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const postgresConfigDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete specific Postgres database config overrides."),
  Command.withShortDescription("Delete Postgres database config overrides"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Validate the -o value before the --experimental gate, so an invalid value is
      // reported even without --experimental set.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // managementApiRuntimeLayer eagerly resolves an access token, so it's provided here
      // (after the gate) rather than via Command.provide, which would build it — and fail
      // on a missing token — before this generator's first yield* runs.
      yield* requireExperimental;
      return yield* postgresConfigDelete(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["postgres-config", "delete"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
