import { legacyAqua, legacyYellow } from "../../shared/legacy-colors.ts";

/**
 * Pure text formatters for `start`'s stderr progress/status lines. No Effect,
 * no I/O — each export returns the exact bytes to write, trailing newline(s)
 * included, so a caller can write the result straight to stderr
 * (`output.raw(..., "stderr")` or `process.stderr.write`) without
 * reassembling the spacing itself.
 */

/**
 * Printed when `start` finds the db container already running, before it
 * delegates entirely to `status`'s own rendering.
 */
export function legacyStartAlreadyRunningMessage(): string {
  return `${legacyAqua("supabase start")} is already running.\n`;
}

/**
 * Printed after Postgres itself has already started and health-checked,
 * immediately before the other 13 services begin creating.
 */
export const LEGACY_START_STARTING_CONTAINERS_MESSAGE = "Starting containers...\n";

/**
 * Printed once every non-Postgres container has been created and started,
 * immediately before the shared health-check polling loop begins.
 */
export const LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE = "Waiting for health checks...\n";

/**
 * Printed on success (or an ignored unhealthy-timeout), immediately before
 * the status table renders to stdout.
 */
export function legacyStartCompletedMessage(): string {
  return `Started ${legacyAqua("supabase")} local development setup.\n\n`;
}

/**
 * The security notice: 4 lines followed by a single trailing blank line.
 * Only the header is colored; the remaining 3 lines are plain text.
 */
export function legacyStartSecurityNotice(): string {
  return (
    `${legacyYellow("Local dev security notice")}\n` +
    "All services bind to 0.0.0.0 (network-accessible, not just localhost)\n" +
    "API keys and JWT secrets are shared defaults. Do not use in production\n" +
    "Studio, pgMeta (/pg/*), and analytics have no authentication\n" +
    "\n"
  );
}
