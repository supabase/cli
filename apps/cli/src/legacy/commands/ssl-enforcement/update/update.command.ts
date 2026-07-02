import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySslEnforcementUpdate } from "./update.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  enableDbSslEnforcement: Flag.boolean("enable-db-ssl-enforcement").pipe(
    Flag.withDescription(
      "Whether the DB should enable SSL enforcement for all external connections.",
    ),
  ),
  disableDbSslEnforcement: Flag.boolean("disable-db-ssl-enforcement").pipe(
    Flag.withDescription(
      "Whether the DB should disable SSL enforcement for all external connections.",
    ),
  ),
} as const;

export type LegacySslEnforcementUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySslEnforcementUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update SSL enforcement configuration."),
  Command.withShortDescription("Update SSL enforcement configuration"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Go gates `sslEnforcementCmd` behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `legacyManagementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `LegacyPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* legacyRequireExperimental;
      return yield* legacySslEnforcementUpdate(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(legacyManagementApiRuntimeLayer(["ssl-enforcement", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
