import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Driving the bundled Go binary's hidden `db __db-bootstrap` seam failed — the
 * container-lifecycle primitives that back native `db start` / `db reset --local`
 * (create/recreate the local Postgres container, apply the initial schema, the
 * storage health gate) are not yet ported to TypeScript. Wraps a failed inspect,
 * a missing `supabase-go` binary, or a non-zero seam exit. The seam tees its own
 * progress to stderr, so this message is the fallback shown when the subprocess
 * dies without surfacing a more specific Go error.
 */
export class LegacyDbBootstrapError extends Data.TaggedError("LegacyDbBootstrapError")<{
  readonly message: string;
  /**
   * Optional actionable hint rendered as a separate "Suggestion:" line, mirroring
   * Go's `utils.CmdSuggestion` — set to the Docker-install hint when the container
   * runtime's daemon is unreachable (`AssertServiceIsRunning`, `misc.go:148-154`).
   */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.suggestion !== undefined
      ? { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" }
      : { ...actionability.unknown, fingerprint_suffix: "seam" };
  }
}
