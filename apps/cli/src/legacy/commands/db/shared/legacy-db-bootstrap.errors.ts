import { Data } from "effect";

/**
 * Driving the bundled Go binary's hidden `db __db-bootstrap` seam failed — the
 * container-lifecycle primitives that back native `db reset --local` (recreate the
 * local Postgres container, apply the initial schema, the storage health gate) are
 * not yet ported to TypeScript. Wraps a missing `supabase-go` binary or a non-zero
 * seam exit. The seam tees its own progress to stderr, so this message is the
 * fallback shown when the subprocess dies without surfacing a more specific Go
 * error. `db start` no longer composes this seam at all (CLI-1954): its own
 * already-running check is {@link LegacyLocalDbRunningError} from
 * `legacy/shared/db-bootstrap/local-db-running.ts`.
 */
export class LegacyDbBootstrapError extends Data.TaggedError("LegacyDbBootstrapError")<{
  readonly message: string;
  /**
   * Optional actionable hint rendered as a separate "Suggestion:" line, mirroring
   * Go's `utils.CmdSuggestion` — set to the Docker-install hint when the container
   * runtime's daemon is unreachable (`AssertServiceIsRunning`, `misc.go:148-154`).
   */
  readonly suggestion?: string;
}> {}
