import { Effect } from "effect";
import { Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import type { LegacyInspectConnectionFlags } from "./legacy-inspect-query.ts";

/**
 * The `inspect` persistent flag set, inherited by every `inspect db` subcommand
 * (`apps/cli-go/cmd/inspect.go:259-263`). Shared verbatim across all 25 commands
 * so the flag names and descriptions live in one place. `Command.make` reads this
 * immutable descriptor without mutating it, so a single instance is safe to reuse.
 */
export const LEGACY_INSPECT_DB_FLAGS = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
} as const;

/**
 * Wraps an `inspect db` handler with the standard command-level pipeline: legacy
 * telemetry instrumentation (the Go-shape `cli_command_executed` event, with the
 * three connection flags) and the machine-format JSON error envelope. Shared by
 * all 25 command files so the wiring is defined once.
 */
export function legacyInspectDbCommandHandler<E, R>(
  handler: (flags: LegacyInspectConnectionFlags) => Effect.Effect<void, E, R>,
) {
  return (flags: LegacyInspectConnectionFlags) =>
    handler(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: { "db-url": flags.dbUrl, linked: flags.linked, local: flags.local },
      }),
      withJsonErrorHandling,
    );
}
