import { Effect } from "effect";

import { withDbTarget } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import type { InspectConnectionFlags } from "./inspect-query.ts";

/**
 * The `inspect` persistent flag set, inherited by every `inspect db` subcommand. Shared
 * verbatim across all 25 commands so flag names and descriptions live in one place.
 */
export const INSPECT_DB_FLAGS = targetFlags({ subject: "database", dbUrl: true });

/** The Management API calls every `inspect db` subcommand makes, all through the database-config resolver. */
export const INSPECT_DB_PERMISSIONS = withDbTarget(dbConfig, { default: "local" });
/** Target policy shared by every `inspect db` command. */
export const withInspectDbTargetPolicy = withTargetPolicy({
  group: "selectable",
  consent: "none",
  consentExemptReason: "read-only",
});

/**
 * Wraps an `inspect db` handler with the standard command-level pipeline: telemetry
 * instrumentation with the three connection flags, and the machine-format JSON error envelope.
 */
export function inspectDbCommandHandler<E, R>(
  handler: (flags: InspectConnectionFlags) => Effect.Effect<void, E, R>,
) {
  return (flags: InspectConnectionFlags) =>
    handler(flags).pipe(
      withCommandTelemetry({
        flags: {
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
        },
        // `project-ref` stays redacted; it carries no telemetry-safety allowlist entry.
      }),
      withJsonErrorHandling,
    );
}
