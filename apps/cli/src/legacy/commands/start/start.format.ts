import { legacyAqua, legacyYellow } from "../../shared/legacy-colors.ts";

/**
 * Pure text formatters for `start`'s stderr progress/status lines. No Effect,
 * no I/O — each export returns the exact bytes Go writes via
 * `fmt.Fprintln`/`fmt.Fprintf`, trailing newline(s) included, so a caller can
 * write the result straight to stderr (`output.raw(..., "stderr")` or
 * `process.stderr.write`) without reassembling Go's spacing itself.
 */

/**
 * Go's `fmt.Fprintln(os.Stderr, utils.Aqua("supabase start")+" is already
 * running.")` (`apps/cli-go/internal/start/start.go:55`) — printed when
 * `AssertSupabaseDbIsRunning` finds the db container already present, before
 * `start` delegates entirely to `status`'s own rendering.
 */
export function legacyStartAlreadyRunningMessage(): string {
  return `${legacyAqua("supabase start")} is already running.\n`;
}

/**
 * Go's `fmt.Fprintln(os.Stderr, "Starting containers...")`
 * (`apps/cli-go/internal/start/start.go:300`) — printed after Postgres itself
 * has already started and health-checked, immediately before the other 13
 * services begin creating.
 */
export const LEGACY_START_STARTING_CONTAINERS_MESSAGE = "Starting containers...\n";

/**
 * Go's `fmt.Fprintln(os.Stderr, "Waiting for health checks...")`
 * (`apps/cli-go/internal/start/start.go:1270`) — printed once every
 * non-Postgres container has been created and started, immediately before the
 * shared health-check polling loop begins.
 */
export const LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE = "Waiting for health checks...\n";

/**
 * Go's `fmt.Fprintf(os.Stderr, "Started %s local development setup.\n\n",
 * utils.Aqua("supabase"))` (`apps/cli-go/internal/start/start.go:84`) —
 * printed on success (or an ignored unhealthy-timeout), immediately before the
 * status table renders to stdout.
 */
export function legacyStartCompletedMessage(): string {
  return `Started ${legacyAqua("supabase")} local development setup.\n\n`;
}

/**
 * Port of Go's `printSecurityNotice` (`apps/cli-go/internal/start/start.go:
 * 1503-1509`), byte-for-byte: 4 `fmt.Fprintln(os.Stderr, ...)` lines followed
 * by a bare `fmt.Fprintln(os.Stderr)` (a single trailing blank line). Only the
 * header is colored (Go's `utils.Yellow`); the remaining 3 lines are plain
 * text.
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
