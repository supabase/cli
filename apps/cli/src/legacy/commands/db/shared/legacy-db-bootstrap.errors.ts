import { Data } from "effect";

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
}> {}
