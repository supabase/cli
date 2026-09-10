import { Effect } from "effect";
import { Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import type { InspectConnectionFlags } from "./inspect-query.ts";

/**
 * The `inspect` persistent flag set, inherited by every `inspect db` subcommand.
 * Shared verbatim across all 26 commands
 * so the flag names and descriptions live in one place. `Command.make` reads this
 * immutable descriptor without mutating it, so a single instance is safe to reuse.
 */
export const INSPECT_DB_FLAGS = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Inspect the linked project."),
    Flag.withDefault(false),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Inspect the local database."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

/**
 * Wraps an `inspect db` handler with the standard command-level pipeline: legacy
 * telemetry instrumentation (the Go-shape `cli_command_executed` event, with the
 * three connection flags) and the machine-format JSON error envelope. Shared by
 * all 26 command files so the wiring is defined once.
 */
export function inspectDbCommandHandler<E, R>(
  handler: (flags: InspectConnectionFlags) => Effect.Effect<void, E, R>,
) {
  return (flags: InspectConnectionFlags) =>
    handler(flags).pipe(
      withCommandTelemetry({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
        },
        // TS-only flag with no Go telemetry-safety baseline; Go's nearest
        // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
        // others) are unmarked, so it stays redacted.
      }),
      withJsonErrorHandling,
    );
}
