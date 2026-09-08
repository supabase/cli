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

// Go declares `--config` with pflag's `StringSliceVar` (`cmd/postgres.go:64`);
// malformed CSV fails at parse time with pflag's exact diagnostic (CLI-2005,
// see `stringSliceFlag`) — before the `--experimental` gate, matching
// cobra's ParseFlags-before-PersistentPreRunE ordering.
export const postgresConfigDeleteConfigFlag = stringSliceFlag(
  "config",
  "Config keys to delete (comma-separated)",
);

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  config: postgresConfigDeleteConfigFlag,
  noRestart: Flag.boolean("no-restart").pipe(
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
      // Cobra parses flags — rejecting an out-of-enum `-o` (`internal/utils/enum.go:21-27`)
      // — before `PersistentPreRunE` ever runs (`cobra@v1.10.2/command.go:919,985`), so an
      // invalid `-o` value must win over a missing `--experimental` flag.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // Go gates `postgresCmd` behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `managementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `CommandPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* requireExperimental;
      return yield* postgresConfigDelete(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["postgres-config", "delete"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
