import { Effect } from "effect";

import { compose } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import type { InspectConnectionFlags } from "./inspect-query.ts";

/** The persistent flag set every `inspect db` subcommand inherits. */
export const INSPECT_DB_FLAGS = targetFlags({ subject: "database", dbUrl: true });

/** The Management API calls every `inspect db` subcommand makes, all through the database-config resolver. */
export const INSPECT_DB_PERMISSIONS = compose(dbConfig, branchResolution);
/** Target policy shared by every `inspect db` command. */
export const withInspectDbTargetPolicy = withTargetPolicy({
  group: "selectable",
  consent: "none",
  consentExemptReason: "read-only",
});

/** Wraps an `inspect db` handler with telemetry and the machine-format JSON error envelope. */
export function inspectDbCommandHandler<E, R>(
  handler: (flags: InspectConnectionFlags) => Effect.Effect<void, E, R>,
) {
  return (flags: InspectConnectionFlags) =>
    handler(flags).pipe(withCommandTelemetry(), withJsonErrorHandling);
}
