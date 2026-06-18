import { Context, type Effect } from "effect";

interface RandomShape {
  /**
   * Return `bytes` cryptographically-random bytes, hex-encoded (lowercase). Used
   * by `db query`'s agent-mode envelope boundary (Go's `crypto/rand` +
   * `hex.EncodeToString`, `internal/db/query/query.go`). Injectable so tests can
   * pin a deterministic boundary.
   */
  readonly randomHex: (bytes: number) => Effect.Effect<string>;
}

export class Random extends Context.Service<Random, RandomShape>()("supabase/runtime/Random") {}
